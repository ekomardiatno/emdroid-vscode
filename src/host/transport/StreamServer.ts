import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import * as vscode from 'vscode';

import { WebSocket, WebSocketServer } from 'ws';

import {
  BINARY_HEADER_BYTES,
  BIN_ACCESS_UNIT,
  type HostMessage,
  type WebviewMessage,
  parseWebviewMessage,
  writeBinaryHeader,
} from '../../common/protocol.js';
import type { ScopedLogger } from '../log.js';
import { createToken, tokenFromUrl, tokenMatches } from './Token.js';

export interface StreamClient {
  send(message: HostMessage): void;
  sendAccessUnit(data: Uint8Array, key: boolean, ptsUs: number): void;
  close(): void;
  readonly bufferedAmount: number;
}

/**
 * A localhost WebSocket server, one per mirror session.
 *
 * It exists because `webview.postMessage` JSON-serialises everything it is
 * given, which makes it unusable for per-frame H.264. A real socket, surfaced
 * to the webview through `vscode.env.asExternalUri`, is the only path that
 * works identically on the desktop and behind code-server's `/proxy/` route.
 *
 * It binds `127.0.0.1` deliberately. code-server's proxy target resolves to
 * `0.0.0.0`, which reaches loopback anyway -- binding `0.0.0.0` here would
 * publish the raw stream on every interface for no benefit.
 */
export class StreamServer implements vscode.Disposable {
  readonly #log: ScopedLogger;
  readonly #token = createToken();
  readonly #clientEmitter = new vscode.EventEmitter<StreamClient>();
  readonly #messageEmitter = new vscode.EventEmitter<WebviewMessage>();
  readonly #closeEmitter = new vscode.EventEmitter<void>();

  #http: Server | undefined;
  #wss: WebSocketServer | undefined;
  #socket: WebSocket | undefined;
  #port = 0;
  #seq = 0;
  #disposed = false;

  /** Fires when a webview attaches. Re-fires if it reconnects. */
  readonly onDidAttach = this.#clientEmitter.event;
  readonly onDidReceiveMessage = this.#messageEmitter.event;
  readonly onDidDetach = this.#closeEmitter.event;

  constructor(log: ScopedLogger) {
    this.#log = log;
  }

  get port(): number {
    return this.#port;
  }

  get token(): string {
    return this.#token;
  }

  get attached(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /** Bytes queued but not yet flushed to the OS -- the backpressure signal. */
  get bufferedAmount(): number {
    return this.#socket?.bufferedAmount ?? 0;
  }

  /** Starts listening on an ephemeral loopback port and resolves with it. */
  async listen(): Promise<number> {
    const http = createServer((_req, res) => {
      // Nothing is served over plain HTTP. A GET here is almost always a probe
      // or a misrouted proxy request; answer tersely rather than leaking the
      // fact that a WebSocket lives at a particular path.
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('upgrade required');
    });
    this.#http = http;

    // `noServer`: we do the upgrade by hand so the token is checked before `ws`
    // allocates any per-connection state.
    const wss = new WebSocketServer({
      noServer: true,
      // H.264 is already compressed. permessage-deflate would burn CPU on every
      // frame for no size win, and adds latency to exactly the hot path.
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
    });
    this.#wss = wss;

    http.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        http.removeListener('error', reject);
        resolve();
      });
    });

    const address = http.address();
    if (address === null || typeof address === 'string') {
      throw new Error('stream server did not bind a TCP port');
    }
    this.#port = address.port;
    this.#log.info(`stream server listening on 127.0.0.1:${this.#port}`);
    return this.#port;
  }

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = tokenFromUrl(req.url);
    if (token === undefined || !tokenMatches(this.#token, token)) {
      this.#log.warn(`rejected upgrade for ${JSON.stringify(req.url)}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const wss = this.#wss;
    if (!wss || this.#disposed) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws));
  }

  #onConnection(ws: WebSocket): void {
    // One panel, one socket. A reconnect (webview reload, proxy hiccup)
    // replaces the old one rather than fanning frames out to a zombie.
    if (this.#socket && this.#socket !== ws) {
      this.#log.debug('replacing an existing stream connection');
      this.#socket.close(1000, 'replaced');
    }
    this.#socket = ws;
    ws.binaryType = 'nodebuffer';
    this.#log.info('webview attached to the stream');

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // The webview never sends binary.
      const parsed = parseWebviewMessage(data.toString('utf8'));
      if (!parsed) {
        this.#log.warn('dropped an unparseable message from the webview');
        return;
      }
      this.#messageEmitter.fire(parsed);
    });

    ws.on('close', (code, reason) => {
      if (this.#socket === ws) {
        this.#socket = undefined;
        this.#log.info(`webview detached (${code} ${reason.toString('utf8')})`);
        this.#closeEmitter.fire();
      }
    });

    ws.on('error', (err) => this.#log.warn(`stream socket error: ${String(err)}`));

    this.#clientEmitter.fire(this.#makeClient(ws));
  }

  #makeClient(ws: WebSocket): StreamClient {
    return {
      send: (message) => this.send(message),
      sendAccessUnit: (data, key, ptsUs) => this.sendAccessUnit(data, key, ptsUs),
      close: () => ws.close(1000, 'session ended'),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    };
  }

  send(message: HostMessage): void {
    const ws = this.#socket;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  /**
   * Sends one access unit as a single binary frame.
   *
   * Header and payload are copied into one buffer rather than sent as two
   * writes: `ws` would otherwise emit them as separate frames, and the webview
   * would have to reassemble them.
   */
  sendAccessUnit(data: Uint8Array, key: boolean, ptsUs: number): void {
    const ws = this.#socket;
    if (ws?.readyState !== WebSocket.OPEN) return;

    const frame = new Uint8Array(BINARY_HEADER_BYTES + data.length);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    writeBinaryHeader(view, 0, BIN_ACCESS_UNIT, key, this.#seq++, ptsUs);
    frame.set(data, BINARY_HEADER_BYTES);
    ws.send(frame, { binary: true });
  }

  dispose(): void {
    this.#disposed = true;
    this.#socket?.close(1001, 'extension shutting down');
    this.#socket = undefined;
    this.#wss?.close();
    this.#wss = undefined;
    this.#http?.close();
    this.#http = undefined;
    this.#clientEmitter.dispose();
    this.#messageEmitter.dispose();
    this.#closeEmitter.dispose();
  }
}
