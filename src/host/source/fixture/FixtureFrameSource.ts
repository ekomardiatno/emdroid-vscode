import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';

import { AnnexBDemuxer } from '../../../common/h264/annexb.js';
import { parseSps } from '../../../common/h264/sps.js';
import type { ScopedLogger } from '../../log.js';
import type { AccessUnit, FrameSource, SourceFailure, VideoFormat } from '../FrameSource.js';

const FRAME_INTERVAL_MS = 1000 / 30;

/**
 * Replays the committed capture in a loop. No device, no adb.
 *
 * This is the phase 0 instrument: it exercises the entire transport -- stream
 * server, `asExternalUri`, the proxy hop, the binary framing, the webview
 * decoder and the renderer -- with a known-good bitstream, so that when
 * something does not paint there is exactly one place it can be. Proving this
 * path in a real browser against code-server before writing any capture code
 * is what keeps a transport bug from being misdiagnosed as a codec bug.
 */
export class FixtureFrameSource implements FrameSource {
  readonly name = 'fixture';

  readonly #log: ScopedLogger;
  readonly #fixturePath: string;
  readonly #unitEmitter = new vscode.EventEmitter<AccessUnit>();
  readonly #formatEmitter = new vscode.EventEmitter<VideoFormat>();
  readonly #failEmitter = new vscode.EventEmitter<SourceFailure>();

  #units: Array<{ data: Uint8Array; key: boolean }> = [];
  #format: VideoFormat | undefined;
  #index = 0;
  #ptsUs = 0;
  #timer: NodeJS.Timeout | undefined;

  readonly onAccessUnit = this.#unitEmitter.event;
  readonly onDidChangeFormat = this.#formatEmitter.event;
  readonly onDidFail = this.#failEmitter.event;

  constructor(log: ScopedLogger, fixturePath: string) {
    this.#log = log;
    this.#fixturePath = fixturePath;
  }

  get format(): VideoFormat | undefined {
    return this.#format;
  }

  async start(): Promise<void> {
    const bytes = new Uint8Array(await readFile(this.#fixturePath));
    const demuxer = new AnnexBDemuxer();
    this.#units = [...demuxer.push(bytes), ...demuxer.flush()];

    const sps = demuxer.sps;
    const parameterSets = demuxer.parameterSets;
    if (!sps || !parameterSets) {
      this.#failEmitter.fire({
        code: 'source-failed',
        message: 'The bundled fixture has no parameter sets.',
        recoverable: false,
      });
      return;
    }

    const info = parseSps(sps);
    this.#format = {
      codec: 'h264',
      codecString: info.codecString,
      width: info.width,
      height: info.height,
      parameterSets,
    };
    this.#log.info(
      `fixture: ${this.#units.length} access units, ${info.width}x${info.height} ${info.codecString}`,
    );
    this.#formatEmitter.fire(this.#format);

    this.#index = 0;
    this.#ptsUs = 0;
    this.#timer = setInterval(() => this.#tick(), FRAME_INTERVAL_MS);
  }

  #tick(): void {
    const unit = this.#units[this.#index];
    if (!unit) return;
    this.#unitEmitter.fire({ data: unit.data, key: unit.key, ptsUs: this.#ptsUs });
    this.#ptsUs += Math.round(FRAME_INTERVAL_MS * 1000);
    this.#index++;
    // Loop back to the key unit at index 0, which carries SPS+PPS, so the
    // decoder gets a clean random-access point on every wrap.
    if (this.#index >= this.#units.length) this.#index = 0;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  requestKeyFrame(): void {
    // The only key unit is index 0, so jump there.
    this.#index = 0;
  }

  dispose(): void {
    void this.stop();
    this.#unitEmitter.dispose();
    this.#formatEmitter.dispose();
    this.#failEmitter.dispose();
  }
}
