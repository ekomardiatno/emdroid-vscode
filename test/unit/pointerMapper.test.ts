import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { translateKey } from '../../src/webview/input/KeyMapper.ts';
import { PointerMapper, toStreamPoint } from '../../src/webview/input/PointerMapper.ts';

/**
 * The input mapping is the one place where a quiet arithmetic mistake produces
 * taps that land in the wrong place -- which reads as "the mirror is broken"
 * rather than as a bug in one function. Hence the exhaustive corner cases.
 */

const RECT = { left: 100, top: 50, width: 400, height: 800 };

describe('toStreamPoint', () => {
  it('maps the corners to the unit square', () => {
    assert.deepEqual(toStreamPoint(RECT, 100, 50), { x: 0, y: 0 });
    assert.deepEqual(toStreamPoint(RECT, 500, 850), { x: 1, y: 1 });
  });

  it('maps the centre to the centre', () => {
    assert.deepEqual(toStreamPoint(RECT, 300, 450), { x: 0.5, y: 0.5 });
  });

  it('is independent of the element size, which is the whole point', () => {
    // Normalising here is what lets the host stay ignorant of the capture size
    // and of rotation: the same gesture on a half-size panel must produce the
    // same coordinates.
    const half = { left: 0, top: 0, width: 200, height: 400 };
    const full = { left: 0, top: 0, width: 400, height: 800 };
    assert.deepEqual(toStreamPoint(half, 50, 100), toStreamPoint(full, 100, 200));
  });

  it('clamps a drag that slips off the edge instead of rejecting it', () => {
    // A real finger that leaves the screen edge keeps touching the edge, so
    // clamping is the behaviour that matches the hardware.
    assert.deepEqual(toStreamPoint(RECT, -1000, -1000), { x: 0, y: 0 });
    assert.deepEqual(toStreamPoint(RECT, 99999, 99999), { x: 1, y: 1 });
  });

  it('never emits NaN, which would reach adb as a literal "NaN"', () => {
    const point = toStreamPoint({ left: 0, top: 0, width: 0, height: 0 }, 10, 10);
    assert.equal(Number.isFinite(point.x), true);
    assert.equal(Number.isFinite(point.y), true);
    assert.deepEqual(point, { x: 0.5, y: 0.5 });
  });

  it('collapses a non-finite client coordinate to 0 rather than propagating it', () => {
    // Both NaN and Infinity land on 0. Infinity arguably "wants" to clamp to 1,
    // but a non-finite coordinate means the event was nonsense, and a corner
    // tap is a less surprising outcome than one on the opposite edge.
    assert.deepEqual(toStreamPoint(RECT, Number.NaN, Number.POSITIVE_INFINITY), { x: 0, y: 0 });
  });
});

