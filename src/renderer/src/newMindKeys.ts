import { typesText } from "./undo";

/**
 * The keys typed the instant ⌘T makes a Mind: its editor is not drawn yet, so they would go to
 * the focus the shortcut found. Held here and put in the new Mind once its text has the focus (#2000).
 */
let held: string | null = null;
let stop: (() => void) | null = null;

const MODIFIERS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "OS",
  "AltGraph",
]);

/** What typing would put in the text: one character, not a shortcut (a German \, a Polish ą included). */
const types = (event: KeyboardEvent): boolean =>
  event.key.length === 1 &&
  (event.getModifierState("AltGraph") || (!event.metaKey && !event.ctrlKey && !event.altKey));

const inMindText = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-testid="mind-editor"]') !== null;

function release(): void {
  stop?.();
  stop = null;
}

function onKey(event: KeyboardEvent): void {
  if (MODIFIERS.has(event.key)) return;
  // An input method composes its own text (keyCode 229 is its Enter, `nameKeys`); its letters are
  // not what the User types, so they are left where they are.
  if (event.isComposing || event.keyCode === 229) {
    release();
    return;
  }
  if (typesText(event.target) && !inMindText(event.target)) {
    release();
    return;
  }
  if (types(event)) {
    event.preventDefault();
    event.stopPropagation();
    held = (held ?? "") + event.key;
    return;
  }
  // A shortcut or Enter, not a letter: it does its own work, and the Mind on its way still takes
  // what was typed before it.
  release();
}

/** Holds the keys the person types until the Mind made next has its text under the cursor. */
export function holdNewMindKeys(): void {
  release();
  held = "";
  window.addEventListener("keydown", onKey, true);
  stop = () => window.removeEventListener("keydown", onKey, true);
}

/** The keys held so far, and stops holding; null when no new Mind was on its way. */
export function takeNewMindKeys(): string | null {
  const keys = held;
  held = null;
  release();
  return keys;
}

/** Stops holding with no Mind to put the keys in: the one on its way was never made. */
export function forgetNewMindKeys(): void {
  held = null;
  release();
}
