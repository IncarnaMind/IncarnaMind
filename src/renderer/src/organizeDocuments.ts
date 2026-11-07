import { create } from "zustand";
import { organizeModelOf } from "../../shared/libraryModels";
import { organize, organizeEach } from "./organizeReview";
import { type AppState, allExamples, isOwnDocument, useAppStore } from "./store";

/** The User's own Documents in no Folder: what the Library's Organize sorts. */
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

/** The Documents Organize was asked for with no model chosen: what the row under the head says it needs. */
export const useOrganizeAsk = create<{
  ids: readonly string[] | null;
  ask(ids: readonly string[]): void;
  close(): void;
}>()((set) => ({
  ids: null,
  ask: (ids) => set({ ids }),
  close: () => set({ ids: null }),
}));

/**
 * Organize, from the Library, ⌘K, the footer's Allow or a fix (#2308, #1569): the Library's
 * Documents in no Folder (`ids` null) or these, planned as a whole into the Review, where nothing
 * moves before the User confirms it. A model that can only choose among Folders (a decision model)
 * sorts each into the Folders there are, and with none the starter Folders open instead. With no
 * model chosen, the row under Not in a Folder asks for one first. `forService`: the service a
 * press was authorized for; Organize sends nowhere else.
 */
export async function organizeDocuments(
  ids: readonly string[] | null,
  options: { forService?: string } = {},
): Promise<void> {
  const app = useAppStore.getState();
  const library = app.library;
  const model = library ? organizeModelOf(library.settings) : null;
  if (!library || !model) {
    useOrganizeAsk.getState().ask(ids ?? looseDocumentIds(app));
    return;
  }
  if (model.kind !== "chat") {
    if (library.groups.length === 0) app.openLibrary("starters");
    else await organizeEach(ids ?? looseDocumentIds(app), null, options.forService);
    return;
  }
  await organize({
    ...(ids && { documentIds: [...ids] }),
    ...(options.forService !== undefined && { forService: options.forService }),
  });
}

/** Organize This Folder: its own Documents, into subfolders inside it; nothing moves out of it. */
export async function organizeFolder(folderId: string): Promise<void> {
  const app = useAppStore.getState();
  const library = app.library;
  const model = library ? organizeModelOf(library.settings) : null;
  if (!library || !model) {
    app.openSettings("models", "tagging");
    return;
  }
  app.openLibrary();
  if (model.kind !== "chat") {
    const inside = library.assignments
      .filter((item) => item.groupId === folderId)
      .map((item) => item.documentId);
    await organizeEach(inside, folderId);
    return;
  }
  await organize({ folderId });
}
