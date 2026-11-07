/**
 * A Meeting's fill as each editor showing its Note holds it, one step of that editor's own Undo
 * (#2527, editor/meetingFillUndo): the fill's line in that editor follows its step, and its Undo
 * is that editor's.
 */
import { useSyncExternalStore } from "react";
import type { FollowedSteps } from "./editor/editorUndo";

/** Each editor's steps of a Meeting's fill, by Meeting. */
const held = new Map<string, Map<object, FollowedSteps>>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const listener of listeners) listener();
};

/** `editor` holds this Meeting's fill as these steps, until the returned function lets go. */
export function holdFillSteps(meetingId: string, editor: object, steps: FollowedSteps): () => void {
  const holders = held.get(meetingId) ?? new Map<object, FollowedSteps>();
  holders.set(editor, steps);
  held.set(meetingId, holders);
  const stop = steps.observe(changed);
  changed();
  return () => {
    stop();
    if (holders.get(editor) !== steps) return;
    holders.delete(editor);
    if (holders.size === 0 && held.get(meetingId) === holders) held.delete(meetingId);
    changed();
  };
}

const holdersOf = (meetingId: string): FollowedSteps[] => [
  ...(held.get(meetingId)?.values() ?? []),
];

/** Whether an editor holds this Meeting's fill: its Undo is that editor's, not the core's. */
export const fillHeldInEditor = (meetingId: string): boolean => holdersOf(meetingId).length > 0;

/** Whether an editor holds this Meeting's fill taken back with ⌘Z. */
export const fillUndoneInEditor = (meetingId: string): boolean =>
  holdersOf(meetingId).some((steps) => steps.state() === "undone");

/**
 * Where the fill stands in `editor`: "top" while nothing was done in the Note since (its line
 * shows, with Undo), "done" once the User went on, "undone" after ⌘Z, or null when `editor`
 * doesn't hold it.
 */
export function fillStepIn(
  meetingId: string,
  editor: object | undefined,
): "top" | "done" | "undone" | null {
  const steps = editor && held.get(meetingId)?.get(editor);
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
  const steps = editor && held.get(meetingId)?.get(editor);
  if (!steps?.onTop()) return false;
  await steps.undo();
  return true;
}
