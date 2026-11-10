import * as vscode from 'vscode';

import type { KeyMessage, PointerMessage, ScrollMessage } from '../../../common/protocol.js';
import type { AdbClient } from '../../adb/AdbClient.js';
import type { DisplayGeometry } from '../../adb/DisplayWatcher.js';
import { PersistentShell } from '../../adb/PersistentShell.js';
import type { ScopedLogger } from '../../log.js';
import type { InputSink } from '../InputSink.js';

/** `input` spawns an app_process per call, so one command at a time is the budget. */
const COMMAND_TIMEOUT_MS = 4000;

/** Duration handed to `input swipe` for a wheel notch. */
const SCROLL_DURATION_MS = 120;

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
 *    the device believing a finger is still on the glass.
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
    const geometry = this.#geometry.geometry;
    const from = this.#toDevice(event.x, event.y);
    if (!geometry || !from) return;
    // Positive deltas mean the content moves up/left, which is a finger moving
    // the same way -- so the swipe ends at a smaller coordinate.
    const to = {
      x: clamp(Math.round(from.x - event.dx * geometry.width), 0, geometry.width - 1),
      y: clamp(Math.round(from.y - event.dy * geometry.height), 0, geometry.height - 1),
    };
    if (to.x === from.x && to.y === from.y) return;
    this.#push(`input swipe ${from.x} ${from.y} ${to.x} ${to.y} ${SCROLL_DURATION_MS}`);
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
    // position this command already accounts for.
    this.#pendingMove = undefined;
    this.#queue.push(command);
    void this.#drain();
  }

  #pushMove(command: string): void {
    if (this.#disposed) return;
    this.#pendingMove = command;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#inFlight || this.#disposed) return;
    let command: string | undefined;
    if (this.#queue.length > 0) {
      command = this.#queue.shift();
    } else {
      command = this.#pendingMove;
      this.#pendingMove = undefined;
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
