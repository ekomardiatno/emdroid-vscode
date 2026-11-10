import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The committed capture: `screenrecord --output-format=h264 --time-limit 0
 * --bit-rate 2000000 --size 540x1200` from an SM-G996B (Android 15, SDK 35),
 * truncated at an access-unit boundary to keep it under half a megabyte.
 *
 * Every number the tests assert was measured from this exact file, so a change
 * here must be accompanied by a deliberate change to the expectations.
 */
export const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/sample-540x1200.h264', import.meta.url),
);

export function readFixture(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE_PATH));
}

/** Measured properties of the fixture. */
export const FIXTURE = {
  byteLength: 408851,
  nalCount: 42,
  /** NAL type -> count. Note: no AUD (9) and no SEI (6) -- that is the point. */
  nalHistogram: { 1: 39, 5: 1, 7: 1, 8: 1 } as Record<number, number>,
  accessUnitCount: 40,
  /** Indices of key access units. One IDR: the measured interval is ~10s. */
  keyIndices: [0],
  spsByteLength: 18,
  ppsByteLength: 4,
  codecString: 'avc1.640020',
  width: 540,
  height: 1200,
} as const;

/** Splits a buffer into chunks of the given sizes, cycling through them. */
export function chunked(buf: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let o = 0;
  let i = 0;
  while (o < buf.length) {
    const n = Math.min(sizes[i++ % sizes.length] as number, buf.length - o);
    out.push(buf.subarray(o, o + n));
    o += n;
  }
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
