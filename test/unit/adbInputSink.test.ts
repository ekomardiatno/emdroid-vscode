import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AdbClient } from '../../src/host/adb/AdbClient.ts';
import { ChildProcessRegistry } from '../../src/host/childProcesses.ts';
import { Logger } from '../../src/host/log.ts';
import {
  AdbInputSink,
  type GeometrySource,
} from '../../src/host/source/screenrecord/AdbInputSink.ts';

/**
 * The input sink, against a real shell and a fake `input`.
 *
 * `AdbClient` pointed at `/bin/sh` yields `sh -s fake shell`, and `-s` means
 * "read commands from stdin" -- a genuine shell on a pipe, which is all the
 * sink asks of the far end (see persistentShell.test.ts). A shim named `input`
 * early on `PATH` then records every command the sink actually issued, which is
 * the only thing worth asserting here: the sink's whole job is deciding which
 * `input` invocations to make and which to collapse.
 */
describe('AdbInputSink', () => {
  const logger = new Logger();
  const registry = new ChildProcessRegistry(logger.scope('test'));
  const dir = mkdtempSync(join(tmpdir(), 'emdroid-input-'));
  const originalPath = process.env['PATH'];
  const originalLog = process.env['EMDROID_INPUT_LOG'];

  const geometry: GeometrySource = { geometry: { rotation: 0, width: 1080, height: 2400 } };
  /** The fields a pointer message carries that this sink has no use for. */
  const tap = { pressure: 1, t0: 0 };

  let log = '';
  let sinks = 0;

  before(() => {
    const shim = join(dir, 'input');
    writeFileSync(shim, '#!/bin/sh\necho "$@" >> "$EMDROID_INPUT_LOG"\n');
    chmodSync(shim, 0o755);
    process.env['PATH'] = `${dir}:${originalPath ?? ''}`;
  });

  after(() => {
    process.env['PATH'] = originalPath;
    if (originalLog === undefined) delete process.env['EMDROID_INPUT_LOG'];
    else process.env['EMDROID_INPUT_LOG'] = originalLog;
    registry.killAll();
    logger.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A sink with its own shell and its own log.
   *
   * One log per sink, not one per suite: `dispose` only asks the shell to stop,
   * so a command from the previous test can still land after the next one has
   * begun, and a shared file would read as the new test's output.
   */
  function newSink(): AdbInputSink {
    log = join(dir, `commands-${++sinks}.log`);
    writeFileSync(log, '');
    process.env['EMDROID_INPUT_LOG'] = log;
    return new AdbInputSink(
      logger.scope('input'),
      new AdbClient(registry, logger.scope('test'), '/bin/sh'),
      'fake',
      geometry,
    );
  }

  function lines(): string[] {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  }

  /**
   * Waits for at least `expected` commands and then for the log to stop
   * growing. The count matters: spawning the shell takes long enough that
   * "stopped growing" is also true before anything has started.
   */
  async function settle(expected: number): Promise<string[]> {
    let previous = -1;
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = lines();
      if (current.length >= expected && current.length === previous) return current;
      previous = current.length;
    }
    return lines();
  }

  /**
   * The bug this file was written for: a trackpad emits a wheel event every
   * ~10 ms and keeps sending momentum for about a second after the fingers
   * lift, while each `input` costs ~80-150 ms. Queued, one gesture scrolled for
   * tens of seconds and could not be stopped -- and because every `input swipe`
   * ends in a fling, it accelerated as it went.
   */
  it('collapses a burst of wheel events into one swipe', async () => {
    const sink = newSink();
    // 60 notches of 1/600th of the viewport each, delivered as fast as the
    // webview would deliver them.
    for (let i = 0; i < 60; i++) {
      sink.scroll({ t: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -1 / 600 });
    }
    const sent = await settle(2);
    sink.dispose();

    // The first swipe leaves as soon as the sum clears the slop and the rest
    // merge behind it; the point is that it is a handful, not sixty.
    assert.ok(sent.length <= 3, `expected a few swipes, got ${sent.length}`);
    assert.ok(sent.every((line) => line.startsWith('swipe ')));

    // And the distance is summed rather than thrown away: 60 notches of
    // 2400/600 = 4 px is 240 px of content, so the finger travels 240 px down.
    const travelled = sent.reduce((sum, line) => {
      const [, , fromY, , toY] = line.split(' ');
      return sum + (Number(toY) - Number(fromY));
    }, 0);
    assert.equal(travelled, 240);
  });

  /**
   * The second half of the same bug. `input swipe` is a DOWN, some MOVEs and an
   * UP; land them within `ViewConfiguration`'s touch slop and the view calls it
   * a click. A few pixels of wheel therefore *taps*, so a scroll over a list
   * opened whatever was under the pointer.
   */
  it('holds back a scroll too short to be anything but a tap', async () => {
    const sink = newSink();
    // Three notches: 12 px, well inside the ~23 px slop at this density.
    for (let i = 0; i < 3; i++) {
      sink.scroll({ t: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -1 / 600 });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(lines(), []);

    // Kept, not dropped: the rest of the gesture adds to it and goes out whole.
    sink.scroll({ t: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.1 });
    const sent = await settle(1);
    sink.dispose();
    assert.equal(sent.length, 1);
    assert.equal(sent[0], 'swipe 540 1200 540 1452 63');
  });

  it('scales the swipe duration with its distance', async () => {
    const sink = newSink();
    sink.scroll({ t: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.2 });
    const sent = await settle(1);
    sink.dispose();

    assert.equal(sent.length, 1);
    // 0.2 * 2400 = 480 px at 4 px/ms is 120 ms, inside the 60..250 bounds. A
    // fixed duration would make this swipe fly four times faster than a short
    // one and fling proportionally further, which is how the runaway compounded.
    assert.equal(sent[0], 'swipe 540 1200 540 1680 120');
  });

  it('runs a tap ahead of a scroll that is still unwinding', async () => {
    const sink = newSink();
    sink.scroll({ t: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.2 });
    sink.pointer({ t: 'pointer', action: 'down', pointerId: 0, x: 0.5, y: 0.5, ...tap });
    sink.pointer({ t: 'pointer', action: 'up', pointerId: 0, x: 0.5, y: 0.5, ...tap });
    const sent = await settle(3);
    sink.dispose();

    const kinds = sent.map((line) => {
      const [verb, second] = line.split(' ');
      return verb === 'motionevent' ? second : verb;
    });
    assert.deepEqual(kinds, ['swipe', 'DOWN', 'UP']);
  });

  it('ignores a scroll once disposed', async () => {
    const sink = newSink();
    sink.dispose();
    sink.scroll({ t: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.2 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(lines(), []);
  });
});
