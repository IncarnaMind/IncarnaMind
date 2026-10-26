import type { Editor } from "@tiptap/core";
import { openMindEditors } from "./editor/openEditors";
import { typesText } from "./undo";

/**
 * The keys typed the instant ⌘T makes a Mind: its editor is not drawn yet. The focus moves at
 * once to a blank spot, so nothing typed meanwhile reaches the Mind the User left; what is typed
 * is held and put in the new Mind once its text has the focus (#2000).
 */
let held: string | null = null;
let stop: (() => void) | null = null;
let sink: HTMLElement | null = null;
let before: HTMLElement | null = null;
let keptWriting: { editor: Editor; was: boolean }[] = [];

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

const types = (event: KeyboardEvent): boolean =>
  event.key.length === 1 &&
  (event.getModifierState("AltGraph") || (!event.metaKey && !event.ctrlKey && !event.altKey));

const inMindText = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-testid="mind-editor"]') !== null;

/** A blank spot to keep the focus while the new Mind is made, so keys typed meanwhile do not reach the Mind the User left. */
function focusSink(): void {
  if (sink) return;
  before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  sink = document.createElement("div");
  sink.tabIndex = -1;
  sink.dataset.testid = "new-mind-keys";
  sink.setAttribute("aria-hidden", "true");
  sink.style.cssText =
    "position: fixed; inline-size: 1px; block-size: 1px; opacity: 0; pointer-events: none;";
  document.body.append(sink);
  sink.focus();
}

function dropSink(restore: boolean): void {
  const hasFocus = sink !== null && document.activeElement === sink;
  sink?.remove();
  sink = null;
  if (restore && hasFocus && before?.isConnected) before.focus();
  before = null;
}

/**
 * An input method sends its composition to the text it last edited, even once the focus has
 * moved; a Mind the User left must not take it, so nothing is editable until the new one is drawn.
 */
function stopWriting(): void {
  // A second ⌘T joins the record: an editor already stopped is left as the first hold recorded it.
  const kept = new Set(keptWriting.map((each) => each.editor));
  for (const editor of openMindEditors()) {
    if (kept.has(editor)) continue;
    const was = editor.isEditable;
    keptWriting.push({ editor, was });
    if (was) editor.setEditable(false);
  }
}

function resumeWriting(): void {
  for (const each of keptWriting)
    if (each.was && !each.editor.isDestroyed) each.editor.setEditable(true);
  keptWriting = [];
}

function release(): void {
  stop?.();
  stop = null;
}

function onKey(event: KeyboardEvent): void {
  if (MODIFIERS.has(event.key)) return;
  // An input method composes its own text (keyCode 229 is its Enter, `nameKeys`); it composes on
  // the blank spot, never in the Mind the User left.
  if (event.isComposing || event.keyCode === 229) return;
  if (typesText(event.target) && !inMindText(event.target)) {
    // Another field has the person's keys: they are its own.
    release();
    return;
  }
  if (!types(event)) return;
  event.preventDefault();
  event.stopPropagation();
  held = (held ?? "") + event.key;
}

/** Holds the keys the person types until the Mind made next has its text under the cursor. */
export function holdNewMindKeys(): void {
  release();
  held = "";
  focusSink();
  stopWriting();
  window.addEventListener("keydown", onKey, true);
  stop = () => window.removeEventListener("keydown", onKey, true);
}

/** The keys held so far, and stops holding; null when no new Mind was on its way. */
export function takeNewMindKeys(): string | null {
  const keys = held;
  held = null;
  release();
  dropSink(false);
  resumeWriting();
  return keys;
}

/** Stops holding with no Mind coming to take the keys, and gives the focus back where it was. */
export function forgetNewMindKeys(): void {
  held = null;
  release();
  resumeWriting();
  dropSink(true);
}
