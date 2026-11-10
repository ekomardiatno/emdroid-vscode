import {
  BINARY_HEADER_BYTES,
  type BinaryFrameHeader,
  type HostMessage,
  type WebviewMessage,
  readBinaryHeader,
} from '../common/protocol.js';

export type BinaryHandler = (header: BinaryFrameHeader, payload: Uint8Array) => void;
export type MessageHandler = (message: HostMessage) => void;
export type StatusHandler = (status: TransportStatus, detail?: string) => void;

export type TransportStatus = 'connecting' | 'open' | 'closed';

const RECONNECT_MIN_MS = 300;
const RECONNECT_MAX_MS = 5000;

/**
 * The webview's end of the stream socket.
 *
 * It reconnects on its own because the failure it is most likely to meet is not
 * the extension going away -- it is a proxy hop dropping an idle connection.
 * Under code-server every frame crosses nginx and code-server's own
 * `/proxy/<port>/` handler, and a reload of the browser tab must recover
 * without the user touching anything.
 */
export class Transport {
  readonly #url: string;
  readonly #onBinary: BinaryHandler;
  readonly #onMessage: MessageHandler;
  readonly #onStatus: StatusHandler;

  #socket: WebSocket | undefined;
  #backoffMs = RECONNECT_MIN_MS;
  #timer: number | undefined;
  #closed = false;

  constructor(url: string, handlers: {
    binary: BinaryHandler;
    message: MessageHandler;
    status: StatusHandler;
  }) {
    this.#url = url;
    this.#onBinary = handlers.binary;
    this.#onMessage = handlers.message;
    this.#onStatus = handlers.status;
  }

  get open(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.#closed) return;
    this.#clearTimer();
    this.#onStatus('connecting');

    const socket = new WebSocket(this.#url);
    // Without this every frame would arrive as a Blob, forcing an async
    // `arrayBuffer()` per access unit and adding a tick of latency to the hot
    // path for no reason.
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    socket.onopen = () => {
      this.#backoffMs = RECONNECT_MIN_MS;
      this.#onStatus('open');
    };

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.#handleText(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this.#handleBinary(event.data);
      }
    };

    socket.onerror = () => {
      // `onerror` carries no useful detail by design (it would leak
      // cross-origin information), so the only honest report is that it failed.
      this.#onStatus('closed', 'the stream connection failed');
    };

    socket.onclose = (event) => {
      if (this.#socket === socket) this.#socket = undefined;
      if (this.#closed) return;
      this.#onStatus('closed', event.reason || `closed with code ${event.code}`);
      this.#scheduleReconnect();
    };
  }

  #handleBinary(buffer: ArrayBuffer): void {
    if (buffer.byteLength < BINARY_HEADER_BYTES) return;
    const header = readBinaryHeader(new DataView(buffer), 0);
    this.#onBinary(header, new Uint8Array(buffer, BINARY_HEADER_BYTES));
  }

  #handleText(raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof value === 'object' && value !== null && typeof (value as HostMessage).t === 'string') {
      this.#onMessage(value as HostMessage);
    }
  }

  #scheduleReconnect(): void {
    this.#clearTimer();
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(RECONNECT_MAX_MS, this.#backoffMs * 2);
    this.#timer = self.setTimeout(() => this.connect(), delay);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) self.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  send(message: WebviewMessage): void {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  close(): void {
    this.#closed = true;
    this.#clearTimer();
    this.#socket?.close(1000, 'panel closed');
    this.#socket = undefined;
  }
}
