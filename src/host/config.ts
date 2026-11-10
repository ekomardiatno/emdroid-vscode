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

/**
 * Default bit rate, which has to suit the *worst* link the picture crosses.
 *
 * `screenrecord` treats this as a target and fills it regardless of how little
 * the content moves, so it is a floor on bandwidth, not a ceiling on quality.
 * Over code-server the frames leave the extension host's machine, and a home
 * upstream is the narrowest part of that path -- the reference setup measured
 * 3.7 Mbit/s up against 17 Mbit/s down, so an 8M capture queued permanently and
 * every non-key unit was dropped under backpressure. 2M at the default
 * 720-long-edge capture is still about five times scrcpy's own bits per pixel,
 * so this costs nothing visible and the stream stays live.
 */
const DEFAULT_BIT_RATE = '2M';

export function readConfig(): EmdroidConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    adbPath: c.get<string>('adbPath', '').trim(),
    scrcpyServerPath: c.get<string>('scrcpyServerPath', '').trim(),
    maxWidth: clampInt(c.get<number>('maxWidth', 720), 160, 2160, 720),
    bitRate: sanitiseBitRate(c.get<string>('bitRate', DEFAULT_BIT_RATE)),
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
  return /^[0-9]{1,9}[KMkm]?$/.test(value.trim()) ? value.trim() : DEFAULT_BIT_RATE;
}
