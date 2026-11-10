import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  classifyAdbError,
  isNetworkSerial,
  parseDevices,
  parseGetProps,
  parseRotation,
  parseTrackDevices,
  parseWmSize,
} from '../../src/host/adb/parse.ts';

/**
 * Every input below is real adb output, captured from the reference device
 * (SM-G996B, Android 15, SDK 35) or from adb itself. Parsing adb is parsing a
 * human-readable format with no contract, so the only defence against it
 * drifting is pinning the exact strings we have actually seen.
 */

const REAL_DEVICES_LONG = `List of devices attached
RRCR1005P1X            device usb:20-2 product:t2sxxx model:SM_G996B device:t2s transport_id:3293

`;

describe('parseDevices', () => {
  it('parses the measured `adb devices -l` output', () => {
    const devices = parseDevices(REAL_DEVICES_LONG);
    assert.equal(devices.length, 1);
    assert.deepEqual(devices[0], {
      serial: 'RRCR1005P1X',
      state: 'device',
      // Underscores become spaces: adb reports `SM_G996B`, the device calls
      // itself `SM-G996B`, and a UI label wants neither underscore nor a guess
      // at the hyphen.
      model: 'SM G996B',
      product: 't2sxxx',
      transportId: '3293',
      isNetwork: false,
    });
  });

  it('parses the short form with no key-value fields', () => {
    const devices = parseDevices('List of devices attached\nRRCR1005P1X\tdevice\n');
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.serial, 'RRCR1005P1X');
    assert.equal(devices[0]?.state, 'device');
    assert.equal(devices[0]?.model, undefined);
  });

  it('ignores the daemon noise adb prints on a cold start', () => {
    const stdout = `* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
RRCR1005P1X\tdevice
`;
    assert.equal(parseDevices(stdout).length, 1);
  });

  it('reads the multi-word `no permissions` state as one state', () => {
    // This one is a trap: the state is several words plus a parenthetical URL,
    // so splitting on whitespace and taking token 0 yields "no".
    const stdout =
      'List of devices attached\n1234567890\tno permissions (user in plugdev group); see [http://developer.android.com/tools/device.html]\n';
    assert.equal(parseDevices(stdout)[0]?.state, 'no-permissions');
  });

  it('maps the transient states onto something actionable', () => {
    const stdout = `List of devices attached
a\tunauthorized
b\toffline
c\tauthorizing
d\tconnecting
e\tbootloader
f\tsomethingnew
`;
    assert.deepEqual(
      parseDevices(stdout).map((d) => d.state),
      ['unauthorized', 'offline', 'offline', 'offline', 'unknown', 'unknown'],
    );
  });

  it('returns nothing when no device is attached', () => {
    assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
  });

  it('flags network serials, which survive a USB unplug', () => {
    const devices = parseDevices('List of devices attached\n192.168.1.5:5555\tdevice\n');
    assert.equal(devices[0]?.isNetwork, true);
  });
});

describe('isNetworkSerial', () => {
  it('matches a host:port serial', () => {
    assert.equal(isNetworkSerial('192.168.1.5:5555'), true);
    assert.equal(isNetworkSerial('adb-RRCR1005P1X-abc._adb-tls-connect._tcp:5555'), true);
  });

  it('does not match a USB serial', () => {
    assert.equal(isNetworkSerial('RRCR1005P1X'), false);
  });
});

describe('parseTrackDevices', () => {
  it('splits a single length-prefixed snapshot', () => {
    const payload = 'RRCR1005P1X\tdevice\n';
    const frame = payload.length.toString(16).padStart(4, '0') + payload;
    assert.deepEqual(parseTrackDevices(frame), { payloads: [payload], rest: '' });
  });

  it('reads the empty-list snapshot', () => {
    assert.deepEqual(parseTrackDevices('0000'), { payloads: [''], rest: '' });
  });

  it('holds back a partial frame for the next chunk', () => {
    const payload = 'RRCR1005P1X\tdevice\n';
    const frame = payload.length.toString(16).padStart(4, '0') + payload;
    const split = 10;
    const first = parseTrackDevices(frame.slice(0, split));
    assert.deepEqual(first.payloads, []);
    assert.equal(first.rest, frame.slice(0, split));
    // Feeding the tail back in is the documented contract.
    assert.deepEqual(parseTrackDevices(first.rest + frame.slice(split)), {
      payloads: [payload],
      rest: '',
    });
  });

  it('splits several snapshots arriving in one chunk', () => {
    const a = 'a\tdevice\n';
    const b = 'b\toffline\n';
    const frames =
      a.length.toString(16).padStart(4, '0') + a + b.length.toString(16).padStart(4, '0') + b;
    assert.deepEqual(parseTrackDevices(frames), { payloads: [a, b], rest: '' });
  });

  it('abandons the stream rather than emitting garbage when desynchronised', () => {
    assert.deepEqual(parseTrackDevices('not-a-length-prefix'), { payloads: [], rest: '' });
  });
});

