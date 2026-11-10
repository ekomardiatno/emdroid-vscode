import * as vscode from 'vscode';

import type {
  BootConfig,
  SessionState,
  SourceKind,
  StillMessage,
  WebviewMessage,
} from '../../common/protocol.js';
import type { ScopedLogger } from '../log.js';
import type { AccessUnit, FrameSource, SourceFailure, VideoFormat } from '../source/FrameSource.js';
import type { InputSink } from '../source/InputSink.js';
import { type StreamEndpoint, resolveStreamEndpoint } from '../transport/ExternalUri.js';
import { StreamServer } from '../transport/StreamServer.js';

/** No access unit for this long while streaming means something is wrong. */
const STALL_TIMEOUT_MS = 2500;

/**
 * Stills are measured at ~0.4 fps, so a 2.5 s gap is the *normal* case there.
 * Reusing the video timeout would park degraded mode permanently in "stalled".
 */
const STILL_STALL_TIMEOUT_MS = 15000;

/**
 * Above this much unflushed socket data we are no longer live, we are queuing.
 * Dropping non-key units is the only way back to the present; the alternative
 * is a decoder working on a monotonically older picture.
 */
const BACKPRESSURE_BYTES = 2 * 1024 * 1024;

export interface SessionMetrics {
  readonly state: SessionState;
  readonly fps: number;
  readonly tapRttMs: number | undefined;
}

export interface SessionTarget {
  readonly serial: string;
  readonly model: string;
  readonly kind: SourceKind;
}

/**
 * One mirror session: a source, a socket, and the policy between them.
 *
 * Everything here is deliberately source-agnostic. The session never parses a
 * bitstream, never spawns a process and never learns the capture size -- it
 * forwards whole access units and relays normalised input. That is what makes
 * the phase 2 scrcpy swap a constructor change rather than a rewrite.
 */
export class MirrorSession implements vscode.Disposable {
  readonly #log: ScopedLogger;
  readonly #server: StreamServer;
  readonly #source: FrameSource;
  readonly #input: InputSink | undefined;
  readonly #target: SessionTarget;
  readonly #sessionId: string;
  readonly #logLevel: string;
  readonly #disposables: vscode.Disposable[] = [];

  readonly #stateEmitter = new vscode.EventEmitter<SessionState>();
  readonly #metricsEmitter = new vscode.EventEmitter<SessionMetrics>();
  readonly #failEmitter = new vscode.EventEmitter<SourceFailure>();
  readonly #stillEmitter = new vscode.EventEmitter<StillMessage>();

  #endpoint: StreamEndpoint | undefined;
  #state: SessionState = 'starting';
  #fps = 0;
  #tapRttMs: number | undefined;

  /**
   * Landmine 5: the device emits an IDR roughly every 10 s, so a webview that
   * attaches just after one would paint nothing for up to 10 s and read as
   * broken. Replaying the last key unit makes a late join instant.
   */
  #lastKeyUnit: AccessUnit | undefined;
  #stallTimer: NodeJS.Timeout | undefined;
  #dropped = 0;

  readonly onDidChangeState = this.#stateEmitter.event;
  readonly onDidChangeMetrics = this.#metricsEmitter.event;
  readonly onDidFail = this.#failEmitter.event;
  /**
   * Degraded mode only. Mirrored onto `postMessage` by the owner, because the
   * case this mode exists for includes "the WebSocket never connected".
   */
  readonly onDidProduceStill = this.#stillEmitter.event;

  constructor(
    log: ScopedLogger,
    sessionId: string,
    target: SessionTarget,
    source: FrameSource,
    input: InputSink | undefined,
    logLevel: string,
  ) {
    this.#log = log;
    this.#sessionId = sessionId;
    this.#target = target;
    this.#source = source;
    this.#input = input;
    this.#logLevel = logLevel;
    this.#server = new StreamServer(log.child('ws'));
  }

  get state(): SessionState {
    return this.#state;
  }

  get endpoint(): StreamEndpoint | undefined {
    return this.#endpoint;
  }

