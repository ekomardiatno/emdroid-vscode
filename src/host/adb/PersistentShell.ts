import type { ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';

import type { AdbClient } from './AdbClient.js';
import type { ScopedLogger } from '../log.js';

/**
 * One long-lived `adb shell` that commands are typed into.
 *
 * Measured: a fresh `adb shell <cmd>` costs ~110 ms regardless of the command,
 * and that is connection setup rather than device work. For taps -- where the
 * whole point is round-trip time -- paying it per event would dominate the
 * latency budget. Keeping the shell open removes it.
 *
 * Commands are delimited by echoing a sentinel, because the shell gives no
 * other framing. The sentinel is random per shell so device output can never
 * be mistaken for it.
 */
export class PersistentShell implements vscode.Disposable {
  readonly #client: AdbClient;
  readonly #serial: string;
  readonly #log: ScopedLogger;
  readonly #sentinel: string;

  #child: ChildProcess | undefined;
  #buffer = '';
  #queue: Array<{ resolve: (out: string) => void; reject: (e: Error) => void }> = [];
  #disposed = false;
  #starting: Promise<void> | undefined;

  constructor(client: AdbClient, serial: string, log: ScopedLogger) {
    this.#client = client;
    this.#serial = serial;
    this.#log = log;
    this.#sentinel = `__emdroid_${randomToken()}__`;
  }

  async #ensureStarted(): Promise<void> {
    if (this.#child && !this.#child.killed) return;
    if (this.#starting) return this.#starting;

    this.#starting = (async () => {
      // `shell` rather than `exec-out`, and `spawnInteractive` rather than
      // `spawn`: this is the one child we write to.
      const child = this.#client.spawnInteractive(this.#serial, ['shell']);
      if (child.stdin) child.stdin.setDefaultEncoding('utf8');
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.#onData(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        const text = chunk.trim();
        // `grep -m1` closing a dumpsys pipe early is normal and noisy.
        if (text !== '' && !text.includes('Broken pipe')) this.#log.debug(`shell stderr: ${text}`);
      });
      // Both handlers are identity-guarded. A restart has already cleared
      // `#child` and failed the queue, and by the time the old child's `close`
      // arrives a replacement may be live -- clearing it here would discard a
      // working shell and reject commands that are about to succeed.
      child.once('close', (code, signal) => {
        this.#log.debug(`persistent shell exited (code=${code} signal=${signal})`);
        if (this.#child !== child) return;
        this.#child = undefined;
        this.#failAll(new Error('adb shell closed'));
      });
      child.once('error', (err) => {
        if (this.#child !== child) return;
        this.#child = undefined;
        this.#failAll(err instanceof Error ? err : new Error(String(err)));
      });
      this.#child = child;
    })();

    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const i = this.#buffer.indexOf(this.#sentinel);
      if (i < 0) break;
      const output = this.#buffer.slice(0, i);
      // Drop the rest of the sentinel line, including its newline.
      const after = this.#buffer.indexOf('\n', i);
      this.#buffer = after < 0 ? '' : this.#buffer.slice(after + 1);
      this.#queue.shift()?.resolve(output);
    }

    // A reply that never terminates would grow this without bound.
    if (this.#buffer.length > 1 << 22) {
      this.#log.warn('persistent shell buffer overflow; restarting the shell');
      this.restart();
    }
  }

  #failAll(err: Error): void {
    const queue = this.#queue;
    this.#queue = [];
    for (const entry of queue) entry.reject(err);
  }

  /**
   * Runs one command and resolves with its stdout.
   *
   * `command` is written to a shell's stdin, so unlike everything else in this
   * extension it *is* interpreted by a shell. Only pass literals built here --
   * never interpolate user or device input into it.
   */
  async exec(command: string, timeoutMs = 10000): Promise<string> {
    if (this.#disposed) throw new Error('shell disposed');
    await this.#ensureStarted();
    const stdin = this.#child?.stdin;
    if (!stdin) throw new Error('adb shell has no stdin');

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`adb shell command timed out after ${timeoutMs} ms: ${command}`));
        // The command may still be running, and its sentinel will arrive
        // eventually -- by which time the head of the queue belongs to someone
        // else, who would be handed this command's output as their own.
        // Dropping the entry is what causes that, so the shell goes instead:
        // nothing here takes seconds, so a timeout means wedged, not slow.
        this.restart();
      }, timeoutMs);

      const onResolve = (out: string) => {
        clearTimeout(timer);
        resolve(out);
      };
      const onReject = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };

      this.#queue.push({ resolve: onResolve, reject: onReject });
      stdin.write(`${command}\necho ${this.#sentinel}\n`);
    });
  }

  /** Fire-and-forget. Used for taps, where awaiting the echo adds latency. */
  async send(command: string): Promise<void> {
    if (this.#disposed) return;
    await this.#ensureStarted();
    this.#child?.stdin?.write(`${command}\n`);
  }

  /**
   * Drops the shell. The next `exec` starts a fresh one.
   *
   * The queue is failed here rather than left to the `close` handler, which is
   * identity-guarded and so deliberately ignores a child we replaced. The
   * buffer goes too: a half-received line from the dead shell would be read as
   * the first line of the new one's output.
   */
  restart(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#buffer = '';
    child?.kill('SIGKILL');
    this.#failAll(new Error('adb shell restarted'));
  }

  dispose(): void {
    this.#disposed = true;
    this.#failAll(new Error('shell disposed'));
    // `exit` lets the device-side shell clean up; the kill is the backstop.
    try {
      this.#child?.stdin?.write('exit\n');
    } catch {
      // The pipe may already be gone; the kill below is what matters.
    }
    this.#child?.kill('SIGTERM');
    this.#child = undefined;
  }
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
