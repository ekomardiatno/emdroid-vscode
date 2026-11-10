import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { EventEmitter } from 'vscode';
import { WebSocket } from 'ws';

import { AnnexBDemuxer } from '../../src/common/h264/annexb.ts';
import {
  BINARY_HEADER_BYTES,
  BIN_ACCESS_UNIT,
  type HostMessage,
  readBinaryHeader,
} from '../../src/common/protocol.ts';
import { Logger } from '../../src/host/log.ts';
import { MirrorSession } from '../../src/host/session/MirrorSession.ts';
import type { InputSink } from '../../src/host/source/InputSink.ts';
import { FixtureFrameSource } from '../../src/host/source/fixture/FixtureFrameSource.ts';
import { StreamServer } from '../../src/host/transport/StreamServer.ts';
import { TOKEN_PATH_RE, createToken, tokenFromUrl, tokenMatches } from '../../src/host/transport/Token.ts';
import { FIXTURE, FIXTURE_PATH, readFixture } from './fixture.ts';

/**
 * Exercises the real transport in plain node.
 *
 * Everything between the frame source and the socket is covered here: the token
 * guard, the binary framing, the session's attach handshake and the webview ->
 * host input path. What is left for the manual phase 0 gate is only what cannot
 * exist outside a browser -- `asExternalUri` under code-server, and the
 * WebCodecs decoder.
 */

describe('token path matching', () => {
  it('accepts the plain path', () => {
    assert.equal(tokenFromUrl('/s/abcdefgh'), 'abcdefgh');
  });

  it('accepts the double slash code-server produces', () => {
    // `getProxyTarget` builds `http://0.0.0.0:PORT/` + `/s/<token>`, so the
    // upgrade handler genuinely receives `//s/<token>`. Matching only `/s/`
    // would 403 every connection behind code-server.
    assert.equal(tokenFromUrl('//s/abcdefgh'), 'abcdefgh');
    assert.equal(tokenFromUrl('///s/abcdefgh'), 'abcdefgh');
  });

  it('rejects anything else', () => {
    for (const url of ['/s/short', '/x/abcdefgh', '/s/abcdefgh/extra', '/s/bad.token', undefined]) {
      assert.equal(tokenFromUrl(url), undefined, `expected ${String(url)} to be rejected`);
    }
  });

  it('does not match a token with a query string', () => {
    // The token is base64url, so nothing legitimate needs a query. Keeping the
    // pattern anchored means a proxy appending one cannot smuggle a path.
    assert.equal(TOKEN_PATH_RE.test('/s/abcdefgh?a=1'), false);
  });

  it('compares tokens without leaking length through early exit', () => {
    const token = createToken();
    assert.equal(tokenMatches(token, token), true);
    assert.equal(tokenMatches(token, `${token}x`), false);
    assert.equal(tokenMatches(token, ''), false);
  });
});

describe('StreamServer', () => {
  let server: StreamServer;
  let port: number;
  const logger = new Logger();

  before(async () => {
    server = new StreamServer(logger.scope('test'));
    port = await server.listen();
  });

  after(() => {
    server.dispose();
    logger.dispose();
  });

  it('binds an ephemeral loopback port', () => {
    assert.ok(port > 0);
  });

  it('refuses an upgrade with the wrong token', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/s/${'0'.repeat(32)}`);
    const error = await new Promise<Error>((resolve) => {
      socket.once('error', resolve);
      socket.once('open', () => resolve(new Error('the socket opened; it should not have')));
    });
    assert.match(error.message, /403/);
  });

  it('accepts an upgrade with the right token', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/s/${server.token}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    assert.equal(server.attached, true);
    socket.close();
  });

  it('answers plain HTTP with 426 rather than describing itself', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/s/${server.token}`);
    assert.equal(response.status, 426);
  });
});

