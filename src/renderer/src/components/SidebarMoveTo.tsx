import { moveIntoFolder } from "../folderDrag";
import { itemsOf, type MoveItems } from "../moves";
import { nameOfMoved, useSidebarMove } from "../sidebarMoves";
import { useAppStore } from "../store";
import { useFolds } from "./LibraryFolders";
import { MoveToPicker } from "./MoveToPicker";

// The Folder they went into opens, so they stay in sight.
async function moveThere(items: MoveItems, folderId: string | null): Promise<void> {
  await moveIntoFolder(items, folderId);
  if (folderId) useFolds.getState().reveal(folderId);
}

async function moveIntoNew(items: MoveItems, name: string): Promise<void> {
  const made = await useAppStore.getState().createFolder(items, name);
  if (made) useFolds.getState().reveal(made);
}

export function SidebarMoveTo() {
  const request = useSidebarMove((state) => state.request);
  const minds = useAppStore((state) => state.minds);
  const assignments = useAppStore((state) => state.library?.assignments);
  const { mindIds, documentIds } = itemsOf(request?.items ?? {});
  const folders = new Set([
    ...mindIds.map((id) => minds.find((mind) => mind.id === id)?.folderId ?? null),
    ...documentIds.map(
      (id) => assignments?.find((each) => each.documentId === id)?.groupId ?? null,
    ),
  ]);
  const [current] = folders;
  // Only while asked for: the Library has a picker of its own, and a page has one at a time.
  if (!request) return null;
  return (
    <MoveToPicker
      anchor={request.anchor}
      name={nameOfMoved(request.items)}
      current={folders.size === 1 ? (current ?? null) : undefined}
      onChoose={(folderId) => void moveThere(request.items, folderId)}
      onCreate={(name) => void moveIntoNew(request.items, name)}
      onClose={() => useSidebarMove.getState().hide()}
    />
  );
}
