import type { Keys, ShortcutKeys } from "../../../shared/commands";
import { type Chord, chordOf, keysForm } from "../../../shared/keyForms";

export { keysForm };

interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MAC_GLYPHS: Readonly<Record<string, string>> = {
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↩",
  Tab: "⇥",
  Escape: "⎋",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  PageUp: "⇞",
  PageDown: "⇟",
};

export const keysOn = (shortcut: ShortcutKeys, mac: boolean): Keys =>
  typeof shortcut === "string" ? shortcut : mac ? shortcut.mac : shortcut.other;

/** Throws if the keymap can't bind these keys on macOS or elsewhere. */
export function checkKeys(shortcut: ShortcutKeys): void {
  chordOf(keysOn(shortcut, true), true);
  chordOf(keysOn(shortcut, false), false);
}

/**
 * A letter, digit or sign is the key that types it in the User's layout, as
 * browsers match shortcuts: on AZERTY, ⌘Z is pressed where QWERTY has W, and
 * must not close the tab. Where the layout types no Latin letter or digit
 * there (Cyrillic, ⌥ held, a sign on another key), the physical key stands in.
 */
function sameKey(chord: Chord, press: KeyPress): boolean {
  if (chord.key.length === 1 && press.key.length === 1) {
    if (press.key.toUpperCase() === chord.key) return true;
    if (/^[a-z0-9]$/i.test(press.key)) return false;
  }
  return press.code === chord.code;
}

/** Whether a key pressed is these keys, with exactly these modifiers. */
export function pressed(keys: Keys, press: KeyPress, mac: boolean): boolean {
  const chord = chordOf(keys, mac);
  return (
    sameKey(chord, press) &&
    press.metaKey === chord.meta &&
    press.ctrlKey === chord.ctrl &&
    press.altKey === chord.alt &&
    press.shiftKey === chord.shift
  );
}

/** The keys as this system writes them: "⇧⌘⌫" on macOS, "Ctrl+Shift+Backspace" elsewhere. */
export function keysLabel(keys: Keys, mac: boolean): string {
  const { key, meta, ctrl, alt, shift } = chordOf(keys, mac);
  if (mac) {
    // In the order macOS's menus write them.
    const modifiers = `${ctrl ? "⌃" : ""}${alt ? "⌥" : ""}${shift ? "⇧" : ""}${meta ? "⌘" : ""}`;
    return `${modifiers}${MAC_GLYPHS[key] ?? key}`;
  }
  return [ctrl && "Ctrl", alt && "Alt", shift && "Shift", meta && "Win", key]
    .filter(Boolean)
    .join("+");
}
