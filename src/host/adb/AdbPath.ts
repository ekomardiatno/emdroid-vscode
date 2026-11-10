import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ChildProcessRegistry } from '../childProcesses.js';
import { runText } from '../childProcesses.js';
import type { ScopedLogger } from '../log.js';

export interface AdbResolution {
  readonly path: string;
  readonly version: string;
  /** Where it came from, for the diagnostics report. */
  readonly origin: 'setting' | 'env' | 'sdk-default' | 'path';
}

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

/**
 * Finds a usable `adb`.
 *
 * Order matters: an explicit setting always wins, then the SDK the user has
 * actually configured, then the stock SDK location, then `PATH`. `PATH` is last
 * because on macOS the GUI VS Code process inherits a minimal `PATH` that
 * frequently lacks platform-tools -- relying on it first would make the
 * extension work in a terminal-launched editor and fail in a dock-launched one.
 */
export async function resolveAdb(
  registry: ChildProcessRegistry,
  log: ScopedLogger,
  configuredPath: string,
): Promise<AdbResolution> {
  const attempts: Array<{ candidate: string; origin: AdbResolution['origin'] }> = [];

  if (configuredPath !== '') {
    attempts.push({ candidate: configuredPath, origin: 'setting' });
  }
  for (const envVar of ['ANDROID_HOME', 'ANDROID_SDK_ROOT'] as const) {
    const root = process.env[envVar];
    if (root) attempts.push({ candidate: path.join(root, 'platform-tools', EXE), origin: 'env' });
  }
  attempts.push({ candidate: defaultSdkAdb(), origin: 'sdk-default' });
  for (const candidate of pathCandidates()) {
    attempts.push({ candidate, origin: 'path' });
  }

  const failures: string[] = [];
  for (const { candidate, origin } of attempts) {
    try {
      await access(candidate, constants.X_OK);
    } catch {
      failures.push(`${candidate} (not executable)`);
      continue;
    }
    const version = await probeVersion(registry, candidate);
    if (version === undefined) {
      failures.push(`${candidate} (did not answer --version)`);
      continue;
    }
    log.info(`using adb ${version} at ${candidate} (${origin})`);
    return { path: candidate, version, origin };
  }

  log.error(`no usable adb found; tried:\n  ${failures.join('\n  ')}`);
  throw new AdbNotFoundError(failures);
}

export class AdbNotFoundError extends Error {
  readonly attempts: readonly string[];

  constructor(attempts: readonly string[]) {
    super(
      'Could not find a usable adb. Install the Android SDK Platform Tools, or set "emdroid.adbPath" to the executable.',
    );
    this.name = 'AdbNotFoundError';
    this.attempts = attempts;
  }
}

function defaultSdkAdb(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', EXE);
    case 'win32':
      return path.join(
        process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'),
        'Android',
        'Sdk',
        'platform-tools',
        EXE,
      );
    default:
      return path.join(home, 'Android', 'Sdk', 'platform-tools', EXE);
  }
}

/**
 * Expands `PATH` ourselves rather than shelling out to `which`, so that no part
 * of the lookup ever reaches a shell.
 */
function pathCandidates(): string[] {
  const raw = process.env['PATH'];
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .filter((dir) => dir !== '')
    .map((dir) => path.join(dir, EXE));
}

async function probeVersion(
  registry: ChildProcessRegistry,
  candidate: string,
): Promise<string | undefined> {
  try {
    const result = await runText(registry, candidate, ['--version'], { timeoutMs: 8000 });
    if (result.code !== 0) return undefined;
    // "Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\n..."
    const m = /Version\s+([0-9][^\s]*)/.exec(result.stdout);
    return m?.[1] ?? result.stdout.split('\n')[0]?.trim() ?? 'unknown';
  } catch {
    return undefined;
  }
}
