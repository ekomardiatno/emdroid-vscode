import type { SourceKind } from '../../common/protocol.js';
import type { AdbClient, DeviceInfo } from '../adb/AdbClient.js';
import type { EmdroidConfig, SourcePreference } from '../config.js';
import type { ScopedLogger } from '../log.js';
import type { FrameSource } from './FrameSource.js';
import type { InputSink } from './InputSink.js';
import { AdbInputSink } from './screenrecord/AdbInputSink.js';
import { ScreenrecordFrameSource } from './screenrecord/ScreenrecordFrameSource.js';
import { ScreencapStillSource } from './still/ScreencapStillSource.js';

/**
 * `screenrecord --output-format=h264` needs a reasonably modern platform. Below
 * this the raw H.264 output is unreliable even where the flag is accepted, so
 * stills are the honest answer rather than a stream that may never decode.
 */
const MIN_SCREENRECORD_SDK = 24;

export interface SourceBundle {
  readonly kind: SourceKind;
  readonly source: FrameSource;
  readonly input: InputSink;
}

/**
 * Chooses the capture source and pairs it with a sink.
 *
 * Phase 2 adds one branch here and nothing else: `MirrorSession` only ever
 * sees a `FrameSource` and an `InputSink`.
 */
export function createSource(
  log: ScopedLogger,
  client: AdbClient,
  device: DeviceInfo,
  config: EmdroidConfig,
  kind: SourceKind,
): SourceBundle {
  if (kind === 'still') {
    const source = new ScreencapStillSource(log.child('still'), client, device.serial);
    const input = new AdbInputSink(log.child('input'), client, device.serial, source.displays);
    void input.setShowTouches(config.showTouches);
    return { kind, source, input };
  }

  const source = new ScreenrecordFrameSource(
    log.child('screenrecord'),
    client,
    device.serial,
    { maxWidth: config.maxWidth, bitRate: config.bitRate, sdkInt: device.sdkInt },
  );
  const input = new AdbInputSink(log.child('input'), client, device.serial, source.displays);
  void input.setShowTouches(config.showTouches);
  return { kind, source, input };
}

/**
 * Decided separately from `createSource` because the kind is also what the
 * webview is told it is attached to, and that has to be settled before the
 * session -- and therefore the panel -- exists.
 */
export function chooseSourceKind(preference: SourcePreference, sdkInt: number): SourceKind {
  if (preference === 'still') return 'still';
  if (preference === 'screenrecord') return 'screenrecord';
  return sdkInt >= MIN_SCREENRECORD_SDK ? 'screenrecord' : 'still';
}