describe('parseWmSize', () => {
  it('reads the measured physical size', () => {
    assert.deepEqual(parseWmSize('Physical size: 1080x2400\n'), { width: 1080, height: 2400 });
  });

  it('prefers the override, which is what the compositor renders', () => {
    const stdout = 'Physical size: 1080x2400\nOverride size: 720x1600\n';
    assert.deepEqual(parseWmSize(stdout), { width: 720, height: 1600 });
  });

  it('returns undefined for unparseable output rather than a plausible guess', () => {
    assert.equal(parseWmSize('Error: must be root\n'), undefined);
    assert.equal(parseWmSize(''), undefined);
  });
});

describe('parseRotation', () => {
  /**
   * `ROTATION_n` names **degrees**, and that is the bug this suite asserted its
   * way past once: portrait is `ROTATION_0` under either reading, so taking the
   * name as a quarter-turn index looks right until the device is turned -- and
   * then `ROTATION_90` is out of range, the read falls back to 0, and the
   * recorder is never restarted.
   *
   * Measured on the reference device: `mLandscapeRotation=ROTATION_90`,
   * `mSeascapeRotation=ROTATION_270`, `mUpsideDownRotation=ROTATION_180`, and
   * `dumpsys window | grep -m1 mCurrentRotation` prints one of those four.
   */
  it('reads the ROTATION_n form dumpsys prints, which is in degrees', () => {
    assert.equal(parseRotation('mCurrentRotation=ROTATION_0'), 0);
    assert.equal(parseRotation('      mCurrentRotation=ROTATION_90\n'), 1);
    assert.equal(parseRotation('      mCurrentRotation=ROTATION_180\n'), 2);
    assert.equal(parseRotation('      mCurrentRotation=ROTATION_270\n'), 3);
  });

  it('reads the bare numeric form, which is already a quarter turn', () => {
    // The same dump prints `mRotation=0` a few lines above `mCurrentRotation`.
    assert.equal(parseRotation('mCurrentOrientation=1'), 1);
    assert.equal(parseRotation('    mRotation=3 mDeferredRotationPauseCount=0'), 3);
  });

  it('rejects an out-of-range quarter turn', () => {
    assert.equal(parseRotation('mRotation=7'), undefined);
  });

  it('rejects a degree value that is not a quarter turn', () => {
    assert.equal(parseRotation('mCurrentRotation=ROTATION_45'), undefined);
    assert.equal(parseRotation('mCurrentRotation=ROTATION_360'), undefined);
  });

  it('returns undefined when the field is absent', () => {
    assert.equal(parseRotation('WINDOW MANAGER DISPLAY CONTENTS\n'), undefined);
  });
});

describe('parseGetProps', () => {
  it('parses the bracketed form', () => {
    const props = parseGetProps(`[ro.product.model]: [SM-G996B]
[ro.build.version.sdk]: [35]
[ro.build.version.release]: [15]
`);
    assert.equal(props.get('ro.product.model'), 'SM-G996B');
    assert.equal(props.get('ro.build.version.sdk'), '35');
    assert.equal(props.get('ro.build.version.release'), '15');
  });

  it('keeps an empty value rather than dropping the key', () => {
    // Distinguishing "unset" from "absent" matters: a present-but-empty
    // property means the device answered, so there is nothing to retry.
    const props = parseGetProps('[persist.sys.locale]: []\n');
    assert.equal(props.get('persist.sys.locale'), '');
    assert.equal(props.has('persist.sys.locale'), true);
  });

  it('keeps brackets that appear inside a value', () => {
    const props = parseGetProps('[x]: [a [b] c]\n');
    assert.equal(props.get('x'), 'a [b] c');
  });
});

describe('classifyAdbError', () => {
  it('recognises the states with exactly one fix each', () => {
    assert.equal(classifyAdbError('error: device unauthorized.').code, 'device-unauthorized');
    assert.equal(classifyAdbError('error: device offline').code, 'device-offline');
    assert.equal(classifyAdbError("error: device 'RRCR1005P1X' not found").code, 'device-gone');
    assert.equal(classifyAdbError('error: device still connecting').code, 'device-gone');
    assert.equal(classifyAdbError('spawn adb ENOENT').code, 'adb-not-found');
  });

  it('falls back to the raw message, which is the only diagnostic left', () => {
    const result = classifyAdbError('screenrecord: Unable to get IBinder\n');
    assert.equal(result.code, 'source-failed');
    assert.equal(result.hint, 'screenrecord: Unable to get IBinder');
  });

  it('still says something when adb failed silently', () => {
    assert.equal(classifyAdbError('').hint, 'adb failed without a message.');
  });
});
