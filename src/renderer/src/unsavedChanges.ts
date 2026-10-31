/**
 * Changes storage refused (#1119), as the window shows them: what waits and
 * why, kept while IncarnaMind stays open, and how many a run that closed
 * without quitting lost. And whether that run, or this window's page, ended
 * unexpectedly (#2309). `UnsavedNotice` draws them.
 */
import { create } from "zustand";
import type { UnsavedChanges } from "../../core/api";
import type { UnexpectedEnd } from "../../shared/bridge";
import { core, files } from "./core";
import { useNotices } from "./notices";

interface UnsavedState {
  unsaved: UnsavedChanges | null;
  /** Changes the last run lost when it closed without quitting: 0 when none, null when unknown or once said. */
  lost: number | null;
  /** What ended unexpectedly before this window's page loaded; null once said. */
  ended: UnexpectedEnd | null;
}

export const useUnsavedChanges = create<UnsavedState>()(() => ({
  unsaved: null,
  lost: null,
  ended: null,
}));

core.on("minds.unsaved", (unsaved) => useUnsavedChanges.setState({ unsaved }));

const report = (error: unknown) => useNotices.getState().showError(error);

// What waits now, and what the last run lost, read once as the window starts.
core
  .unsavedChanges()
  .then((unsaved) => useUnsavedChanges.setState({ unsaved }))
  .catch(report);
core
  .takeLostChanges()
  .then((lost) => useUnsavedChanges.setState({ lost }))
  .catch(report);
files
  .takeUnexpectedEnd()
  .then((ended) => useUnsavedChanges.setState({ ended }))
  .catch(report);

export function saveChangesAgain(): void {
  core
    .saveChangesAgain()
    .then((unsaved) => useUnsavedChanges.setState({ unsaved }))
    .catch(report);
}

/** Saves a copy of each Mind whose changes wait, as a .docx where the User chooses. */
export async function saveCopies(mindIds: readonly string[]): Promise<void> {
  for (const mindId of mindIds) {
    if (!(await files.saveMindCopy(mindId))) return;
  }
}

export const dismissLost = () => useUnsavedChanges.setState({ lost: null, ended: null });
