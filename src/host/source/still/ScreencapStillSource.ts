import * as vscode from 'vscode';

import type { StillMessage } from '../../../common/protocol.js';
import type { AdbClient } from '../../adb/AdbClient.js';
import { DisplayWatcher } from '../../adb/DisplayWatcher.js';
import { PersistentShell } from '../../adb/PersistentShell.js';
import { classifyAdbError } from '../../adb/parse.js';
import type { ScopedLogger } from '../../log.js';
import type { AccessUnit, FrameSource, SourceFailure, VideoFormat } from '../FrameSource.js';

/**
 * Measured: `screencap -p` is 2.3 MB in 2.6 s. The gap is breathing room so a
 * capture loop cannot monopolise the device, not a frame-rate target.
 */
const IDLE_MS = 250;

/** One capture cannot plausibly take longer than this; past it, something hung. */
const CAPTURE_TIMEOUT_MS = 15000;

/** Give up after this many consecutive failures rather than loop forever. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Controllable stills via `screencap -p`.
 *
 * This is the floor, for an editor with no `VideoDecoder` or a proxy that will
 * not carry a WebSocket. Measured on the reference device it manages **~0.4
 * fps** -- not the 1-2 fps one might assume, and `screencap -j` is unsupported
 * (it answers with a 676-byte error), so there is no cheaper encoding to reach
 * for. The honest description is "controllable stills": the picture crawls, but
 * input is fully functional, which is the entire point of having this mode at
 * all rather than an error message.
 *
 * It implements `FrameSource` so the session does not need a second code path;
 * it simply never produces an access unit or a format.
 */
export class ScreencapStillSource implements FrameSource {
  readonly name = 'still';

  readonly #log: ScopedLogger;
  readonly #client: AdbClient;
  readonly #serial: string;
  readonly #shell: PersistentShell;
  readonly #displays: DisplayWatcher;

  readonly #unitEmitter = new vscode.EventEmitter<AccessUnit>();
  readonly #formatEmitter = new vscode.EventEmitter<VideoFormat>();
  readonly #failEmitter = new vscode.EventEmitter<SourceFailure>();
  readonly #stillEmitter = new vscode.EventEmitter<StillMessage>();

  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #failures = 0;

  readonly onAccessUnit = this.#unitEmitter.event;
  readonly onDidChangeFormat = this.#formatEmitter.event;
  readonly onDidFail = this.#failEmitter.event;
  readonly onStill = this.#stillEmitter.event;

  constructor(log: ScopedLogger, client: AdbClient, serial: string) {
    this.#log = log;
    this.#client = client;
    this.#serial = serial;
    this.#shell = new PersistentShell(client, serial, log.child('display-shell'));
    this.#displays = new DisplayWatcher(client, this.#shell, serial, log.child('display'));
  }

  /** The sink reads geometry from here, exactly as with the video source. */
  get displays(): DisplayWatcher {
    return this.#displays;
  }

  /** Always undefined: there is no encoded stream to describe. */
  get format(): VideoFormat | undefined {
    return undefined;
  }

  async start(): Promise<void> {
    this.#running = true;
    await this.#displays.start();
    void this.#loop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Nothing to honour: every still is already a complete picture. */
  requestKeyFrame(): void {}

  async #loop(): Promise<void> {
    while (this.#running) {
      const ok = await this.#capture();
      if (!this.#running) return;
      if (!ok && ++this.#failures >= MAX_CONSECUTIVE_FAILURES) {
        this.#running = false;
        return;
      }
      if (ok) this.#failures = 0;
      await new Promise<void>((resolve) => {
        this.#timer = setTimeout(resolve, IDLE_MS);
      });
    }
  }

  async #capture(): Promise<boolean> {
    try {
      // `exec-out`, never `shell`: a pty would translate \n inside the PNG.
      const result = await this.#client.execOut(
        this.#serial,
        ['screencap', '-p'],
        CAPTURE_TIMEOUT_MS,
      );
      if (result.code !== 0 || result.stdout.length === 0) {
        const classified = classifyAdbError(result.stderr);
        this.#failEmitter.fire({
          code: classified.code,
          message: 'The device could not produce a screenshot.',
          detail: classified.hint,
          recoverable: classified.code !== 'device-gone',
        });
        return false;
      }

      const geometry = this.#displays.geometry;
      this.#stillEmitter.fire({
        t: 'still',
        png: result.stdout.toString('base64'),
        width: geometry?.width ?? 0,
        height: geometry?.height ?? 0,
      });
      return true;
    } catch (err) {
      this.#log.debug(`screencap failed: ${String(err)}`);
      this.#failEmitter.fire({
        code: 'source-failed',
        message: 'The screenshot capture failed.',
        detail: String(err),
        recoverable: true,
      });
      return false;
    }
  }

  dispose(): void {
    void this.stop();
    this.#displays.dispose();
    this.#shell.dispose();
    this.#unitEmitter.dispose();
    this.#formatEmitter.dispose();
    this.#failEmitter.dispose();
    this.#stillEmitter.dispose();
  }
}