describe('PointerMapper', () => {
  let mapper: PointerMapper;

  beforeEach(() => {
    mapper = new PointerMapper();
  });

  const event = (pointerId: number, clientX = 300, clientY = 450, pressure = 0.5) => ({
    pointerId,
    clientX,
    clientY,
    pressure,
  });

  it('assigns slot 0 to the first pointer', () => {
    const message = mapper.translate('down', RECT, event(812));
    assert.equal(message?.pointerId, 0);
  });

  it('maps browser pointer ids onto dense slots', () => {
    // Chrome's `pointerId` increments for the lifetime of the document, so the
    // raw value cannot be forwarded: Android wants an index per live touch.
    assert.equal(mapper.translate('down', RECT, event(812))?.pointerId, 0);
    assert.equal(mapper.translate('down', RECT, event(999))?.pointerId, 1);
    assert.equal(mapper.active, 2);
  });

  it('keeps a pointer on its slot for the whole gesture', () => {
    mapper.translate('down', RECT, event(812));
    mapper.translate('down', RECT, event(999));
    assert.equal(mapper.translate('move', RECT, event(999, 150, 100))?.pointerId, 1);
    assert.equal(mapper.translate('move', RECT, event(812, 150, 100))?.pointerId, 0);
  });

  it('frees a slot on release and reuses the lowest free one', () => {
    mapper.translate('down', RECT, event(1));
    mapper.translate('down', RECT, event(2));
    mapper.translate('up', RECT, event(1));
    assert.equal(mapper.active, 1);
    assert.equal(mapper.translate('down', RECT, event(3))?.pointerId, 0);
  });

  it('ignores a move for a pointer whose down it never saw', () => {
    // Happens when a gesture starts outside the canvas. Forwarding it would
    // tell Android a finger moved that is not down.
    assert.equal(mapper.translate('move', RECT, event(7)), undefined);
    assert.equal(mapper.translate('up', RECT, event(7)), undefined);
  });

  it('normalises coordinates in the message it emits', () => {
    const message = mapper.translate('down', RECT, event(1, 200, 250));
    assert.equal(message?.x, 0.25);
    assert.equal(message?.y, 0.25);
  });

  it('gives a down non-zero pressure even when the browser reports none', () => {
    // Mice and some touch digitisers report 0, but Android reads 0 pressure as
    // "not touching", so a tap would do nothing at all.
    const message = mapper.translate('down', RECT, event(1, 300, 450, 0));
    assert.equal(message?.pressure, 1);
  });

  it('passes a real pressure value through', () => {
    assert.equal(mapper.translate('down', RECT, event(1, 300, 450, 0.25))?.pressure, 0.25);
  });

  it('reports zero pressure on release', () => {
    mapper.translate('down', RECT, event(1));
    assert.equal(mapper.translate('up', RECT, event(1, 300, 450, 0.5))?.pressure, 0);
  });

  it('drops every pointer on reset, because a dropped stream lifts all fingers', () => {
    mapper.translate('down', RECT, event(1));
    mapper.translate('down', RECT, event(2));
    mapper.reset();
    assert.equal(mapper.active, 0);
    assert.equal(mapper.translate('move', RECT, event(1)), undefined);
  });

  it('refuses to allocate beyond the slot limit', () => {
    for (let i = 0; i < 10; i++) {
      assert.notEqual(mapper.translate('down', RECT, event(i)), undefined);
    }
    assert.equal(mapper.translate('down', RECT, event(100)), undefined);
    assert.equal(mapper.active, 10);
  });

  it('treats a cancel like a release', () => {
    mapper.translate('down', RECT, event(1));
    const message = mapper.translate('cancel', RECT, event(1));
    assert.equal(message?.action, 'cancel');
    assert.equal(mapper.active, 0);
  });
});

describe('translateKey', () => {
  const mods = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

  it('sends printable characters as text, not key codes', () => {
    // A key code carries no layout. Sending one would type the wrong character
    // on any non-US keyboard and mangle anything outside ASCII.
    assert.deepEqual(translateKey({ ...mods, key: 'a' }), { t: 'text', text: 'a' });
    assert.deepEqual(translateKey({ ...mods, key: 'é' }), { t: 'text', text: 'é' });
    assert.deepEqual(translateKey({ ...mods, key: ' ' }), { t: 'text', text: ' ' });
  });

  it('sends named keys as Android key codes', () => {
    assert.deepEqual(translateKey({ ...mods, key: 'Enter' }), {
      t: 'key',
      action: 'press',
      keyCode: 66,
      metaState: 0,
    });
    assert.equal((translateKey({ ...mods, key: 'Backspace' }) as { keyCode: number }).keyCode, 67);
    assert.equal((translateKey({ ...mods, key: 'ArrowLeft' }) as { keyCode: number }).keyCode, 21);
  });

  it('carries the modifier bitmask', () => {
    const message = translateKey({ ...mods, key: 'Enter', shiftKey: true, ctrlKey: true });
    // SHIFT_ON | CTRL_ON
    assert.equal((message as { metaState: number }).metaState, 0x1 | 0x1000);
  });

  it('leaves a modified printable key alone so editor shortcuts still work', () => {
    // Ctrl+S must reach VS Code, not the device.
    assert.equal(translateKey({ ...mods, key: 's', ctrlKey: true }), undefined);
    assert.equal(translateKey({ ...mods, key: 's', metaKey: true }), undefined);
  });

  it('ignores bare modifier presses and keys we do not forward', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'F5', 'CapsLock']) {
      assert.equal(translateKey({ ...mods, key }), undefined, `expected ${key} to be ignored`);
    }
  });
});
