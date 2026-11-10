/**
 * Annex B byte-stream -> access units.
 *
 * `screenrecord --output-format=h264` hands us a raw Annex B elementary stream
 * with **no AUD (type 9) and no SEI (type 6) NALs** -- measured on a real
 * device, histogram `{1: 254, 5: 1, 7: 1, 8: 1}`. So there is no delimiter to
 * split on and we have to do it the standard way: a new access unit begins at a
 * VCL NAL whose `first_mb_in_slice` is 0.
 *
 * `first_mb_in_slice` is the first ue(v) of the slice header, i.e. the first
 * bits of the byte after the NAL header. A leading 1 bit means the value is 0,
 * so the whole test is `(nal[1] & 0x80) !== 0`.
 *
 * This runs in the **extension host**, not the webview, so that swapping in the
 * scrcpy source (which frames packets itself and needs no parser at all) is a
 * drop-in change the webview never sees.
 */

export const NAL_SLICE_NON_IDR = 1;
export const NAL_SLICE_IDR = 5;
export const NAL_SEI = 6;
export const NAL_SPS = 7;
export const NAL_PPS = 8;
export const NAL_AUD = 9;

/** A complete access unit, ready to become one EncodedVideoChunk. */
export interface DemuxedAccessUnit {
  /** Annex B with 4-byte start codes; key units always carry SPS+PPS. */
  readonly data: Uint8Array;
  readonly key: boolean;
}

export interface ScannedNal {
  /** Offset of the first byte of the NAL payload (the header byte). */
  readonly start: number;
  /** Offset one past the last payload byte, trailing zero padding removed. */
  readonly end: number;
  readonly type: number;
}

export function nalType(payload: Uint8Array): number {
  return (payload[0] ?? 0) & 0x1f;
}

export function isVcl(type: number): boolean {
  return type >= NAL_SLICE_NON_IDR && type <= NAL_SLICE_IDR;
}

/**
 * True when this VCL NAL starts a new picture. Only meaningful for VCL types.
 * A NAL shorter than 2 bytes cannot carry a slice header, so it cannot start
 * an access unit.
 */
export function startsAccessUnit(payload: Uint8Array): boolean {
  return payload.length >= 2 && ((payload[1] as number) & 0x80) !== 0;
}

/**
 * One-shot scan of a complete buffer. Used by tests and diagnostics; the live
 * path uses `AnnexBDemuxer`, which is incremental.
 *
 * Only the 3-byte code `00 00 01` is searched for. A 4-byte code is just that
 * with a `zero_byte` in front, and because the previous NAL's trailing zeros
 * are trimmed, both forms -- and any amount of leading padding -- fall out
 * correctly without a second case.
 */
export function scanNalUnits(buf: Uint8Array): ScannedNal[] {
  const out: ScannedNal[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) pushNal(out, buf, start, trimTrailingZeros(buf, start, i));
      start = i + 3;
      i = start;
    } else {
      i++;
    }
  }
  if (start >= 0) pushNal(out, buf, start, trimTrailingZeros(buf, start, buf.length));
  return out;
}

function pushNal(out: ScannedNal[], buf: Uint8Array, start: number, end: number): void {
  if (end > start) out.push({ start, end, type: (buf[start] as number) & 0x1f });
}

/**
 * Annex B permits `trailing_zero_8bits` after a NAL, and a 4-byte start code
 * contributes one such zero. rbsp_trailing_bits() guarantees the real last byte
 * is non-zero, so trimming zeros is unambiguous.
 */
function trimTrailingZeros(buf: Uint8Array, start: number, end: number): number {
  let e = end;
  while (e > start && buf[e - 1] === 0) e--;
  return e;
}

const FOUR_BYTE_START = Uint8Array.of(0, 0, 0, 1);

/** Joins NAL payloads into an Annex B buffer with normalised 4-byte start codes. */
export function withStartCodes(nals: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const n of nals) total += FOUR_BYTE_START.length + n.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const n of nals) {
    out.set(FOUR_BYTE_START, o);
    o += FOUR_BYTE_START.length;
    out.set(n, o);
    o += n.length;
  }
  return out;
}

/**
 * Incremental Annex B demuxer.
 *
 * Feed it whatever chunks the pipe produces; it emits only *complete* access
 * units. A NAL is complete only once the next start code is seen, so there is
 * always exactly one unit of latency -- which is correct and unavoidable for a
 * delimiter-free byte stream.
 */
export class AnnexBDemuxer {
  /** Scratch buffer holding the bytes of the NAL currently being accumulated. */
  #buf = new Uint8Array(1 << 16);
  #len = 0;
  /** Next index to examine for a start code; never rewinds past a found NAL. */
  #scan = 0;
  /** Payload offset of the NAL being accumulated, or -1 before the first code. */
  #nalStart = -1;

  #pending: Uint8Array[] = [];
  #hasVcl = false;
  #sps: Uint8Array | undefined;
  #pps: Uint8Array | undefined;

  /** Most recent SPS payload (no start code), or undefined before the first one. */
  get sps(): Uint8Array | undefined {
    return this.#sps;
  }

