import { AKEYCODE } from '../common/keys.js';
import {
  BIN_ACCESS_UNIT,
  type BootConfig,
  type HostMessage,
  type SessionState,
  type WebviewCapabilities,
} from '../common/protocol.js';
import { StillPipeline } from './decode/StillPipeline.js';
import { VideoPipeline } from './decode/VideoPipeline.js';
import { PointerMapper, toStreamPoint } from './input/PointerMapper.js';
import { translateKey } from './input/KeyMapper.js';
import { CanvasRenderer } from './render/CanvasRenderer.js';
import { Transport } from './Transport.js';

/** The codecs we claim in the `ready` handshake, so the host can pick a source. */
const PROBE_CODECS = ['avc1.640020', 'avc1.42E01E'];

const METRICS_INTERVAL_MS = 1000;

/** Fractions of the viewport per wheel notch, tuned to feel like a flick. */
const SCROLL_SCALE = 1 / 600;

function main(): void {
  const boot = readBoot();
  const canvas = requireElement<HTMLCanvasElement>('screen');
  const overlay = requireElement<HTMLDivElement>('overlay');
  const stats = requireElement<HTMLSpanElement>('stats');

  const renderer = new CanvasRenderer(canvas);
  const pointers = new PointerMapper();
  let lastState: SessionState = 'starting';
  let painted = false;
  let capabilities: WebviewCapabilities | undefined;

  const transport = new Transport(boot.streamUrl, {
    binary: (header, payload) => {
      if (header.kind !== BIN_ACCESS_UNIT) return;
      video.decode(payload, header.key, header.ptsUs);
    },
    message: (message) => onHostMessage(message),
    status: (status, detail) => {
      if (status === 'open') {
        // Re-announced on every connect, not just the first: after a reconnect
        // the host has a fresh socket and no memory of the old handshake.
        if (capabilities) transport.send({ t: 'ready', capabilities });
        setOverlay('Waiting for the first frame…');
        return;
      }
      if (status === 'connecting') {
        setOverlay('Connecting…');
        return;
      }
      // A drop invalidates every assumption: fingers are no longer down, and
      // the decoder's reference frames are stale once the stream resumes.
      pointers.reset();
      video.invalidate();
      setOverlay(detail ? `Disconnected — ${detail}. Reconnecting…` : 'Reconnecting…');
    },
  });

  const video = new VideoPipeline({
    frame: (frame) => {
      renderer.present(frame);
      if (!painted) {
        painted = true;
        clearOverlay();
      }
    },
    failure: (message) => {
      log('warn', message);
      setOverlay(message);
    },
    needKeyFrame: () => transport.send({ t: 'keyframe' }),
  });

  const stills = new StillPipeline((bitmap) => {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    clearOverlay();
  });

  function onHostMessage(message: HostMessage): void {
    switch (message.t) {
      case 'hello':
        log('debug', `hello from ${message.model} via ${message.source}`);
        break;
      case 'format':
        log('info', `format ${message.codecString} ${message.width}x${message.height}`);
        video.configure(message);
        break;
      case 'state':
        lastState = message.state;
        // Deliberately does not clear the canvas: a stall must leave the last
        // good picture on screen rather than flashing to black.
        if (message.state === 'stalled') setOverlay('Stream stalled — recovering…');
        else if (message.state === 'streaming' && painted) clearOverlay();
        break;
      case 'still':
        void stills.present(message);
        break;
      case 'error':
        setOverlay(message.message);
        log('error', message.message);
        break;
      case 'pong':
        break;
    }
  }

  function setOverlay(text: string): void {
    overlay.textContent = text;
    overlay.hidden = false;
  }

  function clearOverlay(): void {
    overlay.hidden = true;
  }

  function log(level: 'error' | 'warn' | 'info' | 'debug' | 'trace', message: string): void {
    transport.send({ t: 'log', level, message });
  }

  // -- input -----------------------------------------------------------------

  const sendPointer = (action: 'down' | 'move' | 'up' | 'cancel', event: PointerEvent): void => {
    const message = pointers.translate(action, canvas.getBoundingClientRect(), event);
    if (message) transport.send(message);
  };

  canvas.addEventListener('pointerdown', (event) => {
    // Capture so a drag that leaves the canvas keeps delivering moves, which is
    // what makes a swipe off the edge of the screen work.
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();
    sendPointer('down', event);
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (pointers.active === 0) return;
    sendPointer('move', event);
  });
  canvas.addEventListener('pointerup', (event) => sendPointer('up', event));
  canvas.addEventListener('pointercancel', (event) => sendPointer('cancel', event));
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener(
    'wheel',
    (event) => {
      const point = toStreamPoint(canvas.getBoundingClientRect(), event.clientX, event.clientY);
      transport.send({
        t: 'scroll',
        x: point.x,
        y: point.y,
        dx: -event.deltaX * SCROLL_SCALE,
        dy: -event.deltaY * SCROLL_SCALE,
      });
      event.preventDefault();
    },
    { passive: false },
  );

  canvas.addEventListener('keydown', (event) => {
    const message = translateKey(event);
    if (!message) return;
    transport.send(message);
    // Only swallow what we actually forwarded, so the editor keeps its own
    // shortcuts while the panel has focus.
    event.preventDefault();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-key]')) {
    const name = button.dataset['key'];
    const keyCode = name !== undefined && name in AKEYCODE ? AKEYCODE[name as keyof typeof AKEYCODE] : undefined;
    if (keyCode === undefined) continue;
    button.addEventListener('click', () => {
      transport.send({ t: 'key', action: 'press', keyCode, metaState: 0 });
      canvas.focus();
    });
  }

  // -- metrics ---------------------------------------------------------------

  setInterval(() => {
    const fps = renderer.takePainted() * (1000 / METRICS_INTERVAL_MS);
    const queue = video.queueSize;
    transport.send({ t: 'metrics', fps, decodeQueue: queue });
    const { width, height } = renderer.size;
    stats.textContent =
      lastState === 'streaming' || painted
        ? `${width}x${height} · ${fps.toFixed(0)} fps${queue > 1 ? ` · queue ${queue}` : ''}`
        : lastState;
  }, METRICS_INTERVAL_MS);

  // -- handshake -------------------------------------------------------------

  // The degraded still path travels over `postMessage`, because it has to work
  // in exactly the case where the socket does not.
  window.addEventListener('message', (event) => {
    const data: unknown = event.data;
    if (typeof data === 'object' && data !== null && (data as HostMessage).t === 'still') {
      void stills.present(data as Extract<HostMessage, { t: 'still' }>);
    }
  });

  void probeCapabilities().then((probed) => {
    capabilities = probed;
    if (transport.open) transport.send({ t: 'ready', capabilities: probed });
  });
  transport.connect();
}

/** Measures what this browser can decode rather than assuming it from a version. */
async function probeCapabilities(): Promise<WebviewCapabilities> {
  const supportedCodecs: string[] = [];
  for (const codec of PROBE_CODECS) {
    if (await VideoPipeline.supports(codec)) supportedCodecs.push(codec);
  }
  return { videoDecoder: VideoPipeline.available, supportedCodecs };
}

function readBoot(): BootConfig {
  const raw = document.body.dataset['boot'];
  if (!raw) throw new Error('the panel was rendered without a boot config');
  return JSON.parse(raw) as BootConfig;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`the panel is missing #${id}`);
  return element as T;
}

main();
