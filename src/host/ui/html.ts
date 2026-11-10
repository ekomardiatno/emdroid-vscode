import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import type { BootConfig } from '../../common/protocol.js';
import type { StreamEndpoint } from '../transport/ExternalUri.js';

/**
 * Builds the panel document.
 *
 * The CSP is assembled **per session**, not once at activation, because the
 * stream server binds an ephemeral port: the `connect-src` origins are not
 * known until `asExternalUri` has resolved. Under code-server those origins are
 * the public host, under the desktop they are `127.0.0.1:<port>` -- naming
 * either one statically would break the other.
 *
 * `default-src 'none'` with no `'unsafe-inline'` anywhere means the only script
 * that can run is the one nonce'd bundle, so the boot config travels as a
 * `data-boot` attribute rather than an inlined `<script>`.
 */
export function renderPanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  boot: BootConfig,
  endpoint: StreamEndpoint,
): string {
  const nonce = randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));

  // `connect-src` needs both forms: the ws/wss origin for the socket itself,
  // and the http/https origin because some browsers match the pre-upgrade
  // scheme. They are the same host, so this costs nothing.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${endpoint.httpOrigin} ${endpoint.wsOrigin}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri.toString()}" rel="stylesheet">
<title>${escapeText(boot.model)}</title>
</head>
<body data-boot="${escapeAttribute(JSON.stringify(boot))}">
<div id="stage">
  <canvas id="screen" tabindex="0" aria-label="Android device screen"></canvas>
  <div id="overlay" role="status">Connecting…</div>
</div>
<div id="toolbar">
  <button type="button" data-key="BACK" title="Back">Back</button>
  <button type="button" data-key="HOME" title="Home">Home</button>
  <button type="button" data-key="APP_SWITCH" title="Recents">Recents</button>
  <button type="button" data-key="POWER" title="Power">Power</button>
  <span id="stats"></span>
</div>
<script nonce="${nonce}" type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

/** Escapes for a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escapes for HTML text content. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