describe('fixture session end to end', () => {
  const logger = new Logger();
  const log = logger.scope('test');

  /** Records what the host-side sink was handed, to check the input path. */
  class RecordingSink implements InputSink {
    readonly name = 'recording';
    readonly received: unknown[] = [];
    readonly onDidMeasureLatency = new EventEmitter<number>().event;
    pointer(event: unknown): void {
      this.received.push(event);
    }
    scroll(event: unknown): void {
      this.received.push(event);
    }
    key(event: unknown): void {
      this.received.push(event);
    }
    text(text: string): void {
      this.received.push({ t: 'text', text });
    }
    dispose(): void {}
  }

  let session: MirrorSession;
  let sink: RecordingSink;
  let socket: WebSocket;
  const messages: HostMessage[] = [];
  const frames: Array<{ header: ReturnType<typeof readBinaryHeader>; payload: Uint8Array }> = [];

  before(async () => {
    sink = new RecordingSink();
    session = new MirrorSession(
      log,
      'test-session',
      { serial: 'fixture', model: 'Fixture', kind: 'screenrecord' },
      new FixtureFrameSource(log, FIXTURE_PATH),
      sink,
      'info',
    );
    const boot = await session.prepare();

    // Desktop behaviour: the stub returns the URI unchanged, so the webview
    // gets our own loopback URL back with the scheme flipped to ws.
    assert.match(boot.streamUrl, /^ws:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+$/);
    assert.equal(session.endpoint?.proxied, false);

    socket = new WebSocket(boot.streamUrl);
    socket.binaryType = 'nodebuffer';
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        frames.push({
          header: readBinaryHeader(view, 0),
          payload: new Uint8Array(data.subarray(BINARY_HEADER_BYTES)),
        });
      } else {
        messages.push(JSON.parse(data.toString('utf8')) as HostMessage);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    await session.start();
    // 12 units at the source's 30 fps cadence; generous so a loaded CI box
    // does not make this flaky.
    await waitFor(() => frames.length >= 12, 4000);
  });

  after(() => {
    socket.close();
    session.dispose();
    logger.dispose();
  });

  it('greets the webview on attach', () => {
    const hello = messages.find((m) => m.t === 'hello');
    assert.ok(hello, 'no hello message');
    assert.equal(hello.model, 'Fixture');
    assert.equal(hello.serial, 'fixture');
  });

  it('sends the format parsed from the fixture SPS, not a hardcoded string', () => {
    const format = messages.find((m) => m.t === 'format');
    assert.ok(format, 'no format message');
    assert.equal(format.codec, 'h264');
    assert.equal(format.codecString, FIXTURE.codecString);
    assert.equal(format.width, FIXTURE.width);
    assert.equal(format.height, FIXTURE.height);
  });

  it('reports streaming once units flow', () => {
    const states = messages.filter((m) => m.t === 'state').map((m) => m.state);
    assert.ok(states.includes('streaming'), `states were ${states.join(',')}`);
  });

  it('frames every unit as a single binary message with a well-formed header', () => {
    for (const [index, frame] of frames.entries()) {
      assert.equal(frame.header.kind, BIN_ACCESS_UNIT);
      assert.equal(frame.header.seq, index, 'sequence numbers must have no gaps');
    }
  });

  it('opens with a key frame carrying the parameter sets', () => {
    const first = frames[0];
    assert.ok(first);
    assert.equal(first.header.key, true);
    // SPS (7) then PPS (8) then the IDR (5): without these in-band the decoder
    // has nothing to configure from, because Annex B mode passes no description.
    assert.deepEqual([...first.payload.subarray(0, 5)], [0, 0, 0, 1, 0x67]);
    assert.ok(first.payload.length > FIXTURE.spsByteLength + FIXTURE.ppsByteLength);
  });

  it('delivers the access units byte-for-byte in order', () => {
    const demuxer = new AnnexBDemuxer();
    const expected = [...demuxer.push(readFixture()), ...demuxer.flush()];
    for (const [index, frame] of frames.entries()) {
      const want = expected[index];
      assert.ok(want, `fixture has no unit ${index}`);
      assert.equal(frame.header.key, want.key, `unit ${index} key flag`);
      assert.deepEqual(frame.payload, want.data, `unit ${index} payload`);
    }
  });

  it('advances the presentation timestamp monotonically', () => {
    for (let i = 1; i < frames.length; i++) {
      const previous = frames[i - 1];
      const current = frames[i];
      assert.ok(previous && current);
      assert.ok(current.header.ptsUs > previous.header.ptsUs, `pts regressed at ${i}`);
    }
  });

  it('delivers normalised pointer input to the sink', async () => {
    socket.send(
      JSON.stringify({
        t: 'pointer',
        action: 'down',
        pointerId: 0,
        x: 0.25,
        y: 0.75,
        pressure: 1,
        t0: 123,
      }),
    );
    await waitFor(() => sink.received.length >= 1, 2000);
    assert.deepEqual(sink.received[0], {
      t: 'pointer',
      action: 'down',
      pointerId: 0,
      x: 0.25,
      y: 0.75,
      pressure: 1,
      t0: 123,
    });
  });

  it('drops a pointer message with out-of-range coordinates', async () => {
    const before = sink.received.length;
    socket.send(
      JSON.stringify({ t: 'pointer', action: 'move', pointerId: 0, x: 42, y: 0.5, pressure: 1, t0: 1 }),
    );
    socket.send(JSON.stringify({ t: 'ping', id: 1 }));
    // The pong proves the message after the bad one was processed, so the drop
    // is not just a race with the assertion.
    await waitFor(() => messages.some((m) => m.t === 'pong'), 2000);
    assert.equal(sink.received.length, before);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
