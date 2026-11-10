import type { StillMessage } from '../../common/protocol.js';

/**
 * Degraded mode: paint base64 PNGs instead of decoding video.
 *
 * This exists for the case where `VideoDecoder` is unavailable -- an older
 * browser pointed at code-server, or a Chromium build without the hardware
 * decoder. Measured on a real device, `screencap -p` costs 2.6 s for 2.3 MB,
 * so this is about **0.4 fps**. That is not a slow mirror, it is *controllable
 * stills*: the picture crawls but every tap still lands, which is what makes it
 * worth having rather than showing an error.
 */
export class StillPipeline {
  readonly #draw: (bitmap: ImageBitmap) => void;
  #busy = false;

  constructor(draw: (bitmap: ImageBitmap) => void) {
    this.#draw = draw;
  }

  /** Decodes and paints. Overlapping stills are dropped, newest wins. */
  async present(message: StillMessage): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      // Decoded by hand rather than via `fetch('data:…')`, because a data URL
      // fetch is governed by `connect-src`, which names only the stream origin.
      const bitmap = await createImageBitmap(
        new Blob([base64ToBuffer(message.png)], { type: 'image/png' }),
      );
      try {
        this.#draw(bitmap);
      } finally {
        bitmap.close();
      }
    } finally {
      this.#busy = false;
    }
  }
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
