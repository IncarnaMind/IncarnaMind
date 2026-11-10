import { NO_MIND, useComposer } from "./composer";
import { useOpenConversation } from "./conversations";
import { currentTabOf } from "./layoutSlice";
import { useCitedSource } from "./openCited";
import { resolveSearchScope } from "./resolveSearchScope";
import { useFolderHoldsDocuments } from "./scopeDocuments";
import { useAppStore } from "./store";
import { useTurnWall } from "./turnWall";

/**
 * The Search scope of the chat box of `mindId`, or of the Note a cited Document was opened from
 * when there is none, as `resolveSearchScope` works it out from what the window holds.
 * `wallId` is undefined until the core has said which wall the turn has (see `useTurnWall`).
 */
export function useResolvedScope(mindId: string | null) {
  const citedSource = useCitedSource();
  const scopeMindId = mindId ?? citedSource?.mindId ?? null;
  // Only the scope: a keystroke in the box makes its draft new, and the Conversation must not draw again for it.
  const draft = useComposer((state) => state.drafts[scopeMindId ?? NO_MIND]?.scope ?? null);
  // The Note's Folder: its own Search scope while it holds a Document, and where its new notes go.
  const folderId = useAppStore(
    (state) => state.minds.find((each) => each.id === scopeMindId)?.folderId ?? null,
  );
  const folderHolds = useFolderHoldsDocuments(folderId);
  const conversationId = useOpenConversation()?.id ?? null;
  const wallId = useTurnWall({ mindId: scopeMindId, conversationId });
  const libraryFolderId = useAppStore((state) =>
    currentTabOf(state.layout)?.item.kind === "library" ? state.libraryFolderId : null,
  );
  const groups = useAppStore((state) => state.library?.groups);
  return {
    draft,
    folderId,
    folderHolds,
    conversationId,
    wallId,
    libraryFolderId,
    ...resolveSearchScope({
      draft,
      folderId,
      folderHolds,
      wall: wallId ?? null,
      libraryFolderId,
      groups,
    }),
  };
}
