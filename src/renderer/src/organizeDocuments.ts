import { create } from "zustand";
import type { DocumentGroupAssignment, LibraryGroup } from "../../core/api";
import { organizeModelOf } from "../../shared/libraryModels";
import { core } from "./core";
import { useNotices } from "./notices";
import { sayWhenOrganized, useOrganizeAsk } from "./organizeRun";
import { type AppState, allExamples, isOwnDocument, useAppStore } from "./store";

/** Whether Organize is reading the Documents to propose Folders, before it sorts them. */
export const useProposing = create<{ proposing: boolean }>()(() => ({ proposing: false }));

/** The User's own Documents in no Folder: one waiting in a Suggested Folder counts as in it. */
export function looseDocumentIds(
  state: Pick<AppState, "documents" | "library" | "examples" | "otherExamples">,
): string[] {
  const filed = new Set(
    (state.library?.assignments ?? [])
      .filter((item) => item.groupId !== null)
      .map((item) => item.documentId),
  );
  const examples = allExamples(state);
  return state.documents
    .filter((each) => !filed.has(each.id) && isOwnDocument(each, examples))
    .map((each) => each.id);
}

/**
 * Organize on these Documents, from the Library or ⌘K (#2308). With no Folders yet, Organize's
 * model first proposes a few from what the Documents say and makes them; a decision model can't
 * name a Folder, so the starter Folders open instead. Then it suggests a Folder for each, to
 * accept in To review, and one Undo takes back the suggestions and the Folders it made. With no
 * model chosen, the row under Not in a Folder asks for one first.
 */
export async function organizeDocuments(
  ids: readonly string[],
  /** What Undo goes back to, when it was read before something set the Documents going. */
  read?: ReadonlyMap<string, DocumentGroupAssignment>,
): Promise<void> {
  const app = useAppStore.getState();
  const library = app.library;
  const model = library ? organizeModelOf(library.settings) : null;
  if (!library || !model) {
    useOrganizeAsk.getState().ask(ids);
    return;
  }
  const before =
    read ??
    new Map<string, DocumentGroupAssignment>(
      library.assignments
        .filter((item) => ids.includes(item.documentId))
        .map((item) => [item.documentId, item]),
    );
  let made: LibraryGroup[] = [];
  if (library.groups.length === 0) {
    if (model.kind !== "chat") {
      app.openLibrary("starters");
      return;
    }
    useProposing.setState({ proposing: true });
    try {
      made = await core.proposeFolders([...ids]);
    } finally {
      useProposing.setState({ proposing: false });
    }
    await app.refreshLibrary();
    if (made.length === 0) {
      useNotices.getState().confirm("library.organize.noneFit");
      return;
    }
  }
  await core.classifyDocuments([...ids]);
  await app.refreshLibrary();
  sayWhenOrganized(ids, before, made);
}
