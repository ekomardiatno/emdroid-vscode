import * as vscode from 'vscode';

import { AdbClient } from './host/adb/AdbClient.js';
import { AdbNotFoundError, resolveAdb } from './host/adb/AdbPath.js';
import { DeviceWatcher } from './host/adb/DeviceWatcher.js';
import { type AdbDevice, classifyAdbError } from './host/adb/parse.js';
import { ChildProcessRegistry } from './host/childProcesses.js';
import { onDidChangeConfig, readConfig } from './host/config.js';
import { Logger } from './host/log.js';
import { SessionManager } from './host/session/SessionManager.js';
import { FixtureFrameSource } from './host/source/fixture/FixtureFrameSource.js';
import { chooseSourceKind, createSource } from './host/source/registry.js';
import { DeviceNode, DeviceTreeProvider } from './host/ui/DeviceTreeProvider.js';
import { showFailure } from './host/ui/errors.js';

/**
 * Activation is deliberately cheap and adb-free.
 *
 * Resolving adb means spawning a process, and on a remote editor that can be
 * slow enough to be noticed at startup for a user who has no device attached.
 * It is resolved lazily on the first command, and once resolved the client is
 * reused.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  logger.setLevel(readConfig().logLevel);
  context.subscriptions.push(logger);

  const log = logger.scope('extension');
  const registry = new ChildProcessRegistry(logger.scope('proc'));
  context.subscriptions.push({ dispose: () => registry.killAll() });

  const sessions = new SessionManager(logger, context.extensionUri);
  context.subscriptions.push(sessions);

  context.subscriptions.push(onDidChangeConfig(() => logger.setLevel(readConfig().logLevel)));

  // The view is registered now, before adb is known: an empty list renders the
  // `viewsWelcome` content, which is the right thing to show while resolving.
  const tree = new DeviceTreeProvider();
  context.subscriptions.push(
    tree,
    vscode.window.createTreeView('emdroid.devices', { treeDataProvider: tree }),
  );

  let client: AdbClient | undefined;
  let watcher: DeviceWatcher | undefined;
  let resolving: Promise<AdbClient | undefined> | undefined;

  /** Resolves adb once, then reuses it. Returns undefined if adb is missing. */
  function ensureAdb(): Promise<AdbClient | undefined> {
    // Memoised on the promise, not the result, so two commands racing at
    // startup cannot spawn two adb servers.
    resolving ??= (async () => {
      try {
        const resolution = await resolveAdb(registry, logger.scope('adb'), readConfig().adbPath);
        const adb = new AdbClient(registry, logger.scope('adb'), resolution.path);
        const deviceWatcher = new DeviceWatcher(adb, logger.scope('devices'));
        context.subscriptions.push(
          deviceWatcher,
          deviceWatcher.onDidChangeDevices((devices) => tree.setDevices(devices)),
        );
        client = adb;
        watcher = deviceWatcher;
        deviceWatcher.start();
        return adb;
      } catch (err) {
        // Not memoised as a failure: installing platform-tools or fixing the
        // setting should work without reloading the window.
        resolving = undefined;
        if (err instanceof AdbNotFoundError) {
          await showFailure('adb-not-found', err.message, () => logger.show());
          return undefined;
        }
        throw err;
      }
    })();
    return resolving;
  }

  /**
   * Resolves the device a command should act on.
   *
   * The tree view passes a node; the command palette passes nothing, in which
   * case a single attached device is used without asking and several produce a
   * quick pick. Never guessing between two devices is the point -- adb's own
   * `-d` flag guesses, and that is how you tap the wrong phone.
   */
  async function pickDevice(node?: DeviceNode): Promise<AdbDevice | undefined> {
    if (node) return node.device;
    const adb = await ensureAdb();
    if (!adb || !watcher) return undefined;
    await watcher.refresh();
    const online = watcher.devices.filter((d) => d.state === 'device');
    if (online.length === 0) {
      const offline = watcher.devices[0];
      if (offline) {
        await showFailure(
          offline.state === 'unauthorized' ? 'device-unauthorized' : 'device-offline',
          `${offline.serial} is ${offline.state}.`,
          () => logger.show(),
        );
      } else {
        void vscode.window.showInformationMessage('EMDroid: no Android device is attached.');
      }
      return undefined;
    }
    if (online.length === 1) return online[0];
    const choice = await vscode.window.showQuickPick(
      online.map((device) => ({
        label: device.model ?? device.serial,
        description: device.serial,
        device,
      })),
      { title: 'EMDroid: which device?' },
    );
    return choice?.device;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('emdroid.showDiagnostics', () => {
      logger.show();
      log.info(`adb: ${client?.path ?? 'not resolved yet'}`);
      log.info(`VSCODE_PROXY_URI=${process.env['VSCODE_PROXY_URI'] ?? '<unset>'}`);
      log.info(`appHost=${vscode.env.appHost} remoteName=${vscode.env.remoteName ?? '<none>'}`);
      log.info(`uiKind=${vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop'}`);
    }),

    vscode.commands.registerCommand('emdroid.refreshDevices', async () => {
      const adb = await ensureAdb();
      if (adb) await watcher?.refresh();
    }),

    /**
     * Phase 0 instrument. Replays the committed fixture through the real
     * transport -- stream server, `asExternalUri`, the proxy hop, the binary
     * framing, the decoder and the renderer -- with no device and no adb.
     *
     * When nothing paints, running this first tells you whether the problem is
     * the transport or the capture, which otherwise look identical.
     */
    vscode.commands.registerCommand('emdroid.transportSpike', async () => {
      const fixture = vscode.Uri.joinPath(
        context.extensionUri,
        'test',
        'fixtures',
        'sample-540x1200.h264',
      );
      await sessions.open(
        { serial: 'fixture', model: 'EMDroid transport spike', kind: 'screenrecord' },
        (sourceLog) => ({
          source: new FixtureFrameSource(sourceLog, fixture.fsPath),
          input: undefined,
        }),
      );
    }),

    vscode.commands.registerCommand('emdroid.mirror', async (node?: DeviceNode) => {
      const device = await pickDevice(node);
      const adb = await ensureAdb();
      if (!device || !adb) return;

      // `describeDevice` is awaited here rather than inside the factory because
      // the factory is synchronous: the SDK level picks the source and the
      // `--time-limit` flag, so it has to be known before the session exists.
      let info;
      try {
        info = await adb.describeDevice(device.serial);
      } catch (err) {
        log.error(`could not describe ${device.serial}`, err);
        await showFailure('device-offline', 'The device stopped responding.', () => logger.show());
        return;
      }

      const config = readConfig();
      const kind = chooseSourceKind(config.source, info.sdkInt);
      await sessions.open({ serial: info.serial, model: info.model, kind }, (sourceLog) =>
        createSource(sourceLog, adb, info, config, kind),
      );
    }),

    vscode.commands.registerCommand('emdroid.screenshot', async (node?: DeviceNode) => {
      const device = await pickDevice(node);
      const adb = await ensureAdb();
      if (!device || !adb) return;
      await saveScreenshot(adb, device, log, () => logger.show());
    }),

    vscode.commands.registerCommand('emdroid.reconnect', async (node?: DeviceNode) => {
      const device = await pickDevice(node);
      if (!device) return;
      sessions.close(device.serial);
      await watcher?.refresh();
    }),
  );

  // Not awaited: activation must not wait on a process spawn, but the device
  // list should be populated by the time the user looks at it.
  void ensureAdb();

  log.info('EMDroid activated');
}