  get metrics(): SessionMetrics {
    return { state: this.#state, fps: this.#fps, tapRttMs: this.#tapRttMs };
  }

  /**
   * Binds the socket and resolves the URL the webview must open.
   *
   * Split from `start()` because the port is ephemeral and the CSP has to name
   * the resolved origins: the panel cannot build its HTML until this returns.
   */
  async prepare(): Promise<BootConfig> {
    const port = await this.#server.listen();
    this.#endpoint = await resolveStreamEndpoint(port, this.#server.token, this.#log);

    this.#disposables.push(
      this.#server.onDidAttach(() => this.#onAttach()),
      this.#server.onDidDetach(() => this.#log.debug('stream detached')),
      this.#server.onDidReceiveMessage((msg) => this.#onMessage(msg)),
      this.#source.onDidChangeFormat((format) => this.#onFormat(format)),
      this.#source.onAccessUnit((unit) => this.#onAccessUnit(unit)),
      this.#source.onDidFail((failure) => this.#onFail(failure)),
    );

    if (this.#source.onStill) {
      this.#disposables.push(this.#source.onStill((still) => this.#onStill(still)));
    }

    if (this.#input) {
      this.#disposables.push(
        this.#input.onDidMeasureLatency((ms) => {
          this.#tapRttMs = ms;
          this.#metricsEmitter.fire(this.metrics);
        }),
      );
    }

    return {
      sessionId: this.#sessionId,
      streamUrl: this.#endpoint.wsUrl,
      serial: this.#target.serial,
      model: this.#target.model,
      source: this.#target.kind,
      logLevel: this.#logLevel,
    };
  }

  /** Starts the source. Safe to call before the webview has attached. */
  async start(): Promise<void> {
    this.#setState('starting');
    await this.#source.start();
  }

  async stop(): Promise<void> {
    this.#clearStallTimer();
    await this.#source.stop();
    this.#setState('stopped');
  }

  #onAttach(): void {
    this.#server.send({
      t: 'hello',
      sessionId: this.#sessionId,
      serial: this.#target.serial,
      model: this.#target.model,
      source: this.#target.kind,
    });

    const format = this.#source.format;
    if (format) this.#sendFormat(format);

    // Seed the decoder from cache first so the picture appears now, then ask
    // for a fresh key frame. Both are hints: the source may not be able to
    // honour the request, in which case the cached unit is all we have.
    const key = this.#lastKeyUnit;
    if (key) {
      this.#log.debug('replaying the cached key unit for a late joiner');
      this.#server.sendAccessUnit(key.data, true, key.ptsUs);
    }
    this.#source.requestKeyFrame();
  }

  #onFormat(format: VideoFormat): void {
    // A new format means a new SPS, so the cached unit is no longer decodable
    // against it. Dropping it is better than painting garbage once.
    this.#lastKeyUnit = undefined;
    this.#sendFormat(format);
  }

  #sendFormat(format: VideoFormat): void {
    this.#server.send({
      t: 'format',
      codec: format.codec,
      codecString: format.codecString,
      width: format.width,
      height: format.height,
    });
  }

  #onAccessUnit(unit: AccessUnit): void {
    if (unit.key) this.#lastKeyUnit = unit;

    if (!unit.key && this.#server.bufferedAmount > BACKPRESSURE_BYTES) {
      this.#dropped++;
      // One line per burst, not per frame: at 30 fps a per-frame warning would
      // itself become the bottleneck.
      if (this.#dropped % 30 === 1) {
        this.#log.warn(`dropping units under backpressure (${this.#dropped} so far)`);
      }
      return;
    }

    this.#server.sendAccessUnit(unit.data, unit.key, unit.ptsUs);
    this.#setState('streaming');
    this.#armStallTimer(STALL_TIMEOUT_MS);
  }

  #onStill(still: StillMessage): void {
    // Sent down both paths: the socket when it is up, and `postMessage` via the
    // owner regardless. A still is ~3 MB of base64 at ~0.4 fps, so the
    // duplication costs little and removes a whole failure mode.
    this.#server.send(still);
    this.#stillEmitter.fire(still);
    this.#setState('streaming');
    this.#armStallTimer(STILL_STALL_TIMEOUT_MS);
  }

  #onFail(failure: SourceFailure): void {
    this.#log.error(`source failed: ${failure.message}`);
    if (failure.detail) this.#log.debug(failure.detail);
    this.#server.send({
      t: 'error',
      code: failure.code,
      message: failure.message,
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
      recoverable: failure.recoverable,
    });
    this.#failEmitter.fire(failure);
  }

  #onMessage(msg: WebviewMessage): void {
    switch (msg.t) {
      case 'ready':
        this.#log.info(
          `webview ready: VideoDecoder=${msg.capabilities.videoDecoder} codecs=[${msg.capabilities.supportedCodecs.join(', ')}]`,
        );
        break;
      case 'pointer':
        this.#input?.pointer(msg);
        break;
      case 'scroll':
        this.#input?.scroll(msg);
        break;
      case 'key':
        this.#input?.key(msg);
        break;
      case 'text':
        this.#input?.text(msg.text);
        break;
      case 'keyframe':
        this.#source.requestKeyFrame();
        break;
      case 'ping':
        this.#server.send({ t: 'pong', id: msg.id });
        break;
      case 'metrics':
        this.#fps = msg.fps;
        if (msg.tapRttMs !== undefined) this.#tapRttMs = msg.tapRttMs;
        this.#metricsEmitter.fire(this.metrics);
        break;
      case 'log':
        this.#log.child('webview').write(msg.level, msg.message);
        break;
    }
  }

  #armStallTimer(timeoutMs: number): void {
    this.#clearStallTimer();
    this.#stallTimer = setTimeout(() => {
      if (this.#state !== 'streaming') return;
      this.#log.warn(`nothing to show for ${timeoutMs} ms`);
      this.#setState('stalled');
    }, timeoutMs);
  }

  #clearStallTimer(): void {
    if (this.#stallTimer) clearTimeout(this.#stallTimer);
    this.#stallTimer = undefined;
  }

  #setState(state: SessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#log.debug(`state -> ${state}`);
    this.#server.send({ t: 'state', state });
    this.#stateEmitter.fire(state);
    this.#metricsEmitter.fire(this.metrics);
  }

  dispose(): void {
    this.#clearStallTimer();
    void this.#source.stop();
    for (const d of this.#disposables.splice(0)) d.dispose();
    this.#source.dispose();
    this.#input?.dispose();
    this.#server.dispose();
    this.#stateEmitter.dispose();
    this.#metricsEmitter.dispose();
    this.#failEmitter.dispose();
    this.#stillEmitter.dispose();
  }
}
