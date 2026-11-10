import { androidKeyCode, isPrintableKey, metaStateFrom } from '../../common/keys.js';
import type { KeyMessage, TextMessage } from '../../common/protocol.js';

/**
 * Splits a `KeyboardEvent` into the two things Android can accept.
 *
 * Printable characters go out as **text**, not key codes, because a key code
 * carries no layout: typing on a non-US keyboard, using a dead key, or entering
 * anything outside ASCII would silently produce the wrong character. Named keys
 * (Enter, Backspace, arrows) have no text form and go out as key codes.
 *
 * `undefined` means the event is not ours -- a bare modifier press, or a
 * function key we do not forward. Those must not be swallowed, or the user
 * loses the editor's own shortcuts while the panel has focus.
 */
export function translateKey(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): KeyMessage | TextMessage | undefined {
  if (isPrintableKey(event.key, event.ctrlKey, event.metaKey, event.altKey)) {
    return { t: 'text', text: event.key };
  }

  const keyCode = androidKeyCode(event.key);
  if (keyCode === undefined) return undefined;

  return {
    t: 'key',
    action: 'press',
    keyCode,
    metaState: metaStateFrom(event),
  };
}
