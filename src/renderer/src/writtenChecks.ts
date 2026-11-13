import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { WrittenCheckProgress } from "../../core/api";
import { backgroundCheck } from "./checks";
import { core } from "./core";

/**
 * By request: how far each check of what the assistant wrote is while it runs (#2830), for the
 * line under the Answer's card. By Note: every such check there since the first of those running
 * began, ended ones too, so its badge counts them as one and never falls back when one ends. Its
 * Note's badge shows them as running through `backgroundCheck`.
 */
export const useWrittenChecks = create<{
  running: Readonly<Record<string, WrittenCheckProgress>>;
  byNote: Readonly<Record<string, Readonly<Record<string, WrittenCheckProgress>>>>;
}>()(() => ({ running: {}, byNote: {} }));

export function heardWrittenProgress(event: WrittenCheckProgress): void {
  useWrittenChecks.setState(({ running, byNote }) => {
    const next = { ...running };
    if (event.running) next[event.request] = event;
    else delete next[event.request];
    const note = { ...byNote[event.mindId], [event.request]: event };
    const notes = { ...byNote };
    if (Object.values(note).some((each) => each.running)) notes[event.mindId] = note;
    else delete notes[event.mindId];
    return { running: next, byNote: notes };
  });
  backgroundCheck(event.mindId, event.request, event.running);
}

export function installWrittenChecks(): void {
  core.on("writtenCheck.progress", heardWrittenProgress);
}

/** How far the check under `request` is, while it runs; null once it ended, or before its first word. */
export const useWrittenProgress = (request: string): WrittenCheckProgress | null =>
  useWrittenChecks((state) => state.running[request] ?? null);

/** How far a Note's checks of what the assistant wrote are, as one, while any runs; null when none does. */
export function writtenInNote(
  state: ReturnType<typeof useWrittenChecks.getState>,
  mindId: string,
): { done: number; total: number } | null {
  const checks = Object.values(state.byNote[mindId] ?? {});
  if (checks.length === 0) return null;
  return checks.reduce(
    (sum, each) => ({ done: sum.done + each.done, total: sum.total + each.total }),
    { done: 0, total: 0 },
  );
}

export const useWrittenInNote = (mindId: string): { done: number; total: number } | null =>
  useWrittenChecks(useShallow((state) => writtenInNote(state, mindId)));