  get pps(): Uint8Array | undefined {
    return this.#pps;
  }

  /**
   * SPS+PPS as an Annex B buffer, for seeding a late joiner before the next
   * key frame arrives. Undefined until both have been seen.
   */
  get parameterSets(): Uint8Array | undefined {
    if (!this.#sps || !this.#pps) return undefined;
    return withStartCodes([this.#sps, this.#pps]);
  }

  /** Drops all state. Call between recorder restarts -- the SPS may change. */
  reset(): void {
    this.#len = 0;
    this.#scan = 0;
    this.#nalStart = -1;
    this.#pending = [];
    this.#hasVcl = false;
    this.#sps = undefined;
    this.#pps = undefined;
  }

  push(chunk: Uint8Array): DemuxedAccessUnit[] {
    this.#append(chunk);
    const out: DemuxedAccessUnit[] = [];

    let i = this.#scan;
    const buf = this.#buf;
    const len = this.#len;
    while (i + 2 < len) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        if (this.#nalStart >= 0) {
          this.#completeNal(this.#nalStart, trimTrailingZeros(buf, this.#nalStart, i), out);
        }
        this.#nalStart = i + 3;
        i = this.#nalStart;
      } else {
        i++;
      }
    }

    // Every position below `len - 2` has now been tested, so resume there and
    // keep the last two bytes re-examinable -- a start code can straddle
    // chunks. Resuming at `#nalStart` instead would re-scan the body of a NAL
    // that spans many chunks on every push, which is quadratic.
    this.#scan = Math.max(0, len - 2);
    this.#compact();
    return out;
  }

  /**
   * Closes the stream and emits any buffered access unit.
   *
   * Only safe at a clean end of stream. A recorder killed mid-NAL leaves a
   * truncated final unit, which is why `ScreenrecordFrameSource` discards the
   * tail instead of flushing on an abnormal exit.
   */
  flush(): DemuxedAccessUnit[] {
    const out: DemuxedAccessUnit[] = [];
    if (this.#nalStart >= 0) {
      this.#completeNal(this.#nalStart, trimTrailingZeros(this.#buf, this.#nalStart, this.#len), out);
      this.#nalStart = -1;
    }
    if (this.#hasVcl) this.#emit(out);
    this.#len = 0;
    this.#scan = 0;
    return out;
  }

  #completeNal(start: number, end: number, out: DemuxedAccessUnit[]): void {
    if (end <= start) return;
    // Copy: #compact() shifts the scratch buffer, which would invalidate a view.
    const payload = this.#buf.slice(start, end);
    const type = nalType(payload);

    if (isVcl(type)) {
      if (this.#hasVcl && startsAccessUnit(payload)) this.#emit(out);
    } else if (type === NAL_SPS || type === NAL_PPS || type === NAL_SEI || type === NAL_AUD) {
      // A parameter set or delimiter after slice data belongs to the next unit.
      if (this.#hasVcl) this.#emit(out);
    }

    if (type === NAL_SPS) this.#sps = payload;
    else if (type === NAL_PPS) this.#pps = payload;

    this.#pending.push(payload);
    if (isVcl(type)) this.#hasVcl = true;
  }

  #emit(out: DemuxedAccessUnit[]): void {
    const pending = this.#pending;
    this.#pending = [];
    this.#hasVcl = false;
    if (pending.length === 0) return;

    let key = false;
    let hasSps = false;
    let hasPps = false;
    for (const n of pending) {
      const t = nalType(n);
      if (t === NAL_SLICE_IDR) key = true;
      else if (t === NAL_SPS) hasSps = true;
      else if (t === NAL_PPS) hasPps = true;
    }

    // Every key unit must be a self-contained random-access point: the measured
    // IDR interval is ~10s, so a late joiner that misses the stream's one
    // leading SPS/PPS would otherwise sit blank. ~30 bytes per key frame.
    let nals: readonly Uint8Array[] = pending;
    if (key && (!hasSps || !hasPps)) {
      const prefix: Uint8Array[] = [];
      if (!hasSps && this.#sps) prefix.push(this.#sps);
      if (!hasPps && this.#pps) prefix.push(this.#pps);
      if (prefix.length > 0) nals = [...prefix, ...pending];
    }

    out.push({ data: withStartCodes(nals), key });
  }

  #append(chunk: Uint8Array): void {
    const needed = this.#len + chunk.length;
    if (needed > this.#buf.length) {
      let size = this.#buf.length;
      while (size < needed) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.#buf.subarray(0, this.#len));
      this.#buf = next;
    }
    this.#buf.set(chunk, this.#len);
    this.#len = needed;
  }

  /** Shifts out bytes that can never be part of a future NAL. */
  #compact(): void {
    const drop = this.#nalStart < 0 ? Math.max(0, this.#len - 2) : this.#nalStart;
    if (drop <= 0) return;
    this.#buf.copyWithin(0, drop, this.#len);
    this.#len -= drop;
    this.#scan = Math.max(0, this.#scan - drop);
    this.#nalStart = this.#nalStart < 0 ? -1 : this.#nalStart - drop;
  }
}
