/**
 * A Meeting's fill as each copy of its Note holds it, one step of that copy's Undo (#2527,
 * editor/meetingFillUndo): the fill's line in that copy follows its step, and its Undo is that
 * copy's. A copy's steps are held by its editor, or, in a tab, by the history the tab keeps for
 * the Note, so the tab's next editor finds them after a tab switch (#3115).
 */
import { Editor } from "@tiptap/core";
import { useSyncExternalStore } from "react";
import { type FollowedSteps, historyOwnerOf } from "./editor/editorUndo";

/** What holds the steps `given` asks about: an editor's, its tab's history where it keeps one. */
const holderOf = (given: object): object =>
  given instanceof Editor ? historyOwnerOf(given) : given;

/** Steps of the fill a copy follows, which may say whether ⇧⌘Z puts them back next. */
type FillSteps = FollowedSteps & { redoesNext?(): boolean };

interface Hold {
  steps: FillSteps;
  /** Takes the steps out of the history, and stops holding them. */
  letGo?: () => void;
}

/** Each copy's steps of a Meeting's fill, by Meeting and by what holds them. */
const held = new Map<string, Map<object, Hold>>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const listener of listeners) listener();
};

/** `holder` holds this Meeting's fill as these steps, until the returned function lets go. */
export function holdFillSteps(
  meetingId: string,
  holder: object,
  steps: FillSteps,
  letGo?: () => void,
): () => void {
  const holders = held.get(meetingId) ?? new Map<object, Hold>();
  const hold = { steps, letGo };
  const by = holderOf(holder);
  holders.set(by, hold);
  held.set(meetingId, holders);
  const stop = steps.observe(changed);
  changed();
  return () => {
    stop();
    if (holders.get(by) !== hold) return;
    holders.delete(by);
    if (holders.size === 0 && held.get(meetingId) === holders) held.delete(meetingId);
    changed();
  };
}

/** Whether a copy holds this Meeting's fill: its Undo is that copy's, not the core's. */
export const fillHeldInEditor = (meetingId: string): boolean =>
  (held.get(meetingId)?.size ?? 0) > 0;

/**
 * Each copy holding this Meeting's fill taken back with ⌘Z lets it go, so its ⇧⌘Z can't put
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
 * Where the fill stands in `holder`: "top" while nothing was done in the Note since (its line
 * shows, with Undo), "done" once the User went on, "undone" after ⌘Z, or null when `holder`
 * doesn't hold it.
 */
export function fillStepIn(
  meetingId: string,
  holder: object | undefined,
): "top" | "done" | "undone" | null {
  const steps = holder && held.get(meetingId)?.get(holderOf(holder))?.steps;
  const state = steps?.state();
  if (!steps || !state || state === "gone") return null;
  return state === "undone" ? "undone" : steps.onTop() ? "top" : "done";
}

/** Draws again whenever a copy's hold on a fill changes. */
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
  holder: object | undefined,
): "top" | "done" | "undone" | null {
  useHolds();
  return fillStepIn(meetingId, holder);
}

/** Takes back the fill in `holder`, where it is on top: false when it isn't. */
export async function undoFillInEditor(
  meetingId: string,
  holder: object | undefined,
): Promise<boolean> {
  const steps = holder && held.get(meetingId)?.get(holderOf(holder))?.steps;
  if (!steps?.onTop()) return false;
  await steps.undo();
  return true;
}

/** Whether `holder`'s next Undo, or Redo, is a meeting fill's own step. */
export function fillNextIn(holder: object, step: "undo" | "redo"): boolean {
  const by = holderOf(holder);
  for (const holders of held.values()) {
    const steps = holders.get(by)?.steps;
    if (steps && (step === "undo" ? steps.onTop() : steps.redoesNext?.() === true)) return true;
  }
  return false;
}

/** Where `holder`'s meeting fill stands in its history: in the Note, taken back, or neither. */
export function fillStateIn(holder: object): "done" | "undone" | null {
  const by = holderOf(holder);
  for (const holders of held.values()) {
    const state = holders.get(by)?.steps.state();
    if (state === "done" || state === "undone") return state;
  }
  return null;
}
