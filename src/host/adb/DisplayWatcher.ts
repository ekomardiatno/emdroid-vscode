import type { ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';

import type { ScopedLogger } from '../log.js';
import type { AdbClient } from './AdbClient.js';
import { parseRotation } from './parse.js';
import type { PersistentShell } from './PersistentShell.js';

export interface DisplayGeometry {
  /** Quarter turns clockwise: 0 = natural orientation. */
  readonly rotation: number;
  /**
   * Logical size **after** rotation. This is the coordinate space `input tap`
   * uses -- measured, not assumed: in landscape `screencap` returns 2400x1080
   * and `uiautomator` bounds are landscape-space, while `wm size` still says
   * 1080x2400.
   */
  readonly width: number;
  readonly height: number;
}

/** Reads `mCurrentRotation=ROTATION_<n>`, which is 34 bytes of `dumpsys window`. */
const ROTATION_COMMAND = 'dumpsys window | grep -m1 mCurrentRotation';

/**
 * Tracks the device's rotation, because `screenrecord` will not.
 *
 * Measured: `screenrecord` never re-configures mid-capture. Rotate the device
 * and the stream keeps the launch size, letterboxing the turned content into
 * it -- a 540x1200 capture becomes a ~540x243 band with black bars. So the
 * only way to mirror a rotated device usefully is to notice the rotation and
 * restart the recorder with swapped dimensions.
 *
 * Detection is push-first: `logcat` emits `Override config changes=... land`
 * and `finishDrawing of orientation change` within ~300 ms of a turn. Those tag
 * names are OEM- and version-specific though, so a slow poll backs them up --
 * the log is an optimisation, the poll is the correctness guarantee.
 */
export class DisplayWatcher implements vscode.Disposable {
  static readonly POLL_INTERVAL_MS = 4000;
  /** Debounce: a turn produces a burst of log lines and several redraws. */
  static readonly SETTLE_MS = 350;

  readonly #client: AdbClient;
  readonly #shell: PersistentShell;
  readonly #serial: string;
  readonly #log: ScopedLogger;
  readonly #emitter = new vscode.EventEmitter<DisplayGeometry>();

  #physical: { width: number; height: number } | undefined;
  #geometry: DisplayGeometry | undefined;
  #logcat: ChildProcess | undefined;
  #timer: NodeJS.Timeout | undefined;
  #settle: NodeJS.Timeout | undefined;
  #reading = false;
  #disposed = false;

  readonly onDidChangeDisplay = this.#emitter.event;

  constructor(client: AdbClient, shell: PersistentShell, serial: string, log: ScopedLogger) {
    this.#client = client;
    this.#shell = shell;
    this.#serial = serial;
    this.#log = log;
  }

  get geometry(): DisplayGeometry | undefined {
    return this.#geometry;
  }

  async start(): Promise<DisplayGeometry> {
    this.#physical = await this.#client.physicalSize(this.#serial);
    this.#log.info(`physical display ${this.#physical.width}x${this.#physical.height}`);
    const geometry = await this.#read();
    this.#startLogcat();
    this.#timer = setInterval(() => void this.#read(), DisplayWatcher.POLL_INTERVAL_MS);
    return geometry;
  }

  #startLogcat(): void {
    if (this.#disposed || this.#logcat) return;
    // `-T 1` starts at the tail, so we never replay the existing buffer.
    const child = this.#client.spawn(this.#serial, [
      'shell',
      'logcat',
      '-T',
      '1',
      '-v',
      'brief',
      'WindowManager:I',
      '*:S',
    ]);
    this.#logcat = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (/orientation change|Override config changes/.test(chunk)) this.#scheduleRead();
    });
    child.once('close', () => {
      this.#logcat = undefined;
      if (this.#disposed) return;
      this.#log.debug('rotation logcat ended; retrying in 3s');
      setTimeout(() => this.#startLogcat(), 3000);
    });
    child.once('error', (err) => {
      this.#log.warn(`rotation logcat unavailable, polling only: ${String(err)}`);
      this.#logcat = undefined;
    });
  }

  #scheduleRead(): void {
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = setTimeout(() => void this.#read(), DisplayWatcher.SETTLE_MS);
  }

  /** Forces a re-read, e.g. after the user taps the rotate button. */
  async poll(): Promise<void> {
    await this.#read();
  }

  async #read(): Promise<DisplayGeometry> {
    const current = this.#geometry;
    if (this.#disposed || this.#reading) return current ?? this.#fallback();
    this.#reading = true;
    try {
      const out = await this.#shell.exec(ROTATION_COMMAND, 8000);
      const parsed = parseRotation(out);
      if (parsed === undefined) {
        this.#log.debug(`could not read rotation from ${JSON.stringify(out.trim())}`);
      }
      return this.#publish(this.#toGeometry(parsed ?? 0));
    } catch (err) {
      this.#log.debug(`rotation read failed: ${String(err)}`);
      // Published, not just returned. An unknown geometry is worse than a
      // wrong one: the input sink drops every event while it is undefined, and
      // `screenrecord` falls back to a 1080x1920 guess on its next restart,
      // which changes the stream's aspect ratio mid-session. The natural
      // orientation is the honest default, and the next poll corrects it.
      return current ?? this.#publish(this.#fallback());
    } finally {
      this.#reading = false;
    }
  }

  /** Stores the geometry and announces it, if it actually changed. */
  #publish(geometry: DisplayGeometry): DisplayGeometry {
    const current = this.#geometry;
    if (
      current &&
      current.rotation === geometry.rotation &&
      current.width === geometry.width &&
      current.height === geometry.height
    ) {
      return current;
    }
    this.#log.info(`display ${geometry.width}x${geometry.height} (rotation ${geometry.rotation})`);
    this.#geometry = geometry;
    this.#emitter.fire(geometry);
    return geometry;
  }

  #toGeometry(rotation: number): DisplayGeometry {
    const physical = this.#physical ?? { width: 1080, height: 1920 };
    // Odd quarter turns swap the axes; that swapped size is what input uses.
    const landscape = rotation === 1 || rotation === 3;
    return {
      rotation,
      width: landscape ? physical.height : physical.width,
      height: landscape ? physical.width : physical.height,
    };
  }

  #fallback(): DisplayGeometry {
    return this.#toGeometry(0);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#settle) clearTimeout(this.#settle);
    this.#timer = undefined;
    this.#settle = undefined;
    this.#logcat?.kill('SIGTERM');
    this.#logcat = undefined;
    this.#emitter.dispose();
  }
}
