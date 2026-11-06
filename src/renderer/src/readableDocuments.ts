import { type DocumentOrFolderChoice, readableFrom } from "./components/documentOrFolder";
import { libraryOf } from "./scopeDocuments";
import { useAppStore } from "./store";

/** Whether the Note `mindId` may read the Document or Folder whole now (`readableFrom`). */
export function readableNow(
  mindId: string,
  choice: Pick<DocumentOrFolderChoice, "kind" | "id">,
): boolean {
  const state = useAppStore.getState();
  return readableFrom(
    libraryOf(state),
    state.minds.find((each) => each.id === mindId)?.folderId ?? null,
    choice,
  );
}
