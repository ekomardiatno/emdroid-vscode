import * as vscode from 'vscode';

import type { BootConfig, HostMessage } from '../../common/protocol.js';
import type { ScopedLogger } from '../log.js';
import type { StreamEndpoint } from '../transport/ExternalUri.js';
import { renderPanelHtml } from './html.js';

export const MIRROR_VIEW_TYPE = 'emdroid.mirror';

/**
 * The mirror lives in an editor tab, not the sidebar.
 *
 * A sidebar `WebviewView` is **disposed whenever its container is collapsed**,
 * so switching to the Explorer would tear down the decoder, the socket and the
 * on-device recorder -- then pay the ~600 ms respawn on the way back, several
 * times a minute. A `WebviewPanel` with `retainContextWhenHidden` is the only
 * container with a documented guarantee that the document survives being
 * hidden, and it can be split or dragged beside the code being debugged.
 */
export class MirrorPanel implements vscode.Disposable {
  readonly #panel: vscode.WebviewPanel;
  readonly #log: ScopedLogger;
  readonly #disposeEmitter = new vscode.EventEmitter<void>();

  readonly onDidDispose = this.#disposeEmitter.event;

  private constructor(panel: vscode.WebviewPanel, log: ScopedLogger) {
    this.#panel = panel;
    this.#log = log;
    panel.onDidDispose(() => {
      this.#log.info('mirror panel closed');
      this.#disposeEmitter.fire();
      this.#disposeEmitter.dispose();
    });
  }

  static create(
    extensionUri: vscode.Uri,
    log: ScopedLogger,
    boot: BootConfig,
    endpoint: StreamEndpoint,
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
  ): MirrorPanel {
    const panel = vscode.window.createWebviewPanel(MIRROR_VIEW_TYPE, boot.model, column, {
      enableScripts: true,
      // See the class comment: this is the whole reason for a panel.
      retainContextWhenHidden: true,
      // Only `dist/` is needed; scoping this keeps the webview from being able
      // to read anything else in the extension directory.
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'device.svg');
    panel.webview.html = renderPanelHtml(panel.webview, extensionUri, boot, endpoint);
    log.info(`mirror panel open for ${boot.model} (${boot.serial}) via ${boot.source}`);
    return new MirrorPanel(panel, log);
  }

  get visible(): boolean {
    return this.#panel.visible;
  }

  reveal(): void {
    this.#panel.reveal(undefined, true);
  }

  /**
   * The JSON side-channel. Used only for degraded-mode stills, which have to
   * arrive even when the WebSocket is what failed -- everything else goes over
   * the socket, because `postMessage` cannot carry per-frame video.
   */
  post(message: HostMessage): void {
    void this.#panel.webview.postMessage(message);
  }

  setTitle(title: string): void {
    this.#panel.title = title;
  }

  dispose(): void {
    this.#panel.dispose();
  }
}
