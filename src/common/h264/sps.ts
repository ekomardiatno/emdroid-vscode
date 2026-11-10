/**
 * Minimal H.264 SPS parser: enough for the codec string and the coded picture
 * size, nothing more.
 *
 * Why this exists rather than a hardcoded `avc1.42E01E`: the SPS **varies with
 * capture size**. The same device produced `avc1.640020` (High, level 3.2) at
 * 540x1200 and `avc1.64002A` (level 4.2) at a larger size. A hardcoded codec
 * string fails `VideoDecoder.configure()` on one of them, so it has to be read
 * from the bytes at runtime.
 *
 * The size matters for the same reason: it changes on rotation, and the encoder
 * aligns to macroblocks, so the real coded size is rarely exactly what was
 * asked for on the command line.
 */

export interface SpsInfo {
  readonly profileIdc: number;
  readonly constraintFlags: number;
  readonly levelIdc: number;
  /** e.g. `avc1.640020`. */
  readonly codecString: string;
  /** Display size after frame cropping. */
  readonly width: number;
  readonly height: number;
}

/**
 * `avc1.PPCCLL` from SPS bytes 1-3, where byte 0 is the NAL header (0x67).
 *
 * These three bytes are before any emulation-prevention byte can appear (that
 * needs two preceding zeros), so they can be read raw.
 */
export function codecStringFromSps(sps: Uint8Array): string {
  if (sps.length < 4) throw new Error(`SPS too short: ${sps.length} bytes`);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1] as number)}${hex(sps[2] as number)}${hex(sps[3] as number)}`;
}

/**
 * Strips emulation-prevention bytes: within a NAL, an encoder inserts 0x03
 * after any `00 00` that would otherwise look like a start code. The bit reader
 * must not see those.
 */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i] as number;
    if (zeros === 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

class BitReader {
  #buf: Uint8Array;
  #bit = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
  }

  u1(): number {
    const byte = this.#buf[this.#bit >> 3];
    if (byte === undefined) throw new Error('SPS truncated');
    const v = (byte >> (7 - (this.#bit & 7))) & 1;
    this.#bit++;
    return v;
  }

  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.u1();
    return v >>> 0;
  }

  /** Unsigned exp-Golomb. */
  ue(): number {
    let lead = 0;
    while (this.u1() === 0) {
      lead++;
      // A conformant SPS never has a 32-bit prefix; this guards a corrupt one
      // from spinning until the buffer runs out.
      if (lead > 32) throw new Error('SPS: exp-Golomb prefix too long');
    }
    if (lead === 0) return 0;
    return (1 << lead) - 1 + this.u(lead);
  }

  /** Signed exp-Golomb. */
  se(): number {
    const k = this.ue();
    const sign = k & 1 ? 1 : -1;
    return sign * Math.ceil(k / 2);
  }
}

/** Profiles that carry the extra chroma/scaling-matrix block in the SPS. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * @param sps SPS NAL payload **including** the 0x67 header byte, no start code.
 */
export function parseSps(sps: Uint8Array): SpsInfo {
  const codecString = codecStringFromSps(sps);
  const profileIdc = sps[1] as number;
  const constraintFlags = sps[2] as number;
  const levelIdc = sps[3] as number;

  const r = new BitReader(unescapeRbsp(sps.subarray(4)));

  r.ue(); // seq_parameter_set_id

  let chromaFormatIdc = 1; // 4:2:0 unless stated otherwise
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.u1(); // separate_colour_plane_flag
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.u1(); // qpprime_y_zero_transform_bypass_flag
    if (r.u1() === 1) skipScalingMatrix(r, chromaFormatIdc);
  }

  r.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = r.ue();
  if (picOrderCntType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    r.u1(); // delta_pic_order_always_zero_flag
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }

  r.ue(); // max_num_ref_frames
  r.u1(); // gaps_in_frame_num_value_allowed_flag

  const picWidthInMbsMinus1 = r.ue();
  const picHeightInMapUnitsMinus1 = r.ue();
  const frameMbsOnlyFlag = r.u1();
  if (frameMbsOnlyFlag === 0) r.u1(); // mb_adaptive_frame_field_flag
  r.u1(); // direct_8x8_inference_flag

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (r.u1() === 1) {
    cropLeft = r.ue();
    cropRight = r.ue();
    cropTop = r.ue();
    cropBottom = r.ue();
  }

  // Crop offsets are in chroma samples horizontally and in
  // chroma-samples * (2 - frame_mbs_only_flag) vertically.
  const subWidthC = chromaFormatIdc === 3 ? 1 : 2;
  const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
  const cropUnitX = chromaFormatIdc === 0 ? 1 : subWidthC;
  const cropUnitY = (chromaFormatIdc === 0 ? 1 : subHeightC) * (2 - frameMbsOnlyFlag);

  const width = (picWidthInMbsMinus1 + 1) * 16 - cropUnitX * (cropLeft + cropRight);
  const height =
    (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - cropUnitY * (cropTop + cropBottom);

  return { profileIdc, constraintFlags, levelIdc, codecString, width, height };
}

function skipScalingMatrix(r: BitReader, chromaFormatIdc: number): void {
  const count = chromaFormatIdc !== 3 ? 8 : 12;
  for (let i = 0; i < count; i++) {
    if (r.u1() === 0) continue;
    const size = i < 6 ? 16 : 64;
    let lastScale = 8;
    let nextScale = 8;
    for (let j = 0; j < size; j++) {
      if (nextScale !== 0) {
        const delta = r.se();
        nextScale = (lastScale + delta + 256) % 256;
      }
      lastScale = nextScale === 0 ? lastScale : nextScale;
    }
  }
}
