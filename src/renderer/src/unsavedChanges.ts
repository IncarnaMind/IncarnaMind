/**
 * Changes storage refused (#1119), as the window shows them: what waits and
 * why, kept while IncarnaMind stays open, and how many a run that closed
 * without quitting lost. And whether that run, or this window's page, ended
 * unexpectedly (#2309). `UnsavedNotice` draws them.
 */
import { create } from "zustand";
import type { UnsavedChanges } from "../../core/api";
import type { UnexpectedEnd } from "../../shared/bridge";
import { mindName } from "../../shared/naming";
import { core, files } from "./core";
import { endedInOneNote } from "./lastRunLine";
import { useNotices } from "./notices";

interface UnsavedState {
  unsaved: UnsavedChanges | null;
  /** Changes the last run lost when it closed without quitting: 0 when none, null when unknown or once said. */
  lost: number | null;
  /** What ended unexpectedly before this window's page loaded; null once said. */
  ended: UnexpectedEnd | null;
  /** The one Note a session's end left its changes in (`endedInOneNote`), named as it is now. */
  note: { mindId: string; name: string } | null;
}

export const useUnsavedChanges = create<UnsavedState>()(() => ({
  unsaved: null,
  lost: null,
  ended: null,
  note: null,
}));

core.on("minds.unsaved", (unsaved) => useUnsavedChanges.setState({ unsaved }));

const report = (error: unknown) => useNotices.getState().showError(error);
const answer = <T>(asked: Promise<T>): Promise<T | null> =>
  asked.catch((error: unknown) => {
    report(error);
    return null;
  });

async function noteOf(ended: UnexpectedEnd | null): Promise<UnsavedState["note"]> {
  const mindId = endedInOneNote(ended);
  if (!mindId) return null;
  const mind = (await core.listMinds()).find((each) => each.id === mindId);
  return mind ? { mindId, name: mindName(mind) } : null;
}

// What waits now, and how the last run or this page ended, read once as the window starts. The
// line waits for every answer, so it never says one thing and then another (#2309).
Promise.all([
  answer(core.unsavedChanges()).then((unsaved) => useUnsavedChanges.setState({ unsaved })),
  answer(core.takeLostChanges()),
  answer(files.takeUnexpectedEnd()),
])
  .then(async ([, lost, ended]) => {
    const note = await answer(noteOf(ended));
    useUnsavedChanges.setState({ lost, ended, note });
  })
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

export const dismissLost = () =>
  useUnsavedChanges.setState({ lost: null, ended: null, note: null });
