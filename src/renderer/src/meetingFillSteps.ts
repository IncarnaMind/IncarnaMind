/**
 * A Meeting's fill as the editor showing its Note holds it, one step of that editor's own Undo
 * (#2527, editor/meetingFillUndo): its line at the written place follows that step, and its Undo
 * is the editor's.
 */
import { useSyncExternalStore } from "react";
import type { FollowedSteps } from "./editor/editorUndo";

const held = new Map<string, FollowedSteps>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const listener of listeners) listener();
};

/** The editor holds this Meeting's fill as these steps, until the returned function lets go. */
export function holdFillSteps(meetingId: string, steps: FollowedSteps): () => void {
  held.set(meetingId, steps);
  const stop = steps.observe(changed);
  changed();
  return () => {
    stop();
    if (held.get(meetingId) !== steps) return;
    held.delete(meetingId);
    changed();
  };
}

/** Whether an editor holds this Meeting's fill: its Undo is that editor's, not the core's. */
export const fillHeldInEditor = (meetingId: string): boolean => held.has(meetingId);

/**
 * Where the fill stands in the editor holding it: "top" while nothing was done in the Note since
 * (its line shows, with Undo), "done" once the User went on, "undone" after ⌘Z, or null when no
 * editor holds it.
 */
export function useFillStep(meetingId: string): "top" | "done" | "undone" | null {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  const steps = held.get(meetingId);
  const state = steps?.state();
  if (!steps || !state || state === "gone") return null;
  return state === "undone" ? "undone" : steps.onTop() ? "top" : "done";
}

/** Takes back the fill in the editor that holds it on top: false when none does. */
export async function undoFillInEditor(meetingId: string): Promise<boolean> {
  const steps = held.get(meetingId);
  if (!steps?.onTop()) return false;
  await steps.undo();
  return true;
}
