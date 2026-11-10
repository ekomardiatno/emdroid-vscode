import type * as vscode from 'vscode';

import type { KeyMessage, PointerMessage, ScrollMessage } from '../../common/protocol.js';

/**
 * Delivers input to the device.
 *
 * Every coordinate arriving here is **normalised 0..1 in stream space**. The
 * sink is what multiplies by the current display size, so neither the webview
 * nor the session has to know the capture size or the rotation. In phase 2 the
 * scrcpy control message carries the video dimensions and the server scales
 * itself, so the same normalised input feeds both without change.
 */
export interface InputSink extends vscode.Disposable {
  readonly name: string;

  pointer(event: PointerMessage): void;
  scroll(event: ScrollMessage): void;
  key(event: KeyMessage): void;
  text(text: string): void;

  /** Fires with a measured round-trip in ms when the sink can observe one. */
  readonly onDidMeasureLatency: vscode.Event<number>;
}
