import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import type { Logger, ScopedLogger } from '../log.js';
import type { FrameSource } from '../source/FrameSource.js';
import type { InputSink } from '../source/InputSink.js';
import { MirrorPanel } from '../ui/MirrorPanel.js';
import { MirrorStatusBar } from '../ui/statusBar.js';
import { showFailure } from '../ui/errors.js';
import { MirrorSession, type SessionTarget } from './MirrorSession.js';

/**
 * Builds the source/sink pair for a target. Phase 2 changes only this.
 *
 * Called more than once per session: if the webview turns out not to be able to
 * decode video, it is asked again with `target.kind` set to something else. So
 * it must read the kind from the target rather than capturing it, and may throw
 * if it cannot build the kind asked for.
 */
export type SourceFactory = (
  log: ScopedLogger,
  target: SessionTarget,
) => { source: FrameSource; input: InputSink | undefined };

interface ActiveSession {
  readonly session: MirrorSession;
  readonly panel: MirrorPanel;
  readonly target: SessionTarget;
  /** Kept so a reconnect can rebuild the pair without reopening the panel. */
  readonly build: SourceFactory;
  readonly log: ScopedLogger;
}

/**
 * Owns the live sessions, one per device.
 *
 * Opening a second panel for a device that is already mirrored would start a
 * second `screenrecord`, and the two would fight over the single hardware
 * encoder -- so a repeat request reveals the existing panel instead.
 */
export class SessionManager implements vscode.Disposable {
  readonly #logger: Logger;
  readonly #log: ScopedLogger;
  readonly #extensionUri: vscode.Uri;
  readonly #statusBar = new MirrorStatusBar();
  readonly #sessions = new Map<string, ActiveSession>();

  constructor(logger: Logger, extensionUri: vscode.Uri) {
    this.#logger = logger;
    this.#log = logger.scope('session');
    this.#extensionUri = extensionUri;
  }

  has(serial: string): boolean {
    return this.#sessions.has(serial);
  }

  /** The devices with a live panel, for whoever is watching adb. */
  get serials(): string[] {
    return [...this.#sessions.keys()];
  }

  /**
   * Rebuilds the source for a session whose device went away and came back.
   *
   * Needed because an unplug is not something the source can retry through: the
   * `adb exec-out` pipe dies with the connection, and `screenrecord` exiting
   * against a gone device is classified as non-recoverable on purpose -- a
   * backoff loop against a disconnected phone is just noise.
   *
   * A swap rather than a reopen. The panel, the socket and the decoder are all
   * still fine, and the tab is where the user put it; only the two adb-facing
   * objects are stale. `useSource` already stops and disposes the old pair
   * before starting the new one, which is what keeps the single hardware
   * encoder from being claimed twice.
   */
  async reload(serial: string): Promise<void> {
    const active = this.#sessions.get(serial);
    if (!active) return;
    const kind = active.session.kind;
    this.#log.info(`${serial} is back; rebuilding its ${kind} source`);
    try {
      const next = active.build(active.log, { ...active.target, kind });
      await active.session.useSource(kind, next.source, next.input);
    } catch (err) {
      this.#log.error(`could not rebuild the source for ${serial}`, err);
      await showFailure('source-failed', 'The mirror could not reconnect.', () =>
        this.#logger.show(),
      );
    }
  }

  async open(target: SessionTarget, build: SourceFactory): Promise<void> {
    const existing = this.#sessions.get(target.serial);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const sessionId = randomUUID();
    const log = this.#log.child(target.serial);
    const { source, input } = build(log, target);
    const session = new MirrorSession(
      log,
      sessionId,
      target,
      source,
      input,
      this.#logger.level,
    );

    let panel: MirrorPanel;
    try {
      const boot = await session.prepare();
      const endpoint = session.endpoint;
      if (!endpoint) throw new Error('the stream endpoint did not resolve');
      panel = MirrorPanel.create(this.#extensionUri, log, boot, endpoint);
    } catch (err) {
      session.dispose();
      this.#log.error('could not prepare the session', err);
      await showFailure(
        'transport-failed',
        'The mirror could not be started.',
        () => this.#logger.show(),
      );
      return;
    }

    const active: ActiveSession = { session, panel, target, build, log };
    this.#sessions.set(target.serial, active);

    session.onDidChangeMetrics((metrics) => {
      // The status bar follows whichever panel is in front; with one session
      // that is simply the one session.
      if (this.#sessions.get(target.serial) === active) {
        this.#statusBar.update(target.model, metrics);
      }
    });

    session.onDidProduceStill((still) => panel.post(still));

    // The session knows the webview cannot decode; only this layer knows how to
    // build a source. The panel is kept: the user opened that tab, and losing
    // it to a capability check they did not make would be the wrong trade.
    session.onDidRequestSource((kind) => {
      void (async () => {
        try {
          const next = build(log, { ...target, kind });
          await session.useSource(kind, next.source, next.input);
        } catch (err) {
          this.#log.error(`could not switch ${target.serial} to ${kind}`, err);
          await showFailure('unsupported', `The mirror could not switch to ${kind}.`, () =>
            this.#logger.show(),
          );
        }
      })();
    });

    session.onDidFail((failure) => {
      if (failure.recoverable) return;
      void showFailure(failure.code, failure.message, () => this.#logger.show());
    });

    panel.onDidDispose(() => {
      this.#sessions.delete(target.serial);
      // Disposing the session is what stops the on-device recorder. Closing the
      // tab must do it, or an orphan keeps the encoder for the next attempt.
      session.dispose();
      if (this.#sessions.size === 0) this.#statusBar.hide();
    });

    this.#statusBar.update(target.model, session.metrics);

    try {
      await session.start();
    } catch (err) {
      this.#log.error('the source failed to start', err);
      await showFailure('source-failed', 'The capture source failed to start.', () =>
        this.#logger.show(),
      );
    }
  }

  /** `panel.dispose()` fires `onDidDispose`, which tears the session down. */
  close(serial: string): void {
    this.#sessions.get(serial)?.panel.dispose();
  }

  dispose(): void {
    for (const active of [...this.#sessions.values()]) {
      active.panel.dispose();
      active.session.dispose();
    }
    this.#sessions.clear();
    this.#statusBar.dispose();
  }
}
