import type * as vscode from 'vscode';

import type { ErrorCode, StillMessage, VideoCodec } from '../../common/protocol.js';

/** One complete access unit, ready to become a single `EncodedVideoChunk`. */
export interface AccessUnit {
  readonly data: Uint8Array;
  readonly key: boolean;
  readonly ptsUs: number;
}

export interface VideoFormat {
  readonly codec: VideoCodec;
  /** Parsed from the bitstream at runtime -- never hardcoded. */
  readonly codecString: string;
  readonly width: number;
  readonly height: number;
  /** SPS+PPS in Annex B, for seeding a decoder before the next key frame. */
  readonly parameterSets: Uint8Array;
}

export interface SourceFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly detail?: string;
  /** False when retrying is pointless, e.g. the device was unplugged. */
  readonly recoverable: boolean;
}

/**
 * A source of encoded video.
 *
 * The contract is deliberately *already demuxed*: implementations emit whole
 * access units, never raw bytes. That is what makes the phase 2 swap a drop-in
 * change -- `ScreenrecordFrameSource` parses Annex B, while a scrcpy source
 * needs no parser at all because the server frames every packet itself. The
 * webview never learns which one is running.
 */
export interface FrameSource extends vscode.Disposable {
  readonly name: string;
  readonly format: VideoFormat | undefined;
  readonly onAccessUnit: vscode.Event<AccessUnit>;
  readonly onDidChangeFormat: vscode.Event<VideoFormat>;
  readonly onDidFail: vscode.Event<SourceFailure>;

  /**
   * Set only by the degraded still source, which pushes PNGs instead of
   * encoded video. Keeping it here as an optional event means the session
   * wires both kinds of source identically, rather than there being two
   * sessions -- and the webview already accepts stills from either the socket
   * or `postMessage`, which is what makes degraded mode survive a dead socket.
   */
  readonly onStill?: vscode.Event<StillMessage>;

  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Asks for a key frame as soon as possible.
   *
   * Phase 1 can only do this by restarting the recorder, which costs the
   * ~600 ms spawn latency; phase 2 sends a reset message. Either way callers
   * must treat it as a hint, not a guarantee.
   */
  requestKeyFrame(): void;
}
