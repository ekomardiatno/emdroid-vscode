/**
 * The phase 1 hardware gate, run against a real attached device.
 *
 * Deliberately **not** part of `npm test`: it needs a device, it takes about a
 * minute, and it wakes the screen. Run it with `npm run verify:device`.
 *
 * It drives the actual host classes -- `resolveAdb`, `AdbClient`,
 * `DisplayWatcher`, `ScreenrecordFrameSource`, `AdbInputSink`,
 * `ScreencapStillSource` -- rather than re-implementing adb calls, so a pass
 * means the shipped code path works, not that a similar one does. Everything
 * the plan claims about this device is re-measured here, because those numbers
 * are what the design rests on and they are the kind of thing that drifts with
 * an OS update.
 *
 * What it will not do: tap the screen (a stray tap opens an app) or write a
 * device setting (`show_touches`, `user_rotation`). Rotation, auto-resume on
 * replug and anything that has to be *looked* at stay manual.
 *
 *   EMDROID_SERIAL     pick a device when several are attached
 *   EMDROID_MAX_WIDTH  default 720, as the setting's default
 *   EMDROID_BIT_RATE   default 8M
 *   EMDROID_LOG        log level to capture; printed on failure or --verbose
 */

import { AdbClient } from '../../src/host/adb/AdbClient.ts';
import { resolveAdb } from '../../src/host/adb/AdbPath.ts';
import { ChildProcessRegistry } from '../../src/host/childProcesses.ts';
import { Logger } from '../../src/host/log.ts';
import type { AccessUnit, VideoFormat } from '../../src/host/source/FrameSource.ts';
import { chooseSourceKind } from '../../src/host/source/registry.ts';
import { AdbInputSink } from '../../src/host/source/screenrecord/AdbInputSink.ts';
import {
  ScreenrecordFrameSource,
  captureSize,
} from '../../src/host/source/screenrecord/ScreenrecordFrameSource.ts';
import { ScreencapStillSource } from '../../src/host/source/still/ScreencapStillSource.ts';
import type { StillMessage } from '../../src/common/protocol.ts';
import { capturedLogLines } from '../stub/vscode.ts';

/** Wakes the screen without touching it, so the capture is not of a black panel. */
const KEYCODE_WAKEUP = 224;

/** Long enough to see a steady frame rate, short enough not to be a chore. */
const CAPTURE_MS = 6000;

/** A key-frame request is a recorder restart: kill, pkill, spawn, ~600 ms. */
const KEYFRAME_TIMEOUT_MS = 10000;

const verbose = process.argv.includes('--verbose');
const maxWidth = Number(process.env['EMDROID_MAX_WIDTH'] ?? '720');
const bitRate = process.env['EMDROID_BIT_RATE'] ?? '8M';

let failures = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail === '' ? '' : ` -- ${detail}`}`);
}

/** A number worth recording that nothing can sensibly assert on. */
function measured(name: string, detail: string): void {
  console.log(`  ..   ${name} -- ${detail}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

