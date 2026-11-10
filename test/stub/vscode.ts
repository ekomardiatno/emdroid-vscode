/**
 * A minimal stand-in for the `vscode` module, so host code can be tested in
 * plain node.
 *
 * Only the surface the host actually touches is implemented, and each piece
 * mimics the **measured** behaviour of the real thing rather than a guess:
 * notably `asExternalUri` returns its input unchanged, which is exactly what
 * desktop VS Code does (no resolver is registered, the internal call throws,
 * and the public wrapper swallows it for `http`/`https`).
 *
 * This is a test double, not a shim for production: nothing in `src/` imports
 * it. It is wired in by the resolve hook in `hooks.mjs`.
 */

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (value: T) => void) => Disposable;

export class EventEmitter<T> {
  #listeners = new Set<(value: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    // Copied before iterating: a listener that disposes itself is legal.
    for (const listener of [...this.#listeners]) listener(value);
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export class Uri {
  readonly #url: URL;

  private constructor(url: URL) {
    this.#url = url;
  }

  static parse(value: string): Uri {
    return new Uri(new URL(value));
  }

  static file(path: string): Uri {
    return new Uri(new URL(`file://${path}`));
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const url = new URL(base.#url.href);
    url.pathname = [url.pathname.replace(/\/$/, ''), ...segments].join('/');
    return new Uri(url);
  }

  get scheme(): string {
    return this.#url.protocol.replace(/:$/, '');
  }

  get fsPath(): string {
    return decodeURIComponent(this.#url.pathname);
  }

  toString(_skipEncoding?: boolean): string {
    return this.#url.href;
  }
}

export const env = {
  appHost: 'test',
  remoteName: undefined as string | undefined,
  uiKind: 1,
  /** Desktop behaviour: the URI comes back unchanged. */
  asExternalUri: async (uri: Uri): Promise<Uri> => uri,
};

export const UIKind = { Desktop: 1, Web: 2 } as const;

export interface LogOutputChannel extends Disposable {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
}

/** Lines are kept so a test can assert on what was logged. */
export const capturedLogLines: string[] = [];

export const window = {
  createOutputChannel: (_name: string, _options?: { log: boolean }): LogOutputChannel => ({
    appendLine: (value: string) => {
      capturedLogLines.push(value);
    },
    show: () => undefined,
    dispose: () => undefined,
  }),
};
