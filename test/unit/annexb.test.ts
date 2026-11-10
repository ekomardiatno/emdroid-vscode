import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  AnnexBDemuxer,
  NAL_PPS,
  NAL_SLICE_IDR,
  NAL_SPS,
  nalType,
  scanNalUnits,
  startsAccessUnit,
  withStartCodes,
} from '../../src/common/h264/annexb.ts';
import { FIXTURE, chunked, concat, readFixture } from './fixture.ts';

const fixture = readFixture();

/** Runs a demuxer over the given chunks and returns every emitted unit. */
function demux(chunks: readonly Uint8Array[]): ReturnType<AnnexBDemuxer['push']> {
  const d = new AnnexBDemuxer();
  const out: ReturnType<AnnexBDemuxer['push']> = [];
  for (const c of chunks) out.push(...d.push(c));
  out.push(...d.flush());
  return out;
}

describe('scanNalUnits', () => {
  it('finds every NAL in the fixture', () => {
    const nals = scanNalUnits(fixture);
    assert.equal(fixture.length, FIXTURE.byteLength);
    assert.equal(nals.length, FIXTURE.nalCount);
  });

  it('matches the measured NAL histogram, with no AUD and no SEI', () => {
    const hist: Record<number, number> = {};
    for (const n of scanNalUnits(fixture)) hist[n.type] = (hist[n.type] ?? 0) + 1;
    assert.deepEqual(hist, FIXTURE.nalHistogram);
    // The absence of these two is exactly why we split on first_mb_in_slice.
    assert.equal(hist[6], undefined, 'stream unexpectedly contains SEI');
    assert.equal(hist[9], undefined, 'stream unexpectedly contains AUD');
  });

  it('opens with SPS then PPS then an IDR', () => {
    const [sps, pps, idr] = scanNalUnits(fixture);
    assert.ok(sps && pps && idr);
    assert.deepEqual([sps.type, pps.type, idr.type], [NAL_SPS, NAL_PPS, NAL_SLICE_IDR]);
    assert.equal(sps.end - sps.start, FIXTURE.spsByteLength);
    assert.equal(pps.end - pps.start, FIXTURE.ppsByteLength);
  });

  it('treats a 4-byte start code as a 3-byte one with a leading zero_byte', () => {
    // 00 00 00 01 09 10 | 00 00 01 67 42
    const buf = Uint8Array.of(0, 0, 0, 1, 9, 0x10, 0, 0, 1, 0x67, 0x42);
    const nals = scanNalUnits(buf);
    assert.equal(nals.length, 2);
    assert.deepEqual([nals[0]?.type, nals[1]?.type], [9, 7]);
    // The zero_byte of the second start code must not land in the first NAL.
    assert.equal(nals[0]?.end, 6);
  });

  it('ignores leading padding before the first start code', () => {
    const buf = Uint8Array.of(0, 0, 0, 0, 0, 1, 0x65, 0x88);
    const nals = scanNalUnits(buf);
    assert.equal(nals.length, 1);
    assert.equal(nals[0]?.type, NAL_SLICE_IDR);
  });
});

describe('startsAccessUnit', () => {
  it('is true when first_mb_in_slice is 0', () => {
    // ue(v) of 0 is the single bit 1, so the top bit of byte 1 is set.
    assert.equal(startsAccessUnit(Uint8Array.of(0x65, 0x88)), true);
  });

  it('is false for a continuation slice', () => {
    // Any ue(v) > 0 starts with at least one 0 bit.
    assert.equal(startsAccessUnit(Uint8Array.of(0x65, 0x40)), false);
  });

  it('is false for a NAL too short to hold a slice header', () => {
    assert.equal(startsAccessUnit(Uint8Array.of(0x65)), false);
  });
});