async function main(): Promise<void> {
  const logger = new Logger();
  logger.setLevel(process.env['EMDROID_LOG'] ?? 'info');
  const registry = new ChildProcessRegistry(logger.scope('proc'));

  section('adb');
  const resolution = await resolveAdb(registry, logger.scope('adb'), '');
  check('resolveAdb found an executable', true, `${resolution.path} (${resolution.origin})`);
  measured('adb version', resolution.version);

  const client = new AdbClient(registry, logger.scope('adb'), resolution.path);

  section('device');
  const devices = await client.listDevices();
  const online = devices.filter((d) => d.state === 'device');
  const wanted = process.env['EMDROID_SERIAL'];
  const device = wanted ? online.find((d) => d.serial === wanted) : online[0];
  if (!device) {
    check(
      'exactly one usable device',
      false,
      devices.length === 0
        ? 'nothing attached'
        : `attached: ${devices.map((d) => `${d.serial}=${d.state}`).join(', ')}`,
    );
    finish(logger);
    return;
  }
  if (online.length > 1 && !wanted) {
    measured('several devices attached', `using ${device.serial}; set EMDROID_SERIAL to choose`);
  }
  const serial = device.serial;
  check('device is online', true, `${serial} (${device.model ?? 'unknown model'})`);

  const info = await client.describeDevice(serial);
  measured(
    'describeDevice',
    `${info.model}, Android ${info.androidVersion} (SDK ${info.sdkInt}), ` +
      `${info.physicalWidth}x${info.physicalHeight} physical`,
  );
  check('SDK supports the h264 recorder', info.sdkInt >= 24, `sdkInt=${info.sdkInt}`);
  check(
    'auto source preference picks screenrecord',
    chooseSourceKind('auto', info.sdkInt) === 'screenrecord',
    `sdkInt=${info.sdkInt}`,
  );
  check(
    'no recorder is running before we start',
    !(await client.hasRunningRecorder(serial)),
    'a leftover screenrecord holds the one hardware encoder',
  );

  section('input (adb shell input)');
  // `key()` is the one sink path that needs no geometry, which is why a
  // standing-still geometry source is honest here -- and why this can run
  // before the recorder, waking the screen so the capture is not black.
  // Pointer mapping is covered by the unit tests; a stray tap opens an app.
  const sink = new AdbInputSink(logger.scope('input'), client, serial, { geometry: undefined });
  const latencies: number[] = [];
  const latencySub = sink.onDidMeasureLatency((ms) => latencies.push(ms));
  for (let i = 0; i < 3; i++) sink.key({ t: 'key', action: 'press', keyCode: KEYCODE_WAKEUP, metaState: 0 });
  const sawLatency = await waitFor(() => latencies.length >= 3, 15000);
  latencySub.dispose();
  check('keyevent round-trips through the persistent shell', sawLatency, `${latencies.length}/3 acknowledged`);
  if (latencies.length > 0) {
    measured(
      'host-to-device input latency',
      `${latencies.map((ms) => `${ms}ms`).join(', ')} (phase 2 targets ~50ms)`,
    );
  }

  section(`screenrecord (maxWidth=${maxWidth}, bitRate=${bitRate})`);
  const source = new ScreenrecordFrameSource(logger.scope('screenrecord'), client, serial, {
    maxWidth,
    bitRate,
    sdkInt: info.sdkInt,
  });

  const units: AccessUnit[] = [];
  /** One per spawn: a restart re-publishes, and the two must agree. */
  const formats: VideoFormat[] = [];
  let firstUnitAt = 0;
  const failureDetails: string[] = [];
  const subs = [
    source.onAccessUnit((unit) => {
      if (units.length === 0) firstUnitAt = Date.now();
      units.push(unit);
    }),
    source.onDidChangeFormat((f) => formats.push(f)),
    source.onDidFail((f) => failureDetails.push(`${f.code}: ${f.message}`)),
  ];

  const spawnedAt = Date.now();
  await source.start();
  const startReturnedAt = Date.now();
  const sawFirstUnit = await waitFor(() => units.length > 0, 8000);
  check(
    'the recorder produces video',
    sawFirstUnit,
    sawFirstUnit
      ? `first access unit ${firstUnitAt - spawnedAt}ms after start() was called`
      : failureDetails.join('; ') || 'nothing arrived in 8s',
  );
  if (!sawFirstUnit) {
    source.dispose();
    for (const s of subs) s.dispose();
    finish(logger);
    return;
  }
  measured(
    'start() overhead before the spawn',
    `${startReturnedAt - spawnedAt}ms (wm size + rotation read)`,
  );
  const format = formats[0];

  const geometry = source.displays.geometry;
  check(
    'the display geometry is known',
    geometry !== undefined,
    // Never undefined once started: the sink drops every event without it, and
    // the recorder would guess a different size on its next restart.
    geometry
      ? `${geometry.width}x${geometry.height}, rotation ${geometry.rotation}`
      : 'DisplayWatcher.geometry is undefined after start()',
  );
  const expected = captureSize(
    geometry?.width ?? info.physicalWidth,
    geometry?.height ?? info.physicalHeight,
    maxWidth,
  );
  check(
    'the stream size is the size we asked for',
    format?.width === expected.width && format?.height === expected.height,
    `SPS says ${format?.width}x${format?.height}, captureSize() wanted ${expected.width}x${expected.height}`,
  );
  check(
    'the codec string came from the SPS',
    /^avc1\.[0-9a-f]{6}$/i.test(format?.codecString ?? ''),
    `${format?.codecString} -- hardcoding this is the trap; it varies with capture size`,
  );
  check(
    'rotation is reflected in the capture orientation',
    geometry === undefined ||
      (geometry.width > geometry.height) === ((format?.width ?? 0) > (format?.height ?? 0)),
    `display ${geometry?.width}x${geometry?.height} vs stream ${format?.width}x${format?.height}`,
  );

  await sleep(CAPTURE_MS);
  const keys = units.filter((u) => u.key);
  const bytes = units.reduce((n, u) => n + u.data.length, 0);
  const elapsed = (Date.now() - firstUnitAt) / 1000;
  measured(
    'throughput',
    `${units.length} access units in ${elapsed.toFixed(1)}s ` +
      `(${(units.length / elapsed).toFixed(1)} fps, ` +
      `${((bytes / elapsed / 1024) | 0)} KiB/s at ${bitRate})`,
  );
  // Not a check: `screenrecord` encodes on surface updates, so an idle lock
  // screen legitimately yields 1-2 fps while the same device under a scrolling
  // list yields ~200 KiB/s. The number that matters is the one in the status
  // bar while someone is actually using the mirror.
  measured('   (note)', 'a still screen produces few frames; this is content-dependent');
  check('the stream opens on a key frame', units[0]?.key === true, `first unit key=${units[0]?.key}`);
  check(
    'every key unit carries its parameter sets',
    keys.every((u) => startsWithNal(u.data, 0x67)),
    // Landmine 3: without this a late joiner cannot decode the key frame it
    // was handed, and the ~10s IDR interval means it waits that long to find out.
    `${keys.length} key units, each should begin 00 00 00 01 67 (SPS)`,
  );
  check(
    'every unit begins with a 4-byte start code',
    units.every((u) => hasStartCode(u.data)),
    'a truncated unit would decode as corruption, not as an error',
  );
  check(
    'presentation timestamps strictly increase',
    units.every((u, i) => i === 0 || u.ptsUs > (units[i - 1]?.ptsUs ?? -1)),
    'two units sharing a timestamp stall the decoder',
  );
  measured(
    'IDR interval',
    `${keys.length} key frame(s) in ${elapsed.toFixed(1)}s -- the plan measured ~10s apart`,
  );

  section('key-frame request');
  const keysBefore = keys.length;
  source.requestKeyFrame();
  const sawNewKey = await waitFor(
    () => units.filter((u) => u.key).length > keysBefore,
    KEYFRAME_TIMEOUT_MS,
  );
  check(
    'requestKeyFrame() restarts the recorder and a key frame follows',
    sawNewKey,
    sawNewKey ? 'phase 1 has no other lever' : `nothing in ${KEYFRAME_TIMEOUT_MS}ms`,
  );
  check(
    'the restart keeps the same capture size',
    formats.every((f) => f.width === format?.width && f.height === format?.height),
    // A restart that re-reads an unknown geometry picks a different size, and
    // the picture silently changes aspect ratio without a rotation.
    formats.map((f) => `${f.width}x${f.height}`).join(' then '),
  );

  section('teardown');
  source.dispose();
  for (const s of subs) s.dispose();
  // dispose() cannot await its own pkill, so give the device a moment before
  // asking. This is landmine 4: an orphan here breaks the *next* session.
  await sleep(2000);
  check(
    'no screenrecord survives dispose()',
    !(await client.hasRunningRecorder(serial)),
    'an orphan holds the hardware encoder and every later start fails opaquely',
  );

  section('screencap stills (degraded mode)');
  const still = new ScreencapStillSource(logger.scope('still'), client, serial);
  const stills: Array<{ message: StillMessage; at: number }> = [];
  const stillSub = still.onStill((message) => stills.push({ message, at: Date.now() }));
  const stillStartedAt = Date.now();
  await still.start();
  const sawStills = await waitFor(() => stills.length >= 2, 30000);
  stillSub.dispose();
  still.dispose();
  check('screencap produces stills', stills.length > 0, `${stills.length} captured`);
  const first = stills[0];
  if (first) {
    const png = Buffer.from(first.message.png, 'base64');
    check(
      'the still is a real PNG',
      png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      // `exec-out`, not `shell`: a pty rewrites every \n in the PNG and the
      // corruption is silent.
      `${(png.length / 1024 / 1024).toFixed(2)} MiB, ${first.message.width}x${first.message.height}`,
    );
    measured('first still', `${first.at - stillStartedAt}ms after start()`);
  }
  if (sawStills && stills.length >= 2) {
    const gap = (stills[1]?.at ?? 0) - (stills[0]?.at ?? 0);
    measured(
      'still cadence',
      `${gap}ms apart = ${(1000 / gap).toFixed(2)} fps -- the plan measured ~0.4 fps`,
    );
  }

  sink.dispose();
  // The sink lifts any held finger and tears its shell down 150ms later.
  await sleep(300);
  registry.killAll();
  finish(logger);
}

function startsWithNal(data: Uint8Array, nalType: number): boolean {
  return hasStartCode(data) && data[4] === nalType;
}

function hasStartCode(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1;
}

function finish(logger: Logger): void {
  if (verbose || failures > 0) {
    section(`extension log (${capturedLogLines.length} lines)`);
    for (const line of capturedLogLines) console.log(`  ${line}`);
  }
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  logger.dispose();
  // Explicit: a persistent shell or the rotation logcat can keep the loop alive
  // for seconds after everything useful has been measured.
  process.exit(failures === 0 ? 0 : 1);
}

await main();
