import * as vscode from 'vscode';

import type { SessionMetrics } from '../session/MirrorSession.js';

/**
 * Shows the two numbers that decide whether phase 2 is worth building.
 *
 * `EMDroid: SM-G996B · 28 fps · tap 240 ms`
 *
 * Latency is the whole reason the scrcpy source exists, and "it feels laggy" is
 * not something you can act on. Putting the measured frame rate and tap
 * round-trip permanently on screen means the decision to move off `screenrecord`
 * gets made from data, and a regression shows up the moment it happens.
 */
export class MirrorStatusBar implements vscode.Disposable {
  readonly #item: vscode.StatusBarItem;

  constructor() {
    this.#item = vscode.window.createStatusBarItem('emdroid.status', vscode.StatusBarAlignment.Right, 100);
    this.#item.name = 'EMDroid';
    this.#item.command = 'emdroid.showDiagnostics';
  }

  update(model: string, metrics: SessionMetrics): void {
    const parts = [model];
    switch (metrics.state) {
      case 'starting':
        parts.push('starting…');
        break;
      case 'stalled':
        parts.push('stalled');
        break;
      case 'stopped':
        parts.push('stopped');
        break;
      case 'streaming':
        parts.push(`${metrics.fps.toFixed(0)} fps`);
        if (metrics.tapRttMs !== undefined) parts.push(`tap ${metrics.tapRttMs.toFixed(0)} ms`);
        break;
    }
    this.#item.text = `$(device-mobile) ${parts.join(' · ')}`;
    this.#item.tooltip = `EMDroid — ${parts.join(' · ')}\nClick to open the diagnostics log.`;
    this.#item.show();
  }

  hide(): void {
    this.#item.hide();
  }

  dispose(): void {
    this.#item.dispose();
  }
}
