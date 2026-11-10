import * as vscode from 'vscode';

import type { KeyMessage, PointerMessage, ScrollMessage } from '../../../common/protocol.js';
import type { AdbClient } from '../../adb/AdbClient.js';
import type { DisplayGeometry } from '../../adb/DisplayWatcher.js';
import { PersistentShell } from '../../adb/PersistentShell.js';
import type { ScopedLogger } from '../../log.js';
import type { InputSink } from '../InputSink.js';

/** `input` spawns an app_process per call, so one command at a time is the budget. */
const COMMAND_TIMEOUT_MS = 4000;

/**
 * Swipe velocity for a scroll, in device pixels per millisecond.
 *
 * The duration is derived from the distance rather than fixed, because
 * `input swipe` ends in a fling whose momentum comes from the speed of its last
 * segment. A constant duration means a coalesced swipe -- which is longer --
 * also flies faster, and the extra fling distance compounds across swipes.
 */
const SCROLL_SPEED_PX_PER_MS = 4;

/** Bounds on the derived duration: long enough to track, short enough to feel live. */
const SCROLL_MIN_MS = 60;
const SCROLL_MAX_MS = 250;

/**
 * Shortest scroll worth sending, in device pixels.
 *
 * Below `ViewConfiguration`'s touch slop -- 8 dp, so ~23 px at the reference
 * device's 2.8125 density -- a DOWN and an UP at nearly the same place *is* a
 * click, whatever we meant by it. A fine-grained wheel notch is a few pixels,
 * so sending one immediately taps whatever is under the pointer: the user
 * scrolls and opens a link. Short deltas are therefore kept, not sent, until
 * they add up to something a finger could not have meant as a tap.
 */
const SCROLL_MIN_PX = 48;

/** Just enough of `DisplayWatcher` to map coordinates; keeps this testable. */
export interface GeometrySource {
  readonly geometry: DisplayGeometry | undefined;
}

/**
 * Delivers input through `adb shell input`.
 *
 * This is the phase 1 sink, and its limits are the `input` tool's, not ours:
 *
 *  - **Single pointer.** `input motionevent` takes no pointer id, so there is
 *    no way to express a second finger. Non-primary pointers are dropped
 *    rather than merged, which would otherwise make a pinch jump the cursor
 *    between fingers. Real multi-touch is the main reason phase 2 exists.
 *  - **No meta state.** `input keyevent` has no modifier argument. It costs
 *    little: printable characters arrive as text, so the only losses are
 *    shortcuts built on named keys.
 *  - **~80-150 ms per command**, because each one is a fresh app_process. A
 *    60 Hz move stream would queue without bound, so moves are coalesced
 *    newest-wins while down/up are never dropped -- losing an `up` would leave
 *    the device believing a finger is still on the glass. Scrolls coalesce too,
 *    but by summing: a trackpad emits a wheel event every ~10 ms and keeps
 *    sending momentum for about a second after the fingers lift, so a single
 *    gesture is a hundred events that must become one swipe of their combined
 *    distance. Queued, they outlive the gesture by tens of seconds, and since
 *    every `input swipe` flings, the content accelerates with nothing able to
 *    stop it. The sum is also held back until it clears the touch slop, because
 *    a swipe shorter than that is a click -- so a fine-grained scroll would
 *    otherwise open whatever is under the pointer.
 *  - **No shared downTime.** Each `input` invocation stamps its event with its
 *    own `uptimeMillis`, so a drag's MOVEs do not look like continuations of
 *    their DOWN to anything measuring velocity. Taps and drags land; flings and
 *    long-press timing are approximate.
 */
export class AdbInputSink implements InputSink {
  readonly name = 'adb-input';

  readonly #log: ScopedLogger;
  readonly #client: AdbClient;
  readonly #serial: string;
  readonly #geometry: GeometrySource;
  readonly #shell: PersistentShell;
  readonly #latencyEmitter = new vscode.EventEmitter<number>();

  /** Commands that must all run, in order: downs, ups, keys, text. */
  #queue: string[] = [];
  /** The single most recent move, replaced rather than queued. */
  #pendingMove: string | undefined;
  /** Scroll distance not yet sent, in device pixels, from the latest anchor. */
  #pendingScroll: { x: number; y: number; dx: number; dy: number } | undefined;
  #inFlight = false;
  #down = false;
  #disposed = false;
  #showTouchesRestore: string | undefined;

