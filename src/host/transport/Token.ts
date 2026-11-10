import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-session capability token carried in the WebSocket path.
 *
 * The stream server binds to `127.0.0.1`, but "localhost" is not a security
 * boundary: under code-server the socket is reachable by anything that already
 * holds a session cookie, and on a desktop by any other process on the machine.
 * The token is what actually scopes a connection to one panel.
 *
 * Base64url with no padding, so it survives the `/proxy/<port>/` rewrite
 * unchanged and needs no escaping in a URL.
 */
export function createToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Matches the token in a request path. See `TOKEN_PATH_RE` for the slashes. */
export const TOKEN_PATH_RE = /^\/+s\/([A-Za-z0-9_-]{8,})$/;

/**
 * Extracts the token from a request URL.
 *
 * The leading `\/+` is not defensive padding. code-server's `getProxyTarget`
 * builds `http://0.0.0.0:PORT/` + the remaining path, which yields a **double
 * slash** -- the upgrade handler receives `//s/<token>`, not `/s/<token>`.
 */
export function tokenFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const path = url.split('?')[0] ?? '';
  return TOKEN_PATH_RE.exec(path)?.[1];
}

/** Constant-time comparison, so a token cannot be recovered byte by byte. */
export function tokenMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
