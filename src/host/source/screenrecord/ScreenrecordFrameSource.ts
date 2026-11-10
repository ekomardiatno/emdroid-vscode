import type { ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';

import { AnnexBDemuxer } from '../../../common/h264/annexb.js';
import { parseSps } from '../../../common/h264/sps.js';
import type { AdbClient } from '../../adb/AdbClient.js';
import { DisplayWatcher, type DisplayGeometry } from '../../adb/DisplayWatcher.js';
import { PersistentShell } from '../../adb/PersistentShell.js';
import { classifyAdbError } from '../../adb/parse.js';
import type { ScopedLogger } from '../../log.js';
import type { AccessUnit, FrameSource, SourceFailure, VideoFormat } from '../FrameSource.js';

/**
 * Measured: the first bytes arrive 549-628 ms after spawn. Five seconds of
 * silence therefore means the encoder never started -- usually an orphaned
 * recorder still holding it -- and the stderr we captured is the only clue.
 */
const FIRST_BYTE_TIMEOUT_MS = 5000;

/**
 * A restart costs the full spawn latency, so key-frame requests are coalesced.
 * The webview asks on every attach and after every decoder error, which during
 * a reconnect storm would otherwise be a restart loop.
 */
const KEYFRAME_MIN_INTERVAL_MS = 3000;

/** Backoff for an unexpected exit; the last value repeats. */
const RESTART_BACKOFF_MS = [400, 1000, 2500, 6000];

/** `--time-limit 0` is only unlimited from this SDK on. */
const UNLIMITED_TIME_LIMIT_SDK = 30;

/** Pre-SDK-30 cap, in seconds. We restart just before it fires. */
const TIME_LIMIT_SECONDS = 180;

export interface ScreenrecordOptions {
  readonly maxWidth: number;
  readonly bitRate: string;
  readonly sdkInt: number;
}

/**
 * Captures H.264 from the device's own `screenrecord` binary.
 *
 * Measured on the reference device (SM-G996B, Android 15):
 * `screenrecord --output-format=h264 ... -` writes a raw Annex B elementary
 * stream with 4-byte start codes, no AUD and no SEI NALs, and a ~10 s IDR
 * interval. `--time-limit 0` removes the 180 s cap on SDK >= 30. Samsung's
 * `--help` does not document `--output-format`, but the flag works.
 *
 * Two behaviours follow from the hardware rather than from choice:
 *
 *  - **`screenrecord` never re-configures mid-capture.** Rotate the device and
 *    it keeps the launch size, letterboxing the turned content into it. So a
 *    rotation has to be answered by restarting with swapped dimensions, which
 *    is why this source owns a `DisplayWatcher`.
 *  - **Two recorders cannot coexist.** There is one hardware encoder, and an
 *    orphan holds it, so every restart is strictly stop-then-start and is
 *    bracketed by a best-effort `pkill` on the device.
 */
export class ScreenrecordFrameSource implements FrameSource {
  readonly name = 'screenrecord';

  readonly #log: ScopedLogger;
  readonly #client: AdbClient;
  readonly #serial: string;
  readonly #options: ScreenrecordOptions;
  readonly #shell: PersistentShell;
  readonly #displays: DisplayWatcher;
  readonly #demuxer = new AnnexBDemuxer();

  readonly #unitEmitter = new vscode.EventEmitter<AccessUnit>();
  readonly #formatEmitter = new vscode.EventEmitter<VideoFormat>();
  readonly #failEmitter = new vscode.EventEmitter<SourceFailure>();
  readonly #disposables: vscode.Disposable[] = [];

  #child: ChildProcess | undefined;
  #format: VideoFormat | undefined;
  /** Size the live recorder was launched with, to detect a no-op rotation. */
  #captureSize: { width: number; height: number } | undefined;
  #stderr = '';
  #bytes = 0;
  #firstByteTimer: NodeJS.Timeout | undefined;
  #timeLimitTimer: NodeJS.Timeout | undefined;
  /** Serialises start/stop/restart so two recorders can never overlap. */
  #operation: Promise<void> = Promise.resolve();
  #running = false;
  #disposed = false;
  #failures = 0;
  #epochMs = 0;
  #lastPtsUs = -1;
  #lastKeyFrameRequest = 0;

  readonly onAccessUnit = this.#unitEmitter.event;
  readonly onDidChangeFormat = this.#formatEmitter.event;
  readonly onDidFail = this.#failEmitter.event;

  constructor(
    log: ScopedLogger,
    client: AdbClient,
    serial: string,
    options: ScreenrecordOptions,
  ) {
    this.#log = log;
    this.#client = client;
    this.#serial = serial;
    this.#options = options;
    // A shell of its own: `DisplayWatcher` polls `dumpsys window` every few
    // seconds, and PersistentShell serialises its queue, so sharing one with
    // the input sink would park taps behind a ~200 ms dumpsys.
    this.#shell = new PersistentShell(client, serial, log.child('display-shell'));
    this.#displays = new DisplayWatcher(client, this.#shell, serial, log.child('display'));
  }

  /** The sink reads geometry from here to turn 0..1 into device pixels. */
  get displays(): DisplayWatcher {
    return this.#displays;
  }

  get format(): VideoFormat | undefined {
    return this.#format;
  }

  async start(): Promise<void> {
    if (this.#disposed) return;
    this.#running = true;
    this.#epochMs = Date.now();
    const geometry = await this.#displays.start();
    this.#disposables.push(
      this.#displays.onDidChangeDisplay((next) => this.#onRotate(next)),
    );
    await this.#enqueue(() => this.#spawn(geometry));
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#enqueue(() => this.#kill());
  }

  requestKeyFrame(): void {
    if (!this.#running || this.#disposed) return;
    const now = Date.now();
    if (now - this.#lastKeyFrameRequest < KEYFRAME_MIN_INTERVAL_MS) return;
    this.#lastKeyFrameRequest = now;
    // Phase 1 has no other lever: the recorder emits an IDR only at launch and
    // then roughly every 10 s. Restarting is the request.
    this.#log.debug('restarting the recorder to produce a key frame');
    void this.#enqueue(() => this.#restart());
  }

  #onRotate(geometry: DisplayGeometry): void {
    if (!this.#running || this.#disposed) return;
    const next = captureSize(geometry.width, geometry.height, this.#options.maxWidth);
    const current = this.#captureSize;
    if (current && current.width === next.width && current.height === next.height) return;
    this.#log.info(`rotation changed the capture size to ${next.width}x${next.height}; restarting`);
    void this.#enqueue(() => this.#restart());
  }

  /**
   * Runs `work` after whatever is already queued.
   *
   * Everything that touches `#child` goes through here. Without it a rotation
   * arriving during a key-frame restart would spawn a second recorder, and the
   * two would fight over the one hardware encoder -- which fails opaquely
   * rather than loudly.
   */
  #enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(work, work);
    // Swallow here only; `work` reports its own failures through #fail().
    this.#operation = next.catch(() => undefined);
    return next;
  }

  async #restart(): Promise<void> {
    await this.#kill();
    if (!this.#running || this.#disposed) return;
    await this.#spawn(this.#displays.geometry);
  }

  async #spawn(geometry: DisplayGeometry | undefined): Promise<void> {
    if (!this.#running || this.#disposed) return;

    // Before, as well as after a stop: an orphan from a crashed extension host
    // holds the encoder, and then every start fails with no useful message.
    await this.#client.killOrphanedRecorders(this.#serial);

    const size = captureSize(
      geometry?.width ?? 1080,
      geometry?.height ?? 1920,
      this.#options.maxWidth,
    );
    this.#captureSize = size;
    // The SPS changes with the capture size, so the old parameter sets and the
    // half-accumulated NAL are both worthless now.
    this.#demuxer.reset();
    this.#format = undefined;
    this.#stderr = '';
    this.#bytes = 0;

    const args = [
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--bit-rate',
      this.#options.bitRate,
      '--size',
      `${size.width}x${size.height}`,
      '--time-limit',
      this.#options.sdkInt >= UNLIMITED_TIME_LIMIT_SDK ? '0' : String(TIME_LIMIT_SECONDS),
      '-',
    ];
    this.#log.info(`capturing ${size.width}x${size.height} at ${this.#options.bitRate}`);

    const child = this.#client.spawn(this.#serial, args);
    this.#child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.#onData(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Capped: a recorder that refuses to start can print without end, and
      // only the first line is ever diagnostic.
      if (this.#stderr.length < 4096) this.#stderr += chunk;
      this.#log.debug(`screenrecord: ${chunk.trim()}`);
    });
    child.once('error', (err) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#fail(classifyAdbError(String(err)).code, `Could not run adb: ${String(err)}`, true);
    });
    child.once('close', (code, signal) => this.#onExit(child, code, signal));

    this.#firstByteTimer = setTimeout(() => {
      if (this.#bytes > 0) return;
      this.#log.warn('no video after 5s; restarting');
      this.#fail(
        'source-failed',
        this.#stderr.trim() || 'screenrecord produced no video.',
        true,
      );
      void this.#enqueue(() => this.#restart());
    }, FIRST_BYTE_TIMEOUT_MS);

    if (this.#options.sdkInt < UNLIMITED_TIME_LIMIT_SDK) {
      // Pre-SDK-30 the recorder stops on its own at the cap. Pre-empting it a
      // few seconds early keeps the restart inside our own serialised queue
      // instead of arriving as a surprise exit.
      this.#timeLimitTimer = setTimeout(
        () => void this.#enqueue(() => this.#restart()),
        (TIME_LIMIT_SECONDS - 5) * 1000,
      );
    }
  }

  #onData(chunk: Buffer): void {
    this.#bytes += chunk.length;
    if (this.#firstByteTimer) {
      clearTimeout(this.#firstByteTimer);
      this.#firstByteTimer = undefined;
      this.#failures = 0;
    }

    let units;
    try {
      units = this.#demuxer.push(new Uint8Array(chunk));
    } catch (err) {
      this.#log.error('the Annex B demuxer rejected a chunk', err);
      return;
    }
    if (units.length === 0) return;

    this.#publishFormat();
    for (const unit of units) {
      this.#unitEmitter.fire({ data: unit.data, key: unit.key, ptsUs: this.#nextPts() });
    }
  }

  /**
   * Announces the format once the SPS has been seen.
   *
   * `screenrecord` carries no container and no timestamps, so the dimensions
   * and the codec string can only come from the bitstream. The plan's measured
   * trap: the SPS varies with capture size (`avc1.640020` at 540x1200,
   * `avc1.64002A` larger), so anything hardcoded is wrong on some device.
   */
  #publishFormat(): void {
    if (this.#format) return;
    const sps = this.#demuxer.sps;
    const parameterSets = this.#demuxer.parameterSets;
    if (!sps || !parameterSets) return;

    let info;
    try {
      info = parseSps(sps);
    } catch (err) {
      this.#log.error('could not parse the SPS', err);
      this.#fail('decode-failed', 'The device produced a stream we cannot describe.', false);
      return;
    }

    this.#format = {
      codec: 'h264',
      codecString: info.codecString,
      width: info.width,
      height: info.height,
      parameterSets,
    };
    this.#log.info(`format ${info.width}x${info.height} ${info.codecString}`);
    this.#formatEmitter.fire(this.#format);
  }

  /**
   * Synthesises a presentation timestamp from arrival time.
   *
   * The raw elementary stream has none, and `screenrecord` emits no B-frames,
   * so output order is decode order and the decoder only needs the timestamps
   * to be strictly increasing. Hence the `+1` floor: two units arriving in the
   * same millisecond must not share a timestamp.
   */
  #nextPts(): number {
    const elapsed = (Date.now() - this.#epochMs) * 1000;
    const pts = Math.max(this.#lastPtsUs + 1, elapsed);
    this.#lastPtsUs = pts;
    return pts;
  }

  #onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#clearTimers();
    // Deliberately not flushing the demuxer: a recorder killed mid-NAL leaves a
    // truncated unit, and feeding that to the decoder is worse than losing it.
    this.#demuxer.reset();

    if (!this.#running || this.#disposed) return;

    const classified = classifyAdbError(this.#stderr);
    const recoverable = classified.code !== 'device-gone' && classified.code !== 'adb-not-found';
    this.#log.warn(`screenrecord exited (code=${code} signal=${signal}) after ${this.#bytes} bytes`);
    this.#fail(classified.code, classified.hint, recoverable);
    if (!recoverable) {
      this.#running = false;
      return;
    }

    const delay =
      RESTART_BACKOFF_MS[Math.min(this.#failures, RESTART_BACKOFF_MS.length - 1)] ?? 6000;
    this.#failures++;
    setTimeout(() => {
      if (this.#running && !this.#disposed) void this.#enqueue(() => this.#restart());
    }, delay);
  }

  async #kill(): Promise<void> {
    this.#clearTimers();
    const child = this.#child;
    this.#child = undefined;
    // Killing the local `adb exec-out` does not reliably kill the remote
    // process, so the device-side pkill is the one that matters; the local kill
    // just closes the pipe immediately.
    child?.kill('SIGTERM');
    if (child) await this.#client.killOrphanedRecorders(this.#serial);
  }

  #clearTimers(): void {
    if (this.#firstByteTimer) clearTimeout(this.#firstByteTimer);
    if (this.#timeLimitTimer) clearTimeout(this.#timeLimitTimer);
    this.#firstByteTimer = undefined;
    this.#timeLimitTimer = undefined;
  }

  #fail(code: SourceFailure['code'], message: string, recoverable: boolean): void {
    const detail = this.#stderr.trim();
    this.#failEmitter.fire({ code, message, recoverable, ...(detail === '' ? {} : { detail }) });
  }

  dispose(): void {
    this.#disposed = true;
    this.#running = false;
    this.#clearTimers();
    this.#child?.kill('SIGTERM');
    this.#child = undefined;
    // Fire-and-forget: dispose cannot await, and leaving the encoder held would
    // break the *next* session rather than this one.
    void this.#client.killOrphanedRecorders(this.#serial);
    for (const d of this.#disposables) d.dispose();
    this.#displays.dispose();
    this.#shell.dispose();
    this.#unitEmitter.dispose();
    this.#formatEmitter.dispose();
    this.#failEmitter.dispose();
  }
}

/**
 * Scales the display down so its **longest** edge is at most `maxWidth`, which
 * is how the setting is documented and how scrcpy's `--max-size` behaves.
 *
 * Both edges are rounded *down* to even numbers. Even because H.264 chroma is
 * subsampled 2x2, so an odd dimension is not representable and the encoder
 * would silently pick its own size, desynchronising the touch mapping from the
 * picture. Down rather than nearest so that "at most `maxWidth`" is literally
 * true -- rounding up can exceed the cap by a pixel.
 */
export function captureSize(
  width: number,
  height: number,
  maxWidth: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > maxWidth ? maxWidth / longest : 1;
  return { width: toEven(width * scale), height: toEven(height * scale) };
}

function toEven(n: number): number {
  return Math.max(16, Math.floor(n / 2) * 2);
}
