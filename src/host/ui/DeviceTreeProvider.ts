import * as vscode from 'vscode';

import type { AdbDevice, DeviceState } from '../adb/parse.js';

export class DeviceNode extends vscode.TreeItem {
  constructor(readonly device: AdbDevice) {
    super(device.model ?? device.serial, vscode.TreeItemCollapsibleState.None);
    this.id = device.serial;
    this.description = describe(device);
    this.tooltip = new vscode.MarkdownString(
      [`**${device.model ?? 'Android device'}**`, '', `- serial: \`${device.serial}\``, `- state: ${device.state}`].join(
        '\n',
      ),
    );
    this.iconPath = new vscode.ThemeIcon(iconFor(device.state), colourFor(device.state));
    // The `when` clauses in package.json branch on this, so only an online
    // device offers "Mirror" -- an unauthorized one would just fail silently.
    this.contextValue =
      device.state === 'device' ? 'emdroid.device.online' : 'emdroid.device.offline';
  }
}

/**
 * The activity-bar list of devices.
 *
 * Deliberately a `TreeView` and not a `WebviewView`: it holds no media and no
 * process, so collapsing the container costs nothing. All the lifecycle hazard
 * lives in the editor panel, where `retainContextWhenHidden` protects it.
 */
export class DeviceTreeProvider implements vscode.TreeDataProvider<DeviceNode> {
  readonly #emitter = new vscode.EventEmitter<void>();

  /**
   * Pushed in rather than pulled from a watcher, so the view can be registered
   * at activation while adb is still being resolved. An empty list renders the
   * `viewsWelcome` content, which is exactly the right thing to show then.
   */
  #devices: readonly AdbDevice[] = [];

  readonly onDidChangeTreeData = this.#emitter.event;

  setDevices(devices: readonly AdbDevice[]): void {
    this.#devices = devices;
    this.#emitter.fire();
  }

  getTreeItem(element: DeviceNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DeviceNode): DeviceNode[] {
    if (element) return [];
    return this.#devices.map((device) => new DeviceNode(device));
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

function describe(device: AdbDevice): string {
  if (device.state === 'device') return device.serial;
  return `${device.serial} — ${device.state}`;
}

function iconFor(state: DeviceState): string {
  switch (state) {
    case 'device':
      return 'device-mobile';
    case 'unauthorized':
      return 'lock';
    case 'offline':
      return 'debug-disconnect';
    default:
      return 'question';
  }
}

function colourFor(state: DeviceState): vscode.ThemeColor | undefined {
  switch (state) {
    case 'device':
      return new vscode.ThemeColor('charts.green');
    case 'unauthorized':
      return new vscode.ThemeColor('charts.yellow');
    default:
      return new vscode.ThemeColor('charts.red');
  }
}
