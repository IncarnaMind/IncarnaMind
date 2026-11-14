/**
 * A Meeting's fill as each editor showing its Note holds it, one step of that editor's own Undo
 * (#2527, editor/meetingFillUndo): the fill's line in that editor follows its step, and its Undo
 * is that editor's.
 */
import { useSyncExternalStore } from "react";
import type { FollowedSteps } from "./editor/editorUndo";

/** Steps of the fill an editor follows, which may say whether ⇧⌘Z puts them back next. */
type FillSteps = FollowedSteps & { redoesNext?(): boolean };

/**
 * A fill whose editor closed with it still on top, as a tab switch closes it: the tab's next
 * editor starts with no history, so the tab keeps the fill's line and the core's Undo of it (#3099).
 */
interface HandedOver {
  /** Its line shows in the tab until the User does something in the Note there. */
  line: boolean;
  /** Takes its Undo off the app's undo stack. */
  withdraw(): void;
}

/** Each tab's handed-over fill, by Meeting. */
const handed = new Map<string, Map<string, HandedOver>>();

interface Hold {
  steps: FillSteps;
  /** Takes the steps out of the editor's history, and stops holding them. */
  letGo?: () => void;
}

/** Each editor's steps of a Meeting's fill, by Meeting. */
const held = new Map<string, Map<object, Hold>>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const listener of listeners) listener();
};

/** `editor` holds this Meeting's fill as these steps, until the returned function lets go. */
export function holdFillSteps(
  meetingId: string,
  editor: object,
  steps: FillSteps,
  letGo?: () => void,
): () => void {
  const holders = held.get(meetingId) ?? new Map<object, Hold>();
  const hold = { steps, letGo };
  holders.set(editor, hold);
  held.set(meetingId, holders);
  const stop = steps.observe(changed);
  changed();
  return () => {
    stop();
    if (holders.get(editor) !== hold) return;
    holders.delete(editor);
    if (holders.size === 0 && held.get(meetingId) === holders) held.delete(meetingId);
    changed();
  };
}

/** Whether an editor holds this Meeting's fill: its Undo is that editor's, not the core's. */
export const fillHeldInEditor = (meetingId: string): boolean =>
  (held.get(meetingId)?.size ?? 0) > 0;

/**
 * Each editor holding this Meeting's fill taken back with ⌘Z lets it go, so its ⇧⌘Z can't put
 * it back beside a new fill: true when one did.
 */
export function letGoOfUndoneFill(meetingId: string): boolean {
  const undone = [...(held.get(meetingId)?.values() ?? [])].filter(
    (hold) => hold.steps.state() === "undone",
  );
  for (const hold of undone) hold.letGo?.();
  return undone.length > 0;
}

/**
 * Where the fill stands in `editor`: "top" while nothing was done in the Note since (its line
 * shows, with Undo), "done" once the User went on, "undone" after ⌘Z, or null when `editor`
 * doesn't hold it.
 */
export function fillStepIn(
  meetingId: string,
  editor: object | undefined,
): "top" | "done" | "undone" | null {
  const steps = editor && held.get(meetingId)?.get(editor)?.steps;
  const state = steps?.state();
  if (!steps || !state || state === "gone") return null;
  return state === "undone" ? "undone" : steps.onTop() ? "top" : "done";
}

/** Draws again whenever an editor's hold on a fill changes, or a tab's. */
function useHolds(): void {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}

export function useFillStep(
  meetingId: string,
  editor: object | undefined,
): "top" | "done" | "undone" | null {
  useHolds();
  return fillStepIn(meetingId, editor);
}

/** `tabId` keeps this Meeting's fill, its Undo on the app's stack until `withdraw`. */
export function handFillOver(meetingId: string, tabId: string, withdraw: () => void): void {
  const tabs = handed.get(meetingId) ?? new Map<string, HandedOver>();
  tabs.get(tabId)?.withdraw();
  tabs.set(tabId, { line: true, withdraw });
  handed.set(meetingId, tabs);
  changed();
}

/** Whether the fill's line shows in the tab, which an editor closing there handed it to. */
export const fillLineHandedTo = (meetingId: string, tabId: string | undefined): boolean =>
  tabId !== undefined && handed.get(meetingId)?.get(tabId)?.line === true;

export function useFillLineHandedTo(meetingId: string, tabId: string | undefined): boolean {
  useHolds();
  return fillLineHandedTo(meetingId, tabId);
}

/** The User did something in the tab's Note: its line goes, the fill's Undo staying under that. */
export function endHandedLine(meetingId: string, tabId: string): void {
  const hold = handed.get(meetingId)?.get(tabId);
  if (!hold?.line) return;
  hold.line = false;
  changed();
}

/** The fill moved on, or the tab closed: the tab, or every tab without one, lets it go. */
export function endHandOver(meetingId: string, tabId?: string): void {
  const tabs = handed.get(meetingId);
  if (!tabs) return;
  for (const [each, hold] of tabs) {
    if (tabId !== undefined && each !== tabId) continue;
    hold.withdraw();
    tabs.delete(each);
  }
  if (tabs.size === 0) handed.delete(meetingId);
  changed();
}

/** The Meetings whose fill a tab keeps, and those tabs. */
export const handedOver = (): { meetingId: string; tabId: string }[] =>
  [...handed].flatMap(([meetingId, tabs]) =>
    [...tabs.keys()].map((tabId) => ({ meetingId, tabId })),
  );

/** Takes back the fill in `editor`, where it is on top: false when it isn't. */
export async function undoFillInEditor(
  meetingId: string,
  editor: object | undefined,
): Promise<boolean> {
  const steps = editor && held.get(meetingId)?.get(editor)?.steps;
  if (!steps?.onTop()) return false;
  await steps.undo();
  return true;
}

/** Whether `editor`'s next Undo, or Redo, is a meeting fill's own step. */
export function fillNextIn(editor: object, step: "undo" | "redo"): boolean {
  for (const holders of held.values()) {
    const steps = holders.get(editor)?.steps;
    if (steps && (step === "undo" ? steps.onTop() : steps.redoesNext?.() === true)) return true;
  }
  return false;
}

/** Where `editor`'s meeting fill stands in its history: in the Note, taken back, or neither. */
export function fillStateIn(editor: object): "done" | "undone" | null {
  for (const holders of held.values()) {
    const state = holders.get(editor)?.steps.state();
    if (state === "done" || state === "undone") return state;
  }
  return null;
}
