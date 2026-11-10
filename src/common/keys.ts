/**
 * Android key codes and the browser -> Android mapping.
 *
 * Shared: the webview resolves a `KeyboardEvent` to a numeric key code, and the
 * host feeds that number to `input keyevent` (phase 1) or the scrcpy control
 * socket (phase 2). Keeping the table in `common` means both ends agree by
 * construction.
 *
 * Values are from Android's `KeyEvent`.
 */

export const AKEYCODE = {
  UNKNOWN: 0,
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  MENU: 82,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  INSERT: 124,
  APP_SWITCH: 187,
} as const;

export const AMETA = {
  NONE: 0,
  SHIFT_ON: 0x00000001,
  ALT_ON: 0x00000002,
  CTRL_ON: 0x00001000,
  META_ON: 0x00010000,
} as const;

/** Navigation buttons offered in the panel toolbar. */
export const NAV_BUTTONS = [
  { id: 'back', label: 'Back', keyCode: AKEYCODE.BACK, icon: 'arrow-left' },
  { id: 'home', label: 'Home', keyCode: AKEYCODE.HOME, icon: 'circle-large-outline' },
  { id: 'recents', label: 'Recents', keyCode: AKEYCODE.APP_SWITCH, icon: 'chrome-restore' },
  { id: 'power', label: 'Power', keyCode: AKEYCODE.POWER, icon: 'circle-slash' },
  { id: 'volume-up', label: 'Volume up', keyCode: AKEYCODE.VOLUME_UP, icon: 'chevron-up' },
  { id: 'volume-down', label: 'Volume down', keyCode: AKEYCODE.VOLUME_DOWN, icon: 'chevron-down' },
] as const;

/** `KeyboardEvent.key` values that map to a key code regardless of layout. */
const BY_KEY: Readonly<Record<string, number>> = {
  Backspace: AKEYCODE.DEL,
  Delete: AKEYCODE.FORWARD_DEL,
  Enter: AKEYCODE.ENTER,
  Tab: AKEYCODE.TAB,
  Escape: AKEYCODE.ESCAPE,
  ArrowUp: AKEYCODE.DPAD_UP,
  ArrowDown: AKEYCODE.DPAD_DOWN,
  ArrowLeft: AKEYCODE.DPAD_LEFT,
  ArrowRight: AKEYCODE.DPAD_RIGHT,
  Home: AKEYCODE.MOVE_HOME,
  End: AKEYCODE.MOVE_END,
  PageUp: AKEYCODE.PAGE_UP,
  PageDown: AKEYCODE.PAGE_DOWN,
  Insert: AKEYCODE.INSERT,
};

/**
 * Resolves a key event to an Android key code, or `undefined` when the event
 * should be delivered as text instead.
 *
 * Printable characters deliberately return `undefined`: sending them as key
 * codes would lose the layout, the dead keys and anything non-ASCII. The
 * webview sends those through the text path, which the device IME handles.
 */
export function androidKeyCode(key: string): number | undefined {
  const mapped = BY_KEY[key];
  if (mapped !== undefined) return mapped;
  // Single-code-point keys are printable; everything else is a modifier or a
  // function key we do not forward.
  return undefined;
}

/** True when a key event carries a character the device IME should type. */
export function isPrintableKey(key: string, ctrlKey: boolean, metaKey: boolean, altKey: boolean): boolean {
  if (ctrlKey || metaKey || altKey) return false;
  // `key` is a single Unicode code point for printable keys and a named string
  // ("Shift", "F5") otherwise. [...key].length handles astral planes.
  return [...key].length === 1;
}

export function metaStateFrom(mods: {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): number {
  let state = AMETA.NONE;
  if (mods.shiftKey) state |= AMETA.SHIFT_ON;
  if (mods.altKey) state |= AMETA.ALT_ON;
  if (mods.ctrlKey) state |= AMETA.CTRL_ON;
  if (mods.metaKey) state |= AMETA.META_ON;
  return state;
}