describe('AnnexBDemuxer', () => {
  it('splits the fixture into the measured number of access units', () => {
    const aus = demux([fixture]);
    assert.equal(aus.length, FIXTURE.accessUnitCount);
  });

  it('marks exactly the IDR unit as a key frame', () => {
    const aus = demux([fixture]);
    const keys = aus.flatMap((au, i) => (au.key ? [i] : []));
    assert.deepEqual(keys, FIXTURE.keyIndices);
  });

  it('reassembles byte-identically to the source stream', () => {
    // The fixture already carries SPS+PPS ahead of its only IDR, so nothing is
    // injected and the concatenation must be exact. This is the assertion that
    // catches a demuxer silently dropping or duplicating bytes.
    const aus = demux([fixture]);
    assert.deepEqual(concat(aus.map((a) => a.data)), fixture);
  });

  // The live path never sees the stream in one piece: the pipe hands us
  // whatever the kernel had. Chunk boundaries landing inside a start code are
  // the obvious way to corrupt the output, so sweep the awkward sizes.
  for (const sizes of [[1], [2], [3], [4], [7], [1, 1, 2, 3, 5, 8, 13], [65536], [4096, 1, 9999]]) {
    it(`produces identical output when fed in chunks of ${sizes.join('/')}`, () => {
      const aus = demux(chunked(fixture, sizes));
      assert.equal(aus.length, FIXTURE.accessUnitCount);
      assert.deepEqual(concat(aus.map((a) => a.data)), fixture);
    });
  }

  it('splits on first_mb_in_slice even when slices share a picture', () => {
    const sps = Uint8Array.of(0x67, 0x64, 0x00, 0x20, 0xac);
    const pps = Uint8Array.of(0x68, 0xee, 0x0d, 0x8b);
    const idr = Uint8Array.of(0x65, 0x88, 0x01);
    const idrSlice2 = Uint8Array.of(0x65, 0x40, 0x02); // first_mb_in_slice > 0
    const p1 = Uint8Array.of(0x41, 0x9a, 0x03);
    const p2 = Uint8Array.of(0x41, 0x9a, 0x04);

    const aus = demux([withStartCodes([sps, pps, idr, idrSlice2, p1, p2])]);
    assert.equal(aus.length, 3);
    assert.deepEqual(
      aus.map((a) => a.key),
      [true, false, false],
    );
    // The two slices of the IDR picture stay in one access unit.
    assert.deepEqual(aus[0]?.data, withStartCodes([sps, pps, idr, idrSlice2]));
  });

  it('prepends cached SPS and PPS to a key unit that lacks them', () => {
    const sps = Uint8Array.of(0x67, 0x64, 0x00, 0x20, 0xac);
    const pps = Uint8Array.of(0x68, 0xee, 0x0d, 0x8b);
    const idr1 = Uint8Array.of(0x65, 0x88, 0x01);
    const p = Uint8Array.of(0x41, 0x9a, 0x02);
    // The second IDR arrives bare, exactly as a long-running encoder sends it.
    const idr2 = Uint8Array.of(0x65, 0x88, 0x03);

    const aus = demux([withStartCodes([sps, pps, idr1, p, idr2])]);
    assert.equal(aus.length, 3);
    const last = aus[2];
    assert.ok(last?.key);
    const nals = scanNalUnits(last.data);
    assert.deepEqual(
      nals.map((n) => n.type),
      [NAL_SPS, NAL_PPS, NAL_SLICE_IDR],
      'a late joiner must be able to decode from any key unit alone',
    );
  });

  it('does not touch a non-key unit', () => {
    const sps = Uint8Array.of(0x67, 0x64, 0x00, 0x20, 0xac);
    const pps = Uint8Array.of(0x68, 0xee, 0x0d, 0x8b);
    const idr = Uint8Array.of(0x65, 0x88, 0x01);
    const p = Uint8Array.of(0x41, 0x9a, 0x02);
    const aus = demux([withStartCodes([sps, pps, idr, p])]);
    assert.deepEqual(aus[1]?.data, withStartCodes([p]));
  });

  it('exposes the parameter sets for seeding a late joiner', () => {
    const d = new AnnexBDemuxer();
    assert.equal(d.parameterSets, undefined);
    d.push(fixture.subarray(0, 4096));
    const sets = d.parameterSets;
    assert.ok(sets);
    assert.deepEqual(
      scanNalUnits(sets).map((n) => n.type),
      [NAL_SPS, NAL_PPS],
    );
    assert.equal(d.sps?.length, FIXTURE.spsByteLength);
    assert.equal(d.pps?.length, FIXTURE.ppsByteLength);
  });

  it('forgets everything on reset, because a restart can change the SPS', () => {
    const d = new AnnexBDemuxer();
    d.push(fixture.subarray(0, 4096));
    assert.ok(d.sps);
    d.reset();
    assert.equal(d.sps, undefined);
    assert.equal(d.pps, undefined);
    assert.equal(d.parameterSets, undefined);
    // And it still works afterwards.
    const aus = [...d.push(fixture), ...d.flush()];
    assert.equal(aus.length, FIXTURE.accessUnitCount);
  });

  it('emits nothing for a stream that never reaches a second NAL', () => {
    const d = new AnnexBDemuxer();
    assert.deepEqual(d.push(Uint8Array.of(0, 0, 0, 1, 0x67, 0x64)), []);
  });

  it('survives an empty chunk', () => {
    const d = new AnnexBDemuxer();
    assert.deepEqual(d.push(new Uint8Array(0)), []);
    const aus = [...d.push(fixture), ...d.flush()];
    assert.equal(aus.length, FIXTURE.accessUnitCount);
  });

  it('keeps memory bounded while a NAL spans many chunks', () => {
    // A 1 MB NAL delivered 1 KB at a time must not make the demuxer re-scan
    // what it already examined; this would take minutes if it were quadratic.
    const big = new Uint8Array(1 << 20);
    big.set([0, 0, 0, 1, 0x65, 0x88], 0);
    big.fill(0x42, 6);
    const d = new AnnexBDemuxer();
    const started = Date.now();
    for (const c of chunked(big, [1024])) d.push(c);
    assert.ok(Date.now() - started < 2000, 'demuxer scan is not linear');
    assert.equal(d.flush().length, 1);
  });
});

describe('withStartCodes', () => {
  it('normalises to 4-byte start codes', () => {
    const out = withStartCodes([Uint8Array.of(0x67, 0x01), Uint8Array.of(0x68, 0x02)]);
    assert.deepEqual(out, Uint8Array.of(0, 0, 0, 1, 0x67, 0x01, 0, 0, 0, 1, 0x68, 0x02));
  });
});

describe('nalType', () => {
  it('masks off the nal_ref_idc bits', () => {
    assert.equal(nalType(Uint8Array.of(0x65)), 5);
    assert.equal(nalType(Uint8Array.of(0x41)), 1);
    assert.equal(nalType(Uint8Array.of(0x67)), 7);
  });
});
