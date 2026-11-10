import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { EventEmitter } from 'vscode';
import { WebSocket } from 'ws';

import type { HostMessage, SourceKind, StillMessage } from '../../src/common/protocol.ts';
import { Logger } from '../../src/host/log.ts';
import { MirrorSession } from '../../src/host/session/MirrorSession.ts';
import type { AccessUnit, FrameSource, SourceFailure, VideoFormat } from '../../src/host/source/FrameSource.ts';
import type { InputSink } from '../../src/host/source/InputSink.ts';

/**
 * The degraded-mode handover.
 *
 * A webview with no `VideoDecoder` can never paint a frame, and nothing on the
 * host can find that out until the webview has attached and said so. So the
 * session has to be able to change source after it has started, which is the
 * one piece of its lifecycle that is not fixed at construction -- and the one
 * place where a stale subscription would feed the decoder units from a source
 * that no longer exists.
 */

class FakeSource implements FrameSource {
  readonly #units = new EventEmitter<AccessUnit>();
  readonly #formats = new EventEmitter<VideoFormat>();
  readonly #fails = new EventEmitter<SourceFailure>();
  readonly #stills = new EventEmitter<StillMessage>();

  readonly onAccessUnit = this.#units.event;
  readonly onDidChangeFormat = this.#formats.event;
  readonly onDidFail = this.#fails.event;
  /** Only a still source has this, which is what the session branches on. */
  readonly onStill: FrameSource['onStill'];

  readonly name: string;
  format: VideoFormat | undefined;
  started = 0;
  stopped = 0;
  disposed = 0;

  constructor(name: string) {
    this.name = name;
    if (name === 'still') this.onStill = this.#stills.event;
  }

  async start(): Promise<void> {
    this.started++;
  }

  async stop(): Promise<void> {
    this.stopped++;
  }

  requestKeyFrame(): void {}

  dispose(): void {
    this.disposed++;
  }

  emitUnit(): void {
    this.#units.fire({ data: new Uint8Array([0, 0, 0, 1, 0x65]), key: true, ptsUs: 1 });
  }

  emitStill(): void {
    this.#stills.fire({ t: 'still', png: 'aGk=', width: 1080, height: 2400 });
  }
}

class FakeSink implements InputSink {
  readonly onDidMeasureLatency = new EventEmitter<number>().event;
  readonly name = 'fake';
  disposed = 0;
  pointer(): void {}
  scroll(): void {}
  key(): void {}
  text(): void {}
  dispose(): void {
    this.disposed++;
  }
}

