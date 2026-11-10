import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import type { Logger, ScopedLogger } from '../log.js';
import type { FrameSource } from '../source/FrameSource.js';
import type { InputSink } from '../source/InputSink.js';
import { MirrorPanel } from '../ui/MirrorPanel.js';
import { MirrorStatusBar } from '../ui/statusBar.js';
import { showFailure } from '../ui/errors.js';
import { MirrorSession, type SessionTarget } from './MirrorSession.js';

/** Builds the source/sink pair for a target. Phase 2 changes only this. */
export type SourceFactory = (
  log: ScopedLogger,
  target: SessionTarget,
) => { source: FrameSource; input: InputSink | undefined };

interface ActiveSession {
  readonly session: MirrorSession;
  readonly panel: MirrorPanel;
  readonly target: SessionTarget;
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

    const active: ActiveSession = { session, panel, target };
    this.#sessions.set(target.serial, active);

    session.onDidChangeMetrics((metrics) => {
      // The status bar follows whichever panel is in front; with one session
      // that is simply the one session.
      if (this.#sessions.get(target.serial) === active) {
        this.#statusBar.update(target.model, metrics);
      }
    });

    session.onDidProduceStill((still) => panel.post(still));

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
