import type { ChildProcess } from 'node:child_process';

import { type BinaryRunResult, type ChildProcessRegistry, run, runText } from '../childProcesses.js';
import type { ScopedLogger } from '../log.js';
import { type AdbDevice, parseDevices, parseGetProps, parseWmSize } from './parse.js';

export interface DeviceInfo {
  readonly serial: string;
  readonly model: string;
  readonly androidVersion: string;
  readonly sdkInt: number;
  /** Physical display size. NOT the input coordinate space when rotated. */
  readonly physicalWidth: number;
  readonly physicalHeight: number;
}

/**
 * A thin, typed wrapper over the `adb` executable.
 *
 * Every call passes `-s <serial>` explicitly and never `-d`/`-e`: with more
 * than one device attached those flags fail, and worse, with exactly one they
 * silently target whatever happens to be plugged in.
 */
export class AdbClient {
  readonly #registry: ChildProcessRegistry;
  readonly #log: ScopedLogger;
  readonly #adbPath: string;

  constructor(registry: ChildProcessRegistry, log: ScopedLogger, adbPath: string) {
    this.#registry = registry;
    this.#log = log;
    this.#adbPath = adbPath;
  }

  get path(): string {
    return this.#adbPath;
  }

  async listDevices(): Promise<AdbDevice[]> {
    const result = await runText(this.#registry, this.#adbPath, ['devices', '-l'], {
      timeoutMs: 15000,
    });
    if (result.code !== 0) {
      this.#log.warn(`adb devices failed (${result.code}): ${result.stderr.trim()}`);
      return [];
    }
    return parseDevices(result.stdout);
  }

  /** Runs `adb -s <serial> shell <args...>` and returns decoded stdout. */
  shell(serial: string, args: readonly string[], timeoutMs = 15000) {
    return runText(this.#registry, this.#adbPath, ['-s', serial, 'shell', ...args], { timeoutMs });
  }

  /**
   * `exec-out` rather than `shell`: it is a clean binary pipe with no pty, so
   * nothing mangles `\n` into `\r\n`. Mandatory for PNG and H.264.
   */
  execOut(serial: string, args: readonly string[], timeoutMs = 30000): Promise<BinaryRunResult> {
    return run(this.#registry, this.#adbPath, ['-s', serial, 'exec-out', ...args], { timeoutMs });
  }

  /** Spawns a long-lived child. The caller owns its lifetime. */
  spawn(serial: string, args: readonly string[]): ChildProcess {
    return this.#registry.spawn(this.#adbPath, ['-s', serial, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /** Spawns against no particular device, for `track-devices`. */
  spawnGlobal(args: readonly string[]): ChildProcess {
    return this.#registry.spawn(this.#adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async getProps(serial: string): Promise<Map<string, string>> {
    const result = await this.shell(serial, ['getprop']);
    return parseGetProps(result.stdout);
  }

  async describeDevice(serial: string): Promise<DeviceInfo> {
    const [props, size] = await Promise.all([this.getProps(serial), this.physicalSize(serial)]);
    const sdk = Number(props.get('ro.build.version.sdk') ?? '0');
    return {
      serial,
      model: props.get('ro.product.model') ?? serial,
      androidVersion: props.get('ro.build.version.release') ?? 'unknown',
      sdkInt: Number.isFinite(sdk) ? sdk : 0,
      physicalWidth: size.width,
      physicalHeight: size.height,
    };
  }

  /**
   * Physical (unrotated) display size from `wm size`.
   *
   * Measured: this stays 1080x2400 even in landscape, so it is NOT the space
   * `input tap` uses. `DisplayWatcher` derives the rotated logical size from
   * this plus the current rotation.
   */
  async physicalSize(serial: string): Promise<{ width: number; height: number }> {
    const result = await this.shell(serial, ['wm', 'size']);
    const parsed = parseWmSize(result.stdout);
    if (parsed) return parsed;
    this.#log.warn(`could not parse "wm size" output: ${JSON.stringify(result.stdout)}`);
    return { width: 1080, height: 1920 };
  }

  /**
   * Best-effort kill of any `screenrecord` left on the device.
   *
   * Killing the local `adb exec-out` does **not** reliably kill the remote
   * process, and an orphan holds the hardware encoder so every later start
   * fails opaquely. Run this both before a start and after a stop.
   *
   * `pkill` returns 1 when nothing matched, which is the normal case; that is
   * not an error.
   */
  async killOrphanedRecorders(serial: string): Promise<void> {
    try {
      const result = await this.shell(serial, ['pkill', '-INT', '-f', 'screenrecord'], 5000);
      if (result.code === 0) this.#log.info('killed a leftover screenrecord on the device');
    } catch (err) {
      this.#log.debug(`pkill screenrecord failed, continuing: ${String(err)}`);
    }
  }

  /** Reads back whether any recorder is still alive; used by the teardown test. */
  async hasRunningRecorder(serial: string): Promise<boolean> {
    const result = await this.shell(serial, ['ps', '-A', '-o', 'NAME'], 8000);
    return result.stdout.split('\n').some((line) => line.trim() === 'screenrecord');
  }
}