describe('falling back to stills when the webview cannot decode', () => {
  const logger = new Logger();
  const log = logger.scope('test');

  let session: MirrorSession;
  let socket: WebSocket;
  const video = new FakeSource('video');
  const videoSink = new FakeSink();
  const still = new FakeSource('still');
  const stillSink = new FakeSink();
  const requested: SourceKind[] = [];
  const stillsPosted: StillMessage[] = [];
  const messages: HostMessage[] = [];
  let binaryFrames = 0;

  before(async () => {
    session = new MirrorSession(
      log,
      'swap-session',
      { serial: 'fake', model: 'Fake', kind: 'screenrecord' },
      video,
      videoSink,
      'info',
    );
    const boot = await session.prepare();

    // Stands in for SessionManager: the session asks for a kind, the owner is
    // what knows how to build one.
    session.onDidRequestSource((kind) => {
      requested.push(kind);
      void session.useSource(kind, still, stillSink);
    });
    // Stands in for the `postMessage` mirror, which is what makes degraded mode
    // work when the socket is the thing that failed.
    session.onDidProduceStill((message) => stillsPosted.push(message));

    socket = new WebSocket(boot.streamUrl);
    socket.binaryType = 'nodebuffer';
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) binaryFrames++;
      else messages.push(JSON.parse(data.toString('utf8')) as HostMessage);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await session.start();

    socket.send(
      JSON.stringify({ t: 'ready', capabilities: { videoDecoder: false, supportedCodecs: [] } }),
    );
    await waitFor(() => still.started > 0, 2000);
  });

  after(() => {
    socket.close();
    session.dispose();
    logger.dispose();
  });

  it('asks its owner for the still source', () => {
    assert.deepEqual(requested, ['still']);
  });

  it('stops and disposes the source it replaced', () => {
    // Stopped *and* disposed, in that order: stop is what reaps the on-device
    // recorder, and a recorder left holding the hardware encoder breaks the
    // next session rather than this one.
    assert.equal(video.stopped, 1);
    assert.equal(video.disposed, 1);
    assert.equal(still.started, 1);
  });

  it('disposes the sink along with the source', () => {
    // The sink reads geometry from the source it was built with, so one
    // outliving the other would map taps against a size that has stopped
    // being updated -- taps land in the wrong place after a rotation.
    assert.equal(videoSink.disposed, 1);
    assert.equal(stillSink.disposed, 0);
  });

  it('re-greets the webview with the kind it is now looking at', () => {
    const hellos = messages.filter((m) => m.t === 'hello');
    assert.equal(hellos.length, 2, 'expected a second hello after the swap');
    assert.equal(hellos[0]?.source, 'screenrecord');
    assert.equal(hellos[1]?.source, 'still');
  });

  it('forwards stills down both paths', async () => {
    still.emitStill();
    await waitFor(() => stillsPosted.length > 0, 2000);
    assert.equal(stillsPosted[0]?.png, 'aGk=');
    await waitFor(() => messages.some((m) => m.t === 'still'), 2000);
  });

  it('ignores the source it replaced', async () => {
    // The real failure this guards: a live `onAccessUnit` subscription on a
    // disposed source would keep pushing units from a different SPS.
    const before = binaryFrames;
    video.emitUnit();
    socket.send(JSON.stringify({ t: 'ping', id: 7 }));
    // The pong proves the unit was seen and dropped, not merely in flight.
    await waitFor(() => messages.some((m) => m.t === 'pong'), 2000);
    assert.equal(binaryFrames, before);
  });

  it('does not swap twice when the webview re-announces itself', async () => {
    // `ready` is re-sent on every reconnect, so this arrives again routinely.
    socket.send(
      JSON.stringify({ t: 'ready', capabilities: { videoDecoder: false, supportedCodecs: [] } }),
    );
    socket.send(JSON.stringify({ t: 'ping', id: 8 }));
    await waitFor(() => messages.filter((m) => m.t === 'pong').length >= 2, 2000);
    assert.deepEqual(requested, ['still']);
    assert.equal(still.stopped, 0, 'the still source was torn down and rebuilt');
  });
});

describe('keeping video when the webview can decode', () => {
  const logger = new Logger();
  const log = logger.scope('test');

  let session: MirrorSession;
  let socket: WebSocket;
  const video = new FakeSource('video');
  const requested: SourceKind[] = [];
  const messages: HostMessage[] = [];

  before(async () => {
    session = new MirrorSession(
      log,
      'keep-session',
      { serial: 'fake', model: 'Fake', kind: 'screenrecord' },
      video,
      undefined,
      'info',
    );
    const boot = await session.prepare();
    session.onDidRequestSource((kind) => requested.push(kind));

    socket = new WebSocket(boot.streamUrl);
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) messages.push(JSON.parse(data.toString('utf8')) as HostMessage);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await session.start();
  });

  after(() => {
    socket.close();
    session.dispose();
    logger.dispose();
  });

  it('leaves a capable webview alone', async () => {
    socket.send(
      JSON.stringify({
        t: 'ready',
        capabilities: { videoDecoder: true, supportedCodecs: ['avc1.640020'] },
      }),
    );
    socket.send(JSON.stringify({ t: 'ping', id: 1 }));
    await waitFor(() => messages.some((m) => m.t === 'pong'), 2000);
    assert.deepEqual(requested, []);
  });

  it('falls back when the decoder exists but cannot do H.264', async () => {
    // Measured capability, not a version check: a decoder that reports no
    // supported profile is as useless to us as no decoder at all.
    socket.send(
      JSON.stringify({ t: 'ready', capabilities: { videoDecoder: true, supportedCodecs: [] } }),
    );
    await waitFor(() => requested.length > 0, 2000);
    assert.deepEqual(requested, ['still']);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
