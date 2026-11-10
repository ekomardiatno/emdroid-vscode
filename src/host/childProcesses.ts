import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';

import type { ScopedLogger } from './log.js';

/**
 * Every child this extension spawns goes through here, for two reasons.
 *
 * 1. **`shell: true` is never allowed.** Serials, sizes and bit rates all reach
 *    an argument vector; with a shell in the path any of them would be an
 *    injection vector. `spawn` without a shell passes them as opaque argv
 *    entries, so there is nothing to escape.
 * 2. A dead extension host must not leave `adb` or `screenrecord` behind.
 *    The registry lets `deactivate()` sweep.
 */
export class ChildProcessRegistry {
  readonly #children = new Set<ChildProcess>();
  readonly #log: ScopedLogger;

  constructor(log: ScopedLogger) {
    this.#log = log;
  }

  get size(): number {
    return this.#children.size;
  }

  spawn(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
    this.#log.debug(`spawn ${command} ${args.join(' ')}`);
    const child = spawn(command, [...args], {
      ...options,
      // Explicit, not inherited from the caller: this must never become true.
      shell: false,
      windowsHide: true,
    });
    this.#children.add(child);
    child.once('close', () => this.#children.delete(child));
    child.once('error', () => this.#children.delete(child));
    return child;
  }

  /** Kills every live child. Best-effort: a child may already be gone. */
  killAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const child of [...this.#children]) {
      try {
        child.kill(signal);
      } catch (err) {
        this.#log.debug(`kill failed for pid ${child.pid}: ${String(err)}`);
      }
    }
    this.#children.clear();
  }
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly stdin?: string;
  /** Collect stdout as raw bytes instead of a string, for `screencap -p`. */
  readonly binary?: boolean;
}

export interface BinaryRunResult extends Omit<RunResult, 'stdout'> {
  readonly stdout: Buffer;
}

/**
 * Runs a child to completion and collects its output.
 *
 * Resolves rather than rejects on a non-zero exit: adb reports most real
 * conditions (`device unauthorized`, `device offline`) that way, and the caller
 * needs the stderr text to tell them apart.
 */
export function run(
  registry: ChildProcessRegistry,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<BinaryRunResult> {
  return new Promise((resolve, reject) => {
    const child = registry.spawn(command, args, {
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, options.timeoutMs);

    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
      // A child that exits before reading stdin makes the write fail; that is
      // the child's exit code's business, not an error of its own.
      child.stdin.on('error', () => undefined);
    }

    child.once('error', (e) => {
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
    });

    child.once('close', (code, signal) => {
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/** `run` with stdout decoded as UTF-8 and trimmed. */
export async function runText(
  registry: ChildProcessRegistry,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await run(registry, command, args, options);
  return { ...result, stdout: result.stdout.toString('utf8') };
}
