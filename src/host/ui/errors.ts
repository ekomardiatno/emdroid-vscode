import * as vscode from 'vscode';

import type { ErrorCode } from '../../common/protocol.js';

/**
 * Turns a failure code into something the user can act on.
 *
 * This matters more than usual here. Half of what can go wrong lives on the far
 * side of a USB cable or an SSH tunnel, where the only symptom is a black
 * rectangle. "Unauthorized" and "offline" in particular have one obvious fix
 * each, and naming it is the difference between a 10-second fix and a bug
 * report.
 */
const HINTS: Readonly<Record<ErrorCode, string>> = {
  'adb-not-found':
    'Install Android platform-tools, or set `emdroid.adbPath` to the adb executable.',
  'device-unauthorized':
    'Unlock the device and accept the "Allow USB debugging" prompt, then reconnect.',
  'device-offline':
    'The device is connected but not responding. Unplug and replug it, or toggle USB debugging.',
  'device-gone': 'The device disconnected.',
  'source-failed': 'The on-device capture stopped. Reconnect to try again.',
  'encoder-busy':
    'The hardware encoder is already in use. Close other screen recorders or mirroring apps, then reconnect.',
  'decode-failed':
    'This editor could not decode the video stream. Set `emdroid.source` to `still` to fall back to screenshots.',
  'transport-failed':
    'The stream connection could not be established. Check the EMDroid output channel for the resolved URL.',
  unsupported: 'This device or editor does not support the requested capture mode.',
};

export function hintFor(code: ErrorCode): string {
  return HINTS[code];
}

/** Shows a failure with the one action that is most likely to fix it. */
export async function showFailure(
  code: ErrorCode,
  message: string,
  showLog: () => void,
): Promise<void> {
  // The hint goes in the message, not in `detail`: `detail` is only rendered
  // for modal dialogs, and a modal for a disconnected cable is too much.
  const choice = await vscode.window.showErrorMessage(
    `EMDroid: ${message} ${hintFor(code)}`,
    'Show Log',
    ...(code === 'adb-not-found' || code === 'decode-failed' ? ['Open Settings'] : []),
  );
  if (choice === 'Show Log') showLog();
  else if (choice === 'Open Settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'emdroid');
  }
}
