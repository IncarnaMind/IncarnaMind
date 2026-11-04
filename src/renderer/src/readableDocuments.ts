import { type DocumentOrFolderChoice, readableFrom } from "./components/documentOrFolder";
import { useAppStore } from "./store";

/** Whether the Note `mindId` may read the Document or Folder whole now (`readableFrom`). */
export function readableNow(
  mindId: string,
  choice: Pick<DocumentOrFolderChoice, "kind" | "id">,
): boolean {
  const state = useAppStore.getState();
  const library = {
    folders: state.folders,
    groups: state.library?.groups ?? [],
    tags: state.tags,
    documents: state.documents,
    assignments: state.library?.assignments ?? [],
  };
  return readableFrom(
    library,
    state.minds.find((each) => each.id === mindId)?.folderId ?? null,
    choice,
  );
}
