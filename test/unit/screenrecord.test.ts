import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { shellQuote } from '../../src/host/source/screenrecord/AdbInputSink.ts';
import { captureSize } from '../../src/host/source/screenrecord/ScreenrecordFrameSource.ts';

/**
 * The two pure functions behind the phase 1 source and sink.
 *
 * Both fail silently when they are wrong: a bad `captureSize` makes the encoder
 * choose its own dimensions, so the picture is fine and only the touch mapping
 * drifts; a bad `shellQuote` types the wrong thing, or runs it.
 */

describe('captureSize', () => {
  it('scales the measured display to the committed fixture size', () => {
    // 1080x2400 is the reference device; 540x1200 is what the fixture in
    // test/fixtures was captured at, so this pins the two together.
    assert.deepEqual(captureSize(1080, 2400, 1200), { width: 540, height: 1200 });
  });

  it('caps the longest edge, not the width', () => {
    // The setting is named maxWidth but bounds the long side, as scrcpy's
    // --max-size does. Capping width alone would leave 1080x2400 untouched and
    // the device would encode a full-resolution stream.
    assert.deepEqual(captureSize(1080, 2400, 1080), { width: 486, height: 1080 });
  });

  it('is symmetric under rotation', () => {
    // Rotation swaps the edges; the capture must swap with it, or a landscape
    // stream arrives letterboxed into a portrait frame.
    assert.deepEqual(captureSize(2400, 1080, 1200), { width: 1200, height: 540 });
  });

  it('never upscales a display that is already small enough', () => {
    assert.deepEqual(captureSize(720, 1280, 1920), { width: 720, height: 1280 });
  });

  it('keeps both edges even and inside the cap', () => {
    // Swept rather than spot-checked: an odd edge is the failure that shows up
    // as a working picture with misaligned taps, which is hard to attribute.
    for (const maxWidth of [640, 720, 1080, 1081, 1200]) {
      for (const [w, h] of [
        [1080, 2400],
        [1081, 2401],
        [1440, 3200],
        [720, 1280],
        [1200, 1920],
      ] as const) {
        const size = captureSize(w, h, maxWidth);
        assert.equal(size.width % 2, 0, `${w}x${h}@${maxWidth} width`);
        assert.equal(size.height % 2, 0, `${w}x${h}@${maxWidth} height`);
        assert.ok(
          Math.max(size.width, size.height) <= maxWidth,
          `${w}x${h}@${maxWidth} exceeded the cap: ${size.width}x${size.height}`,
        );
      }
    }
  });

  it('floors at 16 px rather than collapsing to zero', () => {
    // A zero edge makes screenrecord exit with a usage error, which reads as
    // "the source failed" rather than "the geometry was nonsense".
    assert.deepEqual(captureSize(8, 8, 1080), { width: 16, height: 16 });
    assert.deepEqual(captureSize(1080, 2400, 16), { width: 16, height: 16 });
  });
});

describe('shellQuote', () => {
  const nasty = [
    'hello world',
    "it's",
    "''",
    '$HOME',
    '$(id)',
    '`id`',
    'a;b',
    'a|b',
    'a&b',
    'a\\b',
    'a"b',
    '*',
    '--not-a-flag',
    '',
    "';touch /tmp/emdroid-pwned;'",
  ];

  it('produces the POSIX form', () => {
    assert.equal(shellQuote('hello world'), `'hello world'`);
    assert.equal(shellQuote(''), `''`);
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
  });

  it('round-trips through a real shell', () => {
    // The assertion that matters. `PersistentShell.exec` writes to a real
    // shell's stdin, so the only convincing test is a real shell: if any input
    // below comes back changed, the device would have run something else.
    for (const value of nasty) {
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], {
        encoding: 'utf8',
      });
      assert.equal(out, value, `shell mangled ${JSON.stringify(value)}`);
    }
  });

  it('leaves no way out of the quotes', () => {
    // Every quoted form is a single argument: one leading quote, one trailing
    // quote, and nothing unescaped in between.
    for (const value of nasty) {
      const quoted = shellQuote(value);
      const argv = execFileSync(
        '/bin/sh',
        ['-c', `for a in ${quoted}; do printf '%s\\n' "$a"; done | wc -l`],
        { encoding: 'utf8' },
      );
      assert.equal(Number(argv.trim()), 1, `${JSON.stringify(value)} split into several words`);
    }
  });
});
