import { type PointerAction, type PointerMessage, clampUnit } from '../../common/protocol.js';

/** The part of a `DOMRect` this module needs, so it is testable without a DOM. */
export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Converts a client-space point into **normalised 0..1 stream space**.
 *
 * Normalising here, rather than sending pixels, is what keeps the whole
 * webview ignorant of the capture size and of rotation. The canvas element is
 * sized from the decoded frame and scaled by CSS with its aspect ratio
 * preserved, so its bounding box *is* the picture -- no letterbox correction is
 * needed, and the mapping stays a plain linear one.
 *
 * Coordinates are clamped rather than rejected: a drag that slips off the edge
 * of the canvas should still land on the edge of the device, which is what a
 * real finger does.
 */
export function toStreamPoint(rect: RectLike, clientX: number, clientY: number): {
  x: number;
  y: number;
} {
  // A zero-sized rect means the canvas is not laid out yet. Returning the
  // centre is wrong in every direction equally, which beats NaN reaching adb.
  if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
  return {
    x: clampUnit((clientX - rect.left) / rect.width),
    y: clampUnit((clientY - rect.top) / rect.height),
  };
}

/** Highest pointer slot we track; Android's input stack is happy well below this. */
const MAX_POINTERS = 10;

/**
 * Tracks live pointers and assigns each a small, stable id.
 *
 * `PointerEvent.pointerId` is browser-assigned and can be any integer -- Chrome
 * increments it for the lifetime of the document. Android wants a dense index
 * per active touch, so the two have to be mapped rather than passed through.
 */
export class PointerMapper {
  readonly #slots = new Map<number, number>();

  /** Returns the message to send, or `undefined` when the event is not ours. */
  translate(
    action: PointerAction,
    rect: RectLike,
    event: { pointerId: number; clientX: number; clientY: number; pressure: number },
  ): PointerMessage | undefined {
    const slot = action === 'down' ? this.#allocate(event.pointerId) : this.#slots.get(event.pointerId);
    // A move or up for a pointer whose down we never saw (it began outside the
    // canvas, or arrived after a reset) has no slot and must not be forwarded:
    // Android would see a move for a finger that is not down.
    if (slot === undefined) return undefined;

    const point = toStreamPoint(rect, event.clientX, event.clientY);
    if (action === 'up' || action === 'cancel') this.#slots.delete(event.pointerId);

    return {
      t: 'pointer',
      action,
      pointerId: slot,
      x: point.x,
      y: point.y,
      // Browsers report 0 pressure for mouse and for some touch hardware, but
      // Android treats 0 as "not touching", so a down must have weight.
      pressure: action === 'up' || action === 'cancel' ? 0 : event.pressure > 0 ? event.pressure : 1,
      t0: performance.now(),
    };
  }

  #allocate(pointerId: number): number | undefined {
    const existing = this.#slots.get(pointerId);
    if (existing !== undefined) return existing;
    for (let slot = 0; slot < MAX_POINTERS; slot++) {
      if (![...this.#slots.values()].includes(slot)) {
        this.#slots.set(pointerId, slot);
        return slot;
      }
    }
    return undefined;
  }

  get active(): number {
    return this.#slots.size;
  }

  /** Called when the stream drops: every finger is implicitly lifted. */
  reset(): void {
    this.#slots.clear();
  }
}
