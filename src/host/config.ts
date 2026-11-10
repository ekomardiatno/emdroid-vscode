import * as vscode from 'vscode';

export type SourcePreference = 'auto' | 'screenrecord' | 'still';

export interface EmdroidConfig {
  /** Empty means "auto-detect". Machine-scoped, so a repo cannot set it. */
  readonly adbPath: string;
  readonly scrcpyServerPath: string;
  readonly maxWidth: number;
  readonly bitRate: string;
  readonly source: SourcePreference;
  readonly showTouches: boolean;
  readonly logLevel: string;
}

const SECTION = 'emdroid';

export function readConfig(): EmdroidConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    adbPath: c.get<string>('adbPath', '').trim(),
    scrcpyServerPath: c.get<string>('scrcpyServerPath', '').trim(),
    maxWidth: clampInt(c.get<number>('maxWidth', 720), 160, 2160, 720),
    bitRate: sanitiseBitRate(c.get<string>('bitRate', '8M')),
    source: readSource(c.get<string>('source', 'auto')),
    showTouches: c.get<boolean>('showTouches', false),
    logLevel: c.get<string>('logLevel', 'info'),
  };
}

export function onDidChangeConfig(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) listener();
  });
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readSource(value: string): SourcePreference {
  return value === 'screenrecord' || value === 'still' ? value : 'auto';
}

/**
 * The bit rate reaches an `adb shell` argument vector. It is never passed
 * through a shell (`spawn` is always called without `shell: true`), but
 * `screenrecord` itself runs under the device's shell, so keep it to the exact
 * shape the flag accepts and reject anything else.
 */
export function sanitiseBitRate(value: string): string {
  return /^[0-9]{1,9}[KMkm]?$/.test(value.trim()) ? value.trim() : '8M';
}