/**
 * Captures one PNG with `screencap -p` and asks where to put it.
 *
 * `exec-out`, not `shell`: a pty would rewrite every `\n` in the PNG and the
 * file would be quietly corrupt. A save dialog rather than a guessed path,
 * because under code-server the workspace is on the remote and a "Downloads"
 * folder would be the wrong machine's.
 */
async function saveScreenshot(
  adb: AdbClient,
  device: AdbDevice,
  log: ReturnType<Logger['scope']>,
  showLog: () => void,
): Promise<void> {
  const label = device.model ?? device.serial;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `EMDroid: capturing ${label}` },
    () => adb.execOut(device.serial, ['screencap', '-p'], 30000),
  );

  if (result.code !== 0 || result.stdout.length === 0) {
    const classified = classifyAdbError(result.stderr);
    log.error(`screencap failed (${result.code}): ${result.stderr.trim()}`);
    await showFailure(classified.code, 'The screenshot could not be captured.', showLog);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${label.replace(/[^\w.-]+/g, '_')}-${stamp}.png`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    ...(folder ? { defaultUri: vscode.Uri.joinPath(folder, name) } : {}),
    filters: { Images: ['png'] },
    saveLabel: 'Save Screenshot',
  });
  if (!target) return;

  await vscode.workspace.fs.writeFile(target, result.stdout);
  log.info(`screenshot saved to ${target.fsPath}`);
  const open = await vscode.window.showInformationMessage(
    `EMDroid: saved ${name}`,
    'Open',
  );
  if (open === 'Open') await vscode.commands.executeCommand('vscode.open', target);
}

export function deactivate(): void {
  // Everything is registered in `context.subscriptions`, which VS Code disposes
  // for us -- including the child-process registry, which is what guarantees no
  // orphaned recorder survives a window reload.
}
