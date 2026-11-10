import * as vscode from 'vscode';

import { type LogLevel, describeError, formatLine, isLogLevel, shouldLog } from '../common/log.js';

/**
 * One output channel for the whole extension, with a per-scope prefix.
 *
 * Everything that can fail opaquely -- adb invocations, the on-device
 * recorder's stderr, the external-URI resolution -- logs here, because for a
 * remote editor this channel is the only diagnostic the user can actually see.
 */
export class Logger implements vscode.Disposable {
  readonly #channel: vscode.LogOutputChannel;
  #level: LogLevel = 'info';

  constructor(name = 'EMDroid') {
    this.#channel = vscode.window.createOutputChannel(name, { log: true });
  }

  get level(): LogLevel {
    return this.#level;
  }

  setLevel(level: string): void {
    this.#level = isLogLevel(level) ? level : 'info';
  }

  show(): void {
    this.#channel.show(true);
  }

  /** Returns a logger bound to a scope, so call sites stay short. */
  scope(name: string): ScopedLogger {
    return new ScopedLogger(this, name);
  }

  write(level: LogLevel, scope: string, message: string): void {
    if (!shouldLog(this.#level, level)) return;
    this.#channel.appendLine(formatLine(new Date(), level, scope, message));
  }

  dispose(): void {
    this.#channel.dispose();
  }
}

export class ScopedLogger {
  readonly #logger: Logger;
  readonly #scope: string;

  constructor(logger: Logger, scope: string) {
    this.#logger = logger;
    this.#scope = scope;
  }

  child(suffix: string): ScopedLogger {
    return new ScopedLogger(this.#logger, `${this.#scope}:${suffix}`);
  }

  /** For relaying a level that arrived as data, e.g. from the webview. */
  write(level: LogLevel, message: string): void {
    this.#logger.write(level, this.#scope, message);
  }

  error(message: string, err?: unknown): void {
    this.#logger.write('error', this.#scope, err ? `${message}: ${describeError(err)}` : message);
  }

  warn(message: string): void {
    this.#logger.write('warn', this.#scope, message);
  }

  info(message: string): void {
    this.#logger.write('info', this.#scope, message);
  }

  debug(message: string): void {
    this.#logger.write('debug', this.#scope, message);
  }

  trace(message: string): void {
    this.#logger.write('trace', this.#scope, message);
  }
}
