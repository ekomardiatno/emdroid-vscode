/**
 * The host <-> webview contract.
 *
 * Two channels, deliberately:
 *
 *  - The **WebSocket** carries everything hot. Binary frames are access units
 *    (see `BINARY_HEADER_BYTES`); text frames are the JSON messages below.
 *    `webview.postMessage` JSON-serialises, so it cannot carry per-frame H.264
 *    at any sane cost -- that is the whole reason the socket exists.
 *  - `postMessage` carries only the cold path: the boot handshake and the
 *    degraded still-image mode, where ~0.4 fps of base64 PNG is affordable.
 *
 * Every coordinate crossing this boundary is **normalised 0..1 in stream
 * space**, never pixels. That is what lets the webview stay ignorant of
 * rotation, of the current capture size, and of which source is running.
 */

export type SourceKind = 'screenrecord' | 'scrcpy' | 'still';

export type VideoCodec = 'h264' | 'h265' | 'av1';

export interface VideoFormatMessage {
  readonly codec: VideoCodec;
  /** Parsed from the SPS at runtime, e.g. `avc1.640020`. Never hardcoded. */
  readonly codecString: string;
  readonly width: number;
  readonly height: number;
}

/** What the webview reports it can actually do, measured not assumed. */
export interface WebviewCapabilities {
  readonly videoDecoder: boolean;
  readonly supportedCodecs: readonly string[];
}

export type SessionState = 'starting' | 'streaming' | 'stalled' | 'stopped';

/** Stable codes so the UI can map a failure to an actionable hint. */
export type ErrorCode =
  | 'adb-not-found'
  | 'device-unauthorized'
  | 'device-offline'
  | 'device-gone'
  | 'source-failed'
  | 'encoder-busy'
  | 'decode-failed'
  | 'transport-failed'
  | 'unsupported';

// ---------------------------------------------------------------------------
// Host -> webview
// ---------------------------------------------------------------------------

export interface HelloMessage {
  readonly t: 'hello';
  readonly sessionId: string;
  readonly serial: string;
  readonly model: string;
  readonly source: SourceKind;
}

export interface FormatMessage extends VideoFormatMessage {
  readonly t: 'format';
}

export interface StateMessage {
  readonly t: 'state';
  readonly state: SessionState;
  readonly message?: string;
}

export interface StillMessage {
  readonly t: 'still';
  /** base64 PNG. Degraded mode only -- measured at ~0.4 fps on a real device. */
  readonly png: string;
  readonly width: number;
  readonly height: number;
}

export interface ErrorMessage {
  readonly t: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly detail?: string;
  /** False when the session is dead and the webview should stop retrying. */
  readonly recoverable: boolean;
}

export interface PongMessage {
  readonly t: 'pong';
  readonly id: number;
}

export type HostMessage =
  | HelloMessage
  | FormatMessage
  | StateMessage
  | StillMessage
  | ErrorMessage
  | PongMessage;

// ---------------------------------------------------------------------------
// Webview -> host
// ---------------------------------------------------------------------------

export interface ReadyMessage {
  readonly t: 'ready';
  readonly capabilities: WebviewCapabilities;
}

export type PointerAction = 'down' | 'move' | 'up' | 'cancel';

export interface PointerMessage {
  readonly t: 'pointer';
  readonly action: PointerAction;
  /** Stable per gesture; 0 for the primary pointer. */
  readonly pointerId: number;
  /** Normalised 0..1 in stream space. */
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
  /** Client clock at the originating DOM event, for round-trip measurement. */
  readonly t0: number;
}

export interface ScrollMessage {
  readonly t: 'scroll';
  readonly x: number;
  readonly y: number;
  /** Normalised fractions of the viewport, positive = content moves up/left. */
  readonly dx: number;
  readonly dy: number;
}

export type KeyAction = 'down' | 'up' | 'press';

export interface KeyMessage {
  readonly t: 'key';
  readonly action: KeyAction;
  /** Android `KEYCODE_*` numeric value, resolved in the webview. */
  readonly keyCode: number;
  /** Android meta-state bitmask. */
  readonly metaState: number;
}

export interface TextMessage {
  readonly t: 'text';
  readonly text: string;
}

export interface KeyFrameRequestMessage {
  readonly t: 'keyframe';
}

export interface PingMessage {
  readonly t: 'ping';
  readonly id: number;
}

