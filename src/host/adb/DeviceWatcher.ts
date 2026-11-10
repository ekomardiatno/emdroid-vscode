import type { ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';

import type { ScopedLogger } from '../log.js';
import type { AdbClient } from './AdbClient.js';
import { type AdbDevice, parseTrackDevices } from './parse.js';

/**
 * Keeps an up-to-date list of attached devices.
 *
 * `adb track-devices` is a push stream -- the host service emits a new snapshot
 * the moment a device appears or changes state -- so plug/unplug is noticed
 * immediately rather than up to a poll interval later. Its payload is only
 * `serial\tstate`, so each signal is followed by one `adb devices -l` to pick
 * up the model name.
 *
 * A slow poll runs alongside, because `track-devices` dies with the adb server
 * and some builds do not support it at all.
 */
export class DeviceWatcher implements vscode.Disposable {
  static readonly POLL_INTERVAL_MS = 5000;

  readonly #client: AdbClient;
  readonly #log: ScopedLogger;
  readonly #emitter = new vscode.EventEmitter<readonly AdbDevice[]>();

  #devices: readonly AdbDevice[] = [];
  #track: ChildProcess | undefined;
  #timer: NodeJS.Timeout | undefined;
  #refreshing = false;
  #refreshAgain = false;
  #disposed = false;

  readonly onDidChangeDevices = this.#emitter.event;

  constructor(client: AdbClient, log: ScopedLogger) {
    this.#client = client;
    this.#log = log;
  }

  get devices(): readonly AdbDevice[] {
    return this.#devices;
  }

  find(serial: string): AdbDevice | undefined {
    return this.#devices.find((d) => d.serial === serial);
  }

  start(): void {
    if (this.#disposed) return;
    this.#startTracking();
    this.#timer = setInterval(() => void this.refresh(), DeviceWatcher.POLL_INTERVAL_MS);
    void this.refresh();
  }

  #startTracking(): void {
    if (this.#disposed || this.#track) return;
    let buffer = '';
    const child = this.#client.spawnGlobal(['track-devices']);
    this.#track = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const { payloads, rest } = parseTrackDevices(buffer);
      buffer = rest;
      if (payloads.length > 0) {
        this.#log.trace(`track-devices signalled ${payloads.length} change(s)`);
        void this.refresh();
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text !== '') this.#log.debug(`track-devices: ${text}`);
    });
    child.once('close', () => {
      this.#track = undefined;
      if (this.#disposed) return;
      // The adb server was restarted or killed. The poll keeps us correct in
      // the meantime; retry the push stream shortly.
      this.#log.debug('track-devices ended; retrying in 2s');
      setTimeout(() => this.#startTracking(), 2000);
    });
    child.once('error', (err) => {
      this.#log.warn(`track-devices unavailable, falling back to polling: ${String(err)}`);
      this.#track = undefined;
    });
  }

  /**
   * Re-reads the device list. Concurrent calls collapse into one in-flight
   * read plus at most one follow-up, so a burst of track-devices signals
   * during enumeration cannot pile up adb invocations.
   */
  async refresh(): Promise<void> {
    if (this.#disposed) return;
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return;
    }
    this.#refreshing = true;
    try {
      do {
        this.#refreshAgain = false;
        const devices = await this.#client.listDevices();
        if (this.#disposed) return;
        if (!sameDevices(this.#devices, devices)) {
          this.#log.info(
            `devices: ${devices.map((d) => `${d.serial}=${d.state}`).join(', ') || 'none'}`,
          );
          this.#devices = devices;
          this.#emitter.fire(devices);
        }
      } while (this.#refreshAgain);
    } catch (err) {
      this.#log.warn(`device refresh failed: ${String(err)}`);
    } finally {
      this.#refreshing = false;
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#track?.kill('SIGTERM');
    this.#track = undefined;
    this.#emitter.dispose();
  }
}

function sameDevices(a: readonly AdbDevice[], b: readonly AdbDevice[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((d, i) => {
    const other = b[i];
    return other !== undefined && d.serial === other.serial && d.state === other.state && d.model === other.model;
  });
}
