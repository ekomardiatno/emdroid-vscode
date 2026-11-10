/**
 * Level handling shared by the host's output channel and the webview's console.
 * No transport here -- each side owns its own sink.
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** True when a message at `level` should be emitted by a sink set to `threshold`. */
export function shouldLog(threshold: LogLevel, level: LogLevel): boolean {
  return RANK[level] <= RANK[threshold];
}

/** `14:52:03.118 INFO  [source] started` -- stable width so the channel scans well. */
export function formatLine(now: Date, level: LogLevel, scope: string, message: string): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
}

/**
 * Renders an unknown thrown value for a log line. Errors keep their stack, and
 * anything else is coerced rather than printed as `[object Object]`.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
