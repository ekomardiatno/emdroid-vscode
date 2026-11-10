/**
 * Paints decoded frames, and -- more importantly -- closes every one of them.
 *
 * `VideoFrame` holds a GPU buffer from a small pool. Chromium's decoder stalls
 * **permanently** after a handful of leaked frames, with no error and no event:
 * output simply stops. So the invariant here is that a frame is closed on every
 * path out of this class, including the one where it is displaced by a newer
 * frame before it was ever drawn.
 *
 * Newest-wins is also the right policy for a mirror. If decoding briefly runs
 * ahead of the compositor, showing the most recent picture is strictly better
 * than working through a backlog that is already stale.
 */
export class CanvasRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;

  #pending: VideoFrame | undefined;
  #rafHandle: number | undefined;
  #painted = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('this browser has no 2D canvas context');
    this.#ctx = ctx;
  }

  /** Frames painted since the last `takePainted()`. Drives the fps readout. */
  takePainted(): number {
    const n = this.#painted;
    this.#painted = 0;
    return n;
  }

  present(frame: VideoFrame): void {
    // Displacing an undrawn frame: close it here or the pool drains.
    this.#pending?.close();
    this.#pending = frame;
    if (this.#rafHandle === undefined) {
      this.#rafHandle = requestAnimationFrame(() => this.#draw());
    }
  }

  #draw(): void {
    this.#rafHandle = undefined;
    const frame = this.#pending;
    this.#pending = undefined;
    if (!frame) return;

    try {
      // `displayWidth/Height` already accounts for the SPS cropping rectangle,
      // so a 540x1200 stream coded as 544x1200 paints without a green edge.
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      if (this.#canvas.width !== width || this.#canvas.height !== height) {
        this.#canvas.width = width;
        this.#canvas.height = height;
      }
      this.#ctx.drawImage(frame, 0, 0);
      this.#painted++;
    } finally {
      frame.close();
    }
  }

  /**
   * Drops anything queued without clearing what is on screen.
   *
   * Landmine 8: a stall must leave the last good picture visible. Blanking the
   * canvas on every recorder restart would turn a 600 ms hiccup into a flash
   * that reads as a crash.
   */
  reset(): void {
    this.#pending?.close();
    this.#pending = undefined;
    if (this.#rafHandle !== undefined) cancelAnimationFrame(this.#rafHandle);
    this.#rafHandle = undefined;
  }

  get size(): { width: number; height: number } {
    return { width: this.#canvas.width, height: this.#canvas.height };
  }
}
