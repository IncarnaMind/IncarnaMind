import type { Keys } from "./commands";

/** The key as the accelerator writes it, its physical key (`KeyboardEvent.code`), and the modifiers. */
export interface Chord {
  key: string;
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const CODES: Readonly<Record<string, string>> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Enter: "Enter",
  Escape: "Escape",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Home: "Home",
  End: "End",
};

const parsed = new Map<string, Chord>();

/** Reads an accelerator, or throws for one the keymap can't bind. */
export function chordOf(keys: Keys, mac: boolean): Chord {
  const cacheKey = `${mac}:${keys}`;
  const cached = parsed.get(cacheKey);
  if (cached) return cached;
  const modifiers = keys.split("+");
  const key = modifiers.pop() ?? "";
  const code = /^[A-Z]$/.test(key)
    ? `Key${key}`
    : /^\d$/.test(key)
      ? `Digit${key}`
      : /^F([1-9]|1\d|2[0-4])$/.test(key)
        ? key
        : CODES[key];
  if (!code) throw new Error(`A shortcut names a key the keymap doesn't know: ${keys}`);
  const chord: Chord = { key, code, meta: false, ctrl: false, alt: false, shift: false };
  for (const modifier of modifiers) {
    if (modifier === "CmdOrCtrl") chord[mac ? "meta" : "ctrl"] = true;
    else if (modifier === "Cmd") chord.meta = true;
    else if (modifier === "Ctrl") chord.ctrl = true;
    else if (modifier === "Alt") chord.alt = true;
    else if (modifier === "Shift") chord.shift = true;
    else throw new Error(`A shortcut names a modifier the keymap doesn't know: ${keys}`);
  }
  parsed.set(cacheKey, chord);
  return chord;
}

/** The keys in one form, to compare: two accelerators with the same form are the same keys. */
export function keysForm(keys: Keys, mac: boolean): string {
  const { code, meta, ctrl, alt, shift } = chordOf(keys, mac);
  return [meta && "meta", ctrl && "ctrl", alt && "alt", shift && "shift", code]
    .filter(Boolean)
    .join("+");
}
