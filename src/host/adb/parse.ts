/**
 * Pure parsers for adb's text output. Kept free of node and of vscode so they
 * can be unit tested directly against captured strings.
 */

export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'no-permissions' | 'unknown';

export interface AdbDevice {
  readonly serial: string;
  readonly state: DeviceState;
  /** `model:SM_G996B` -> `SM G996B`, or undefined when adb did not report one. */
  readonly model: string | undefined;
  readonly product: string | undefined;
  readonly transportId: string | undefined;
  /** True for `adb connect` style serials, which survive a USB unplug. */
  readonly isNetwork: boolean;
}

const STATE_MAP: Readonly<Record<string, DeviceState>> = {
  device: 'device',
  offline: 'offline',
  unauthorized: 'unauthorized',
  authorizing: 'offline',
  connecting: 'offline',
  recovery: 'unknown',
  sideload: 'unknown',
  bootloader: 'unknown',
  rescue: 'unknown',
  host: 'unknown',
};

/**
 * Parses `adb devices -l`.
 *
 * Real output from the reference device:
 *
 *     List of devices attached
 *     RRCR1005P1X    device usb:20-2 product:t2sxxx model:SM_G996B device:t2s transport_id:3293
 *
 * Also handles the short form (`adb devices`), the `no permissions` state --
 * which is several words and so cannot be read as a single token -- and the
 * `* daemon started successfully *` noise adb prints on a cold start.
 */
export function parseDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('List of devices')) continue;
    if (line.startsWith('*')) continue;
    if (line.startsWith('adb server')) continue;

    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const serial = match[1] as string;
    const rest = (match[2] as string).trim();

    // `no permissions` carries a parenthetical hint; collapse it to one token.
    const stateWord = rest.startsWith('no permissions')
      ? 'no-permissions'
      : (rest.split(/\s+/)[0] ?? '');

    const state: DeviceState =
      stateWord === 'no-permissions' ? 'no-permissions' : (STATE_MAP[stateWord] ?? 'unknown');

    const fields = parseKeyValues(rest);
    devices.push({
      serial,
      state,
      model: fields.model === undefined ? undefined : fields.model.replace(/_/g, ' '),
      product: fields.product,
      transportId: fields.transport_id,
      isNetwork: isNetworkSerial(serial),
    });
  }
  return devices;
}

function parseKeyValues(rest: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const token of rest.split(/\s+/)) {
    const i = token.indexOf(':');
    if (i > 0) out[token.slice(0, i)] = token.slice(i + 1);
  }
  return out;
}

/** `192.168.1.5:5555` or an IPv6 form -- anything with a port suffix. */
export function isNetworkSerial(serial: string): boolean {
  return /:\d{1,5}$/.test(serial);
}

/**
 * Parses the length-prefixed stream from `adb track-devices`.
 *
 * The host service frames each snapshot as four hex digits of length followed
 * by that many bytes, e.g. `0013RRCR1005P1X\tdevice\n`. An empty list is the
 * literal `0000`. Returns the complete payloads plus whatever tail could not
 * be parsed yet, which the caller must feed back in with the next chunk.
 */
export function parseTrackDevices(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let i = 0;
  while (i + 4 <= buffer.length) {
    const header = buffer.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      // Desynchronised. Dropping the stream is better than emitting garbage;
      // the watcher re-reads the full list on every signal anyway.
      return { payloads, rest: '' };
    }
    const length = Number.parseInt(header, 16);
    if (i + 4 + length > buffer.length) break;
    payloads.push(buffer.slice(i + 4, i + 4 + length));
    i += 4 + length;
  }
  return { payloads, rest: buffer.slice(i) };
}

export interface DisplaySize {
  readonly width: number;
  readonly height: number;
}

/**
 * Parses `wm size`, which reports an override line when the resolution has
 * been changed from the physical one:
 *
 *     Physical size: 1080x2400
 *     Override size: 720x1600
 *
 * The override wins -- that is what the compositor actually renders, and so
 * what `input tap` coordinates are measured in.
 */
export function parseWmSize(stdout: string): DisplaySize | undefined {
  let physical: DisplaySize | undefined;
  let override: DisplaySize | undefined;
  for (const line of stdout.split('\n')) {
    const m = /^\s*(Physical|Override) size:\s*(\d+)x(\d+)\s*$/.exec(line);
    if (!m) continue;
    const size = { width: Number(m[2]), height: Number(m[3]) };
    if (m[1] === 'Override') override = size;
    else physical = size;
  }
  return override ?? physical;
}

/**
 * Parses the current rotation out of `dumpsys window` / `dumpsys display`.
 * Returns 0, 1, 2 or 3 (quarter turns), or undefined when not found.
 *
 * `mCurrentRotation` is the field `dumpsys window` prints on the reference
 * device, so it has to be listed: without it the only match in a real dump
 * would come from an unrelated line, or none at all.
 */
export function parseRotation(stdout: string): number | undefined {
  const m =
    /(?:mCurrentRotation|mCurrentOrientation|mRotation|orientation)=(?:ROTATION_)?(\d)/.exec(stdout);
  if (!m) return undefined;
  const value = Number(m[1]);
  return value >= 0 && value <= 3 ? value : undefined;
}

/** Parses `getprop` output in the `[key]: [value]` form. */
export function parseGetProps(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]\s*$/.exec(line.trim());
    if (m) out.set(m[1] as string, m[2] as string);
  }
  return out;
}

/**
 * Turns adb's stderr into something actionable. adb exits non-zero with a
 * one-line reason far more often than it throws, so this is the main error
 * path, not an edge case.
 */
export function classifyAdbError(stderr: string): {
  code: 'device-unauthorized' | 'device-offline' | 'device-gone' | 'adb-not-found' | 'source-failed';
  hint: string;
} {
  const s = stderr.toLowerCase();
  if (s.includes('unauthorized')) {
    return {
      code: 'device-unauthorized',
      hint: 'Unlock the device and accept the "Allow USB debugging" prompt.',
    };
  }
  if (s.includes('device offline')) {
    return { code: 'device-offline', hint: 'The device is connected but not responding. Re-plug it.' };
  }
  // adb interposes the serial: `error: device 'RRCR1005P1X' not found`. A
  // substring test for "device not found" never fires on a real message.
  if (/device\b.*\bnot found/.test(s) || s.includes('no devices') || s.includes('device still connecting')) {
    return { code: 'device-gone', hint: 'The device is no longer attached.' };
  }
  if (s.includes('enoent') || s.includes('command not found')) {
    return { code: 'adb-not-found', hint: 'Set emdroid.adbPath to your adb executable.' };
  }
  return { code: 'source-failed', hint: stderr.trim() || 'adb failed without a message.' };
}
