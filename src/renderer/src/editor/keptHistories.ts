/**
 * The Undo histories tabs keep for their Notes (#3115, ../tabCopies): the editor that shows each
 * now, if any, and when one ends with its tab. What follows a step of a Note's Undo (its line, its
 * place on the app's stack) follows the history through these, not the editor the step was made in,
 * which a tab switch ends.
 */
import type { Editor } from "@tiptap/core";

interface Kept {
  tabId: string;
  mindId: string;
  editor: Editor | null;
  shown: Set<() => void>;
  ended: Set<() => void>;
  /** A word to the `shown` listeners is waiting. */
  telling: boolean;
}

const kept = new WeakMap<object, Kept>();

/** `history` is the one the tab keeps for its Note, until the function this returns ends it. */
export function keepHistory(history: object, tabId: string, mindId: string): () => void {
  const entry: Kept = {
    tabId,
    mindId,
    editor: null,
    shown: new Set(),
    ended: new Set(),
    telling: false,
  };
  kept.set(history, entry);
  return () => {
    if (kept.get(history) !== entry) return;
    kept.delete(history);
    entry.editor = null;
    for (const listener of [...entry.ended]) listener();
    entry.ended.clear();
    entry.shown.clear();
  };
}

/** The tab and Note whose kept history this is, while it lasts; undefined for any other. */
export function keptHistory(
  history: object | undefined,
): { tabId: string; mindId: string } | undefined {
  const entry = history ? kept.get(history) : undefined;
  return entry && { tabId: entry.tabId, mindId: entry.mindId };
}

/**
 * `editor` shows the history until the function this returns is called. An editor made for the
 * same tab before the last one ended, as a tab moved to another group, takes its place.
 */
export function drawHistory(history: object, editor: Editor): () => void {
  const entry = kept.get(history);
  if (!entry) return () => undefined;
  entry.editor = editor;
  tell(entry);
  return () => {
    if (entry.editor !== editor) return;
    entry.editor = null;
    tell(entry);
  };
}

/** The editor showing the kept history now, or null while its tab shows something else. */
export function historyEditor(history: object): Editor | null {
  const editor = kept.get(history)?.editor ?? null;
  return editor && !editor.isDestroyed ? editor : null;
}

/**
 * Hears each time the history comes to show or stops showing. Told once the window's own changes
 * have run, so the editor of a tab drawn again at once, as in another group, is no change.
 */
export function onHistoryShown(history: object, listener: () => void): () => void {
  const entry = kept.get(history);
  if (!entry) return () => undefined;
  entry.shown.add(listener);
  return () => entry.shown.delete(listener);
}

/** Hears the history end, its tab closed. Nothing hears it for a history no tab keeps. */
export function onHistoryEnd(history: object, listener: () => void): () => void {
  const entry = kept.get(history);
  if (!entry) return () => undefined;
  entry.ended.add(listener);
  return () => entry.ended.delete(listener);
}

function tell(entry: Kept): void {
  if (entry.telling) return;
  entry.telling = true;
  queueMicrotask(() => {
    entry.telling = false;
    for (const listener of [...entry.shown]) listener();
  });
}
