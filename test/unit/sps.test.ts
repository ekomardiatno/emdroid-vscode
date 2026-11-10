import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { scanNalUnits } from '../../src/common/h264/annexb.ts';
import { codecStringFromSps, parseSps, unescapeRbsp } from '../../src/common/h264/sps.ts';
import { FIXTURE, readFixture } from './fixture.ts';

const fixture = readFixture();
const first = scanNalUnits(fixture)[0];
if (!first) throw new Error('fixture has no NALs');
const sps = fixture.subarray(first.start, first.end);

describe('codecStringFromSps', () => {
  it('reads the fixture SPS as avc1.640020', () => {
    // 67 64 00 20 -> High profile (100), no constraints, level 3.2.
    assert.equal(codecStringFromSps(sps), FIXTURE.codecString);
  });

  it('zero-pads each byte to two hex digits', () => {
    assert.equal(codecStringFromSps(Uint8Array.of(0x67, 0x42, 0x00, 0x0a)), 'avc1.42000a');
  });

  it('handles the level that the same device reports at a larger size', () => {
    // Measured on the same phone at a bigger capture size: level 4.2. This is
    // exactly why the string is parsed and never hardcoded.
    assert.equal(codecStringFromSps(Uint8Array.of(0x67, 0x64, 0x00, 0x2a)), 'avc1.64002a');
  });

  it('rejects a truncated SPS rather than emitting a bogus string', () => {
    assert.throws(() => codecStringFromSps(Uint8Array.of(0x67, 0x64, 0x00)), /too short/);
  });
});

describe('unescapeRbsp', () => {
  it('removes the emulation prevention byte after two zeros', () => {
    assert.deepEqual(unescapeRbsp(Uint8Array.of(0x00, 0x00, 0x03, 0x01)), Uint8Array.of(0, 0, 1));
  });

  it('keeps a 0x03 that is not preceded by two zeros', () => {
    assert.deepEqual(unescapeRbsp(Uint8Array.of(0x00, 0x03, 0x03)), Uint8Array.of(0, 3, 3));
  });

  it('resets the zero run after the byte it removed', () => {
    // 00 00 03 00 00 03 01 -> 00 00 00 00 01
    assert.deepEqual(
      unescapeRbsp(Uint8Array.of(0, 0, 3, 0, 0, 3, 1)),
      Uint8Array.of(0, 0, 0, 0, 1),
    );
  });

  it('leaves a buffer with nothing to unescape untouched', () => {
    const buf = Uint8Array.of(0x64, 0x00, 0x20, 0xac, 0xb4);
    assert.deepEqual(unescapeRbsp(buf), buf);
  });
});

describe('parseSps', () => {
  it('recovers the exact capture size from the fixture', () => {
    const info = parseSps(sps);
    assert.equal(info.width, FIXTURE.width);
    assert.equal(info.height, FIXTURE.height);
  });

  it('reports profile, constraints and level', () => {
    const info = parseSps(sps);
    assert.equal(info.profileIdc, 100);
    assert.equal(info.constraintFlags, 0);
    assert.equal(info.levelIdc, 32);
    assert.equal(info.codecString, FIXTURE.codecString);
  });

  it('applies frame cropping', () => {
    // 540 is not a multiple of 16, so the encoder codes 34 macroblocks across
    // (544px) and crops 4 -> 2 chroma samples each side. If cropping were
    // ignored the renderer would show a 544px-wide picture and every touch
    // coordinate would drift to the right.
    const info = parseSps(sps);
    assert.notEqual(info.width, 544);
    assert.equal(info.width, 540);
  });

  it('refuses a corrupt SPS instead of returning nonsense', () => {
    const bad = new Uint8Array(24);
    bad[0] = 0x67;
    bad[1] = 100; // High profile, so it reads the chroma block
    assert.throws(() => parseSps(bad));
  });
});