export interface MetricsMessage {
  readonly t: 'metrics';
  readonly fps: number;
  /** Frames sitting in the decoder; a rising number means we are falling behind. */
  readonly decodeQueue: number;
  /** Measured tap round-trip in ms, or undefined before the first tap. */
  readonly tapRttMs?: number;
}

export interface LogMessage {
  readonly t: 'log';
  readonly level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly message: string;
}

export type WebviewMessage =
  | ReadyMessage
  | PointerMessage
  | ScrollMessage
  | KeyMessage
  | TextMessage
  | KeyFrameRequestMessage
  | PingMessage
  | MetricsMessage
  | LogMessage;

// ---------------------------------------------------------------------------
// Boot handshake (postMessage / data-boot attribute)
// ---------------------------------------------------------------------------

/**
 * Handed to the webview through a `data-boot` attribute on <body>, because the
 * stream endpoint is only known after `asExternalUri` resolves an ephemeral
 * port -- which is also why the CSP has to be built per session.
 */
export interface BootConfig {
  readonly sessionId: string;
  /** Absolute ws:// or wss:// URL including the one-time token path. */
  readonly streamUrl: string;
  readonly serial: string;
  readonly model: string;
  readonly source: SourceKind;
  readonly logLevel: string;
}

// ---------------------------------------------------------------------------
// Binary framing on the WebSocket
// ---------------------------------------------------------------------------

/** `kind` byte of a binary WS frame. */
export const BIN_ACCESS_UNIT = 1;

/**
 * 16 bytes, little-endian, naturally aligned:
 *
 *   0  u8   kind          (BIN_ACCESS_UNIT)
 *   1  u8   flags         (bit0 = key frame)
 *   2  u16  reserved      (0)
 *   4  u32  seq           (wraps; used only to spot gaps in the log)
 *   8  u32  ptsUs low
 *  12  u32  ptsUs high
 *  16  payload: one complete Annex B access unit
 */
export const BINARY_HEADER_BYTES = 16;

export const FLAG_KEY_FRAME = 1;

export interface BinaryFrameHeader {
  readonly kind: number;
  readonly key: boolean;
  readonly seq: number;
  readonly ptsUs: number;
}

export function writeBinaryHeader(
  view: DataView,
  offset: number,
  kind: number,
  key: boolean,
  seq: number,
  ptsUs: number,
): void {
  view.setUint8(offset + 0, kind);
  view.setUint8(offset + 1, key ? FLAG_KEY_FRAME : 0);
  view.setUint16(offset + 2, 0, true);
  view.setUint32(offset + 4, seq >>> 0, true);
  // Split rather than BigInt: the webview turns it straight back into a Number
  // for EncodedVideoChunk, and Number handles 2^53 us (~285 years) fine.
  view.setUint32(offset + 8, ptsUs >>> 0, true);
  view.setUint32(offset + 12, Math.floor(ptsUs / 0x1_0000_0000) >>> 0, true);
}

export function readBinaryHeader(view: DataView, offset: number): BinaryFrameHeader {
  const lo = view.getUint32(offset + 8, true);
  const hi = view.getUint32(offset + 12, true);
  return {
    kind: view.getUint8(offset + 0),
    key: (view.getUint8(offset + 1) & FLAG_KEY_FRAME) !== 0,
    seq: view.getUint32(offset + 4, true),
    ptsUs: hi * 0x1_0000_0000 + lo,
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Narrows an untrusted JSON payload to a webview message. The host must never
 * trust the socket: in code-server the WebSocket is reachable by anything that
 * already holds a session cookie, so shape-check before acting on it.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (typeof raw !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const msg = value as { t?: unknown };
  if (typeof msg.t !== 'string') return undefined;

  switch (msg.t) {
    case 'ready':
    case 'keyframe':
    case 'ping':
    case 'metrics':
    case 'log':
    case 'text':
    case 'key':
    case 'scroll':
      return value as WebviewMessage;
    case 'pointer': {
      const p = value as Partial<PointerMessage>;
      if (!isUnitInterval(p.x) || !isUnitInterval(p.y)) return undefined;
      if (typeof p.pointerId !== 'number' || !Number.isInteger(p.pointerId)) return undefined;
      return value as WebviewMessage;
    }
    default:
      return undefined;
  }
}

function isUnitInterval(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Clamps a normalised coordinate; gestures that leave the canvas still land. */
export function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