  readonly onDidMeasureLatency = this.#latencyEmitter.event;

  constructor(
    log: ScopedLogger,
    client: AdbClient,
    serial: string,
    geometry: GeometrySource,
  ) {
    this.#log = log;
    this.#client = client;
    this.#serial = serial;
    this.#geometry = geometry;
    this.#shell = new PersistentShell(client, serial, log.child('input-shell'));
  }

  /**
   * Turns on the device's "show taps" setting, remembering the old value.
   *
   * Read-then-restore rather than blind set-and-clear: this is a setting the
   * user may already have on for their own debugging, and silently turning it
   * off when a mirror closes would be a surprising side effect.
   */
  async setShowTouches(enabled: boolean): Promise<void> {
    if (!enabled || this.#disposed) return;
    try {
      const current = (await this.#shell.exec('settings get system show_touches', 5000)).trim();
      this.#showTouchesRestore = current === '' || current === 'null' ? '0' : current;
      if (this.#showTouchesRestore !== '1') {
        await this.#shell.exec('settings put system show_touches 1', 5000);
      }
    } catch (err) {
      this.#log.debug(`could not set show_touches: ${String(err)}`);
      this.#showTouchesRestore = undefined;
    }
  }

  pointer(event: PointerMessage): void {
    // Non-primary pointers have nowhere to go; see the class comment.
    if (event.pointerId !== 0) return;
    const point = this.#toDevice(event.x, event.y);
    if (!point) return;

    switch (event.action) {
      case 'down':
        this.#down = true;
        this.#push(`input motionevent DOWN ${point.x} ${point.y}`);
        break;
      case 'move':
        // A move without a down is a hover, which the touchscreen has no
        // concept of; sending it would plant a phantom finger.
        if (this.#down) this.#pushMove(`input motionevent MOVE ${point.x} ${point.y}`);
        break;
      case 'up':
        if (!this.#down) return;
        this.#down = false;
        this.#push(`input motionevent UP ${point.x} ${point.y}`);
        break;
      case 'cancel':
        if (!this.#down) return;
        this.#down = false;
        this.#push(`input motionevent CANCEL ${point.x} ${point.y}`);
        break;
    }
  }

  scroll(event: ScrollMessage): void {
    if (this.#disposed) return;
    const geometry = this.#geometry.geometry;
    const from = this.#toDevice(event.x, event.y);
    if (!geometry || !from) return;
    const dx = event.dx * geometry.width;
    const dy = event.dy * geometry.height;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    // Summed, not newest-wins: the gesture's total distance is the thing the
    // user expressed, and a hundred notches each worth a few pixels would
    // otherwise collapse into one of them. The anchor is the latest, which is
    // where the pointer actually is.
    const previous = this.#pendingScroll;
    this.#pendingScroll = {
      x: from.x,
      y: from.y,
      dx: (previous?.dx ?? 0) + dx,
      dy: (previous?.dy ?? 0) + dy,
    };
    void this.#drain();
  }

  key(event: KeyMessage): void {
    if (!Number.isInteger(event.keyCode) || event.keyCode <= 0) return;
    this.#push(`input keyevent ${event.keyCode}`);
  }

  text(text: string): void {
    if (text === '') return;
    if (/[^\x20-\x7e]/.test(text)) {
      // `input text` is ASCII-only in practice. Say so rather than send
      // something that silently types the wrong thing.
      this.#log.debug('dropping non-ASCII text; adb input cannot type it');
      return;
    }
    this.#push(`input text ${shellQuote(text)}`);
  }

  /** Maps normalised stream coordinates onto the rotated logical display. */
  #toDevice(x: number, y: number): { x: number; y: number } | undefined {
    const geometry = this.#geometry.geometry;
    if (!geometry) {
      this.#log.debug('dropping input: the display geometry is not known yet');
      return undefined;
    }
    return {
      x: clamp(Math.round(x * (geometry.width - 1)), 0, geometry.width - 1),
      y: clamp(Math.round(y * (geometry.height - 1)), 0, geometry.height - 1),
    };
  }

  #push(command: string): void {
    if (this.#disposed) return;
    // Any ordered command supersedes a queued move: the move was heading to a
    // position this command already accounts for. A pending scroll is *not*
    // dropped -- a keystroke arriving mid-gesture has nothing to say about the
    // distance the wheel has travelled, so discarding it would just lose scroll.
    this.#pendingMove = undefined;
    this.#queue.push(command);
    void this.#drain();
  }

  /**
   * Turns the accumulated scroll delta into one swipe, and clears it.
   *
   * Returns undefined while the delta is still shorter than the touch slop, in
   * which case it is **kept**: the next event adds to it rather than starting
   * over, so a slow scroll arrives late but whole, and never as a tap.
   */
  #takeScrollCommand(): string | undefined {
    const pending = this.#pendingScroll;
    const geometry = this.#geometry.geometry;
    if (!pending || !geometry) return undefined;
    // Measured before clamping, so an anchor near the edge cannot leave the
    // delta growing for ever against a target that never moves.
    if (Math.hypot(pending.dx, pending.dy) < SCROLL_MIN_PX) return undefined;
    this.#pendingScroll = undefined;

    // Positive deltas mean the content moves up/left, which is a finger moving
    // the same way -- so the swipe ends at a smaller coordinate.
    const to = {
      x: clamp(Math.round(pending.x - pending.dx), 0, geometry.width - 1),
      y: clamp(Math.round(pending.y - pending.dy), 0, geometry.height - 1),
    };
    const distance = Math.hypot(to.x - pending.x, to.y - pending.y);
    // Clamping can shorten the swipe back under the slop when the pointer is
    // right at the edge. Sending it would be a tap on whatever is there.
    if (distance < SCROLL_MIN_PX) return undefined;
    const duration = clamp(
      Math.round(distance / SCROLL_SPEED_PX_PER_MS),
      SCROLL_MIN_MS,
      SCROLL_MAX_MS,
    );
    return `input swipe ${pending.x} ${pending.y} ${to.x} ${to.y} ${duration}`;
  }

  #pushMove(command: string): void {
    if (this.#disposed) return;
    this.#pendingMove = command;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#inFlight || this.#disposed) return;
    // Ordered commands first -- a tap must not wait behind a scroll's tail --
    // then the coalesced scroll, then the coalesced move.
    let command: string | undefined;
    if (this.#queue.length > 0) {
      command = this.#queue.shift();
    } else {
      command = this.#takeScrollCommand();
      if (command === undefined) {
        command = this.#pendingMove;
        this.#pendingMove = undefined;
      }
    }
    if (command === undefined) return;

    this.#inFlight = true;
    const started = Date.now();
    try {
      await this.#shell.exec(command, COMMAND_TIMEOUT_MS);
      // Host dispatch to device acknowledgement. It is not the full
      // glass-to-pixel round trip -- nothing echoes that -- but it is the term
      // that phase 2 exists to shrink, so it is the one worth showing.
      this.#latencyEmitter.fire(Date.now() - started);
    } catch (err) {
      this.#log.debug(`input command failed: ${String(err)}`);
    } finally {
      this.#inFlight = false;
    }
    void this.#drain();
  }

  dispose(): void {
    this.#disposed = true;
    this.#queue = [];
    this.#pendingMove = undefined;
    this.#pendingScroll = undefined;
    // A session that ends mid-drag must lift the finger, or the device keeps
    // the touch and the next tap becomes a long-press.
    if (this.#down) void this.#shell.send('input motionevent UP 0 0');
    if (this.#showTouchesRestore !== undefined) {
      void this.#shell.send(`settings put system show_touches ${this.#showTouchesRestore}`);
      this.#showTouchesRestore = undefined;
    }
    // Give the two fire-and-forget writes a tick to reach the pipe before the
    // shell is torn down; they are best-effort either way.
    setTimeout(() => this.#shell.dispose(), 150);
    this.#latencyEmitter.dispose();
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * POSIX single-quoting.
 *
 * `PersistentShell.exec` writes to a real shell's stdin, so this is the one
 * place in the extension where an argument *is* shell-interpreted. Text comes
 * from the webview, i.e. from a keyboard, so it has to be quoted rather than
 * trusted.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
