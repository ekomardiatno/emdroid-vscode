import * as vscode from 'vscode';

import type { ScopedLogger } from '../log.js';

export interface StreamEndpoint {
  /** `ws://…` or `wss://…`, ready for `new WebSocket()`. */
  readonly wsUrl: string;
  /** Origin of the HTTP form, for the webview's `connect-src`. */
  readonly httpOrigin: string;
  /** Origin of the ws form, also needed in `connect-src`. */
  readonly wsOrigin: string;
  /** True when the URI came back rewritten, i.e. we are behind a proxy. */
  readonly proxied: boolean;
}

/**
 * Turns `127.0.0.1:<port>` into a URL the webview can actually open.
 *
 * Both halves of this were verified against the shipped bundles rather than
 * assumed:
 *
 *  - **Desktop**: no URI resolver is registered, the internal call throws, and
 *    the public API wrapper swallows the error and returns the input unchanged
 *    for `http`/`https`. So we get our own loopback URL back.
 *  - **code-server**: it maps to `basePath + "/proxy/{{port}}/"` resolved
 *    against `window.location.href`, giving
 *    `https://host/proxy/<port>/...`. The webview there is same-origin, so the
 *    proxy's `ensureOrigin` and `ensureAuthenticated` guards both pass.
 *
 * Two traps are handled here:
 *
 *  1. The URI **must** be `http:`. A `ws:` scheme is not in the pass-through
 *    list and rethrows on the desktop. So ask for `http:` and flip the scheme
 *    afterwards.
 *  2. The scheme flip uses `new URL(...)`, not `Uri.with({ scheme })`, because
 *    `Uri.with` percent-encodes the query string on the way out.
 */
export async function resolveStreamEndpoint(
  port: number,
  token: string,
  log: ScopedLogger,
): Promise<StreamEndpoint> {
  const local = vscode.Uri.parse(`http://127.0.0.1:${port}/s/${token}`);
  const external = await vscode.env.asExternalUri(local);

  // `toString(true)` skips re-encoding; the token is base64url so there is
  // nothing in it that needs escaping anyway.
  const externalString = external.toString(true);
  const proxied = externalString !== local.toString(true);

  const httpUrl = new URL(externalString);
  const wsUrl = new URL(externalString);
  wsUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  log.info(`stream endpoint ${proxied ? '(proxied) ' : ''}${redact(wsUrl, token)}`);
  if (proxied) log.debug(`VSCODE_PROXY_URI=${process.env['VSCODE_PROXY_URI'] ?? '<unset>'}`);

  return {
    wsUrl: wsUrl.toString(),
    httpOrigin: httpUrl.origin,
    wsOrigin: wsUrl.origin,
    proxied,
  };
}

/** Never write a live capability token to a log the user may paste publicly. */
function redact(url: URL, token: string): string {
  return url.toString().replace(token, `${token.slice(0, 4)}…`);
}
