import type { VideoFormatMessage } from '../../common/protocol.js';

export interface VideoPipelineHandlers {
  readonly frame: (frame: VideoFrame) => void;
  readonly failure: (message: string) => void;
  /** Called when the pipeline needs a fresh random-access point. */
  readonly needKeyFrame: () => void;
}

/**
 * Wraps `VideoDecoder` with the three behaviours that are not optional.
 *
 * 1. **No `description` in `configure()`.** Supplying one switches WebCodecs
 *    into AVCC (length-prefixed) mode, and our stream is Annex B. Omitting it
 *    is what selects Annex B -- so the parameter sets must travel *in* the
 *    bitstream, which is exactly why the host prepends SPS+PPS to every key
 *    access unit.
 * 2. **Never feed a delta frame first.** A decoder configured or reset mid-GOP
 *    rejects the first non-key chunk and goes to `closed`, which looks
 *    identical to a transport failure. Drop deltas until a key arrives and ask
 *    the host for one.
 * 3. **Errors are recoverable by reconfiguring, not by retrying.** A `closed`
 *    decoder never accepts another chunk.
 */
export class VideoPipeline {
  readonly #handlers: VideoPipelineHandlers;

  #decoder: VideoDecoder | undefined;
  #format: VideoFormatMessage | undefined;
  #awaitingKey = true;
  #droppedBeforeKey = 0;

  constructor(handlers: VideoPipelineHandlers) {
    this.#handlers = handlers;
  }

  static get available(): boolean {
    return typeof VideoDecoder !== 'undefined';
  }

  /** Probes a codec string without configuring, for the `ready` handshake. */
  static async supports(codecString: string): Promise<boolean> {
    if (!VideoPipeline.available) return false;
    try {
      const result = await VideoDecoder.isConfigSupported({
        codec: codecString,
        optimizeForLatency: true,
      });
      return result.supported === true;
    } catch {
      return false;
    }
  }

  get queueSize(): number {
    return this.#decoder?.decodeQueueSize ?? 0;
  }

  configure(format: VideoFormatMessage): void {
    // A repeated identical format is the normal case on reconnect. Rebuilding
    // the decoder there would throw away a working one for nothing.
    if (
      this.#decoder?.state === 'configured' &&
      this.#format?.codecString === format.codecString &&
      this.#format.width === format.width &&
      this.#format.height === format.height
    ) {
      return;
    }

    this.#close();
    this.#format = format;

    const decoder = new VideoDecoder({
      output: (frame) => this.#handlers.frame(frame),
      error: (err) => this.#onError(err),
    });
    this.#decoder = decoder;

    try {
      decoder.configure({
        codec: format.codecString,
        // Annex B mode. See the class comment -- do not add `description`.
        optimizeForLatency: true,
        codedWidth: format.width,
        codedHeight: format.height,
      });
    } catch (err) {
      this.#handlers.failure(
        `the decoder rejected ${format.codecString}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.#close();
      return;
    }

    this.#awaitingKey = true;
    this.#droppedBeforeKey = 0;
  }

  decode(data: Uint8Array, key: boolean, ptsUs: number): void {
    const decoder = this.#decoder;
    if (decoder?.state !== 'configured') return;

    if (this.#awaitingKey) {
      if (!key) {
        this.#droppedBeforeKey++;
        // Only nudge once per gap; the host restarts the recorder to honour
        // this and a storm of requests would thrash the encoder.
        if (this.#droppedBeforeKey === 1) this.#handlers.needKeyFrame();
        return;
      }
      this.#awaitingKey = false;
      this.#droppedBeforeKey = 0;
    }

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: ptsUs,
          // `data` is a view onto the socket's ArrayBuffer; EncodedVideoChunk
          // copies it, so the buffer can be released straight after.
          data,
        }),
      );
    } catch (err) {
      this.#onError(err);
    }
  }

  #onError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#handlers.failure(`decode failed: ${message}`);
    // The decoder is closed now and will reject everything. Rebuild from the
    // last known format and wait for a key frame.
    const format = this.#format;
    this.#close();
    if (format) {
      this.configure(format);
      this.#handlers.needKeyFrame();
    }
  }

  #close(): void {
    const decoder = this.#decoder;
    this.#decoder = undefined;
    if (!decoder || decoder.state === 'closed') return;
    try {
      decoder.close();
    } catch {
      // Already closing; nothing to salvage and nothing to report.
    }
  }

  /** Forces the next key frame to re-seed the decoder, e.g. after a stall. */
  invalidate(): void {
    this.#awaitingKey = true;
    this.#droppedBeforeKey = 0;
  }

  dispose(): void {
    this.#close();
    this.#format = undefined;
  }
}
