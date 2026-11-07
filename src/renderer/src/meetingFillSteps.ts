/**
 * A Meeting's fill as each editor showing its Note holds it, one step of that editor's own Undo
 * (#2527, editor/meetingFillUndo): the fill's line in that editor follows its step, and its Undo
 * is that editor's.
 */
import { useSyncExternalStore } from "react";
import type { FollowedSteps } from "./editor/editorUndo";

/** Steps of the fill an editor follows, which may say whether ⇧⌘Z puts them back next. */
type FillSteps = FollowedSteps & { redoesNext?(): boolean };

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

export function useFillStep(
  meetingId: string,
  editor: object | undefined,
): "top" | "done" | "undone" | null {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return fillStepIn(meetingId, editor);
}

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
