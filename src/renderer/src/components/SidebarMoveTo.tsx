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

/** A Folder put inside another, or at the top level: the Folder it went into opens, so it stays in sight. */
async function moveFolderThere(folderId: string, parentId: string | null): Promise<void> {
  await useAppStore.getState().moveFolder(folderId, parentId);
  if (parentId) useFolds.getState().reveal(parentId);
}

export function SidebarMoveTo() {
  const request = useSidebarMove((state) => state.request);
  const groups = useAppStore((state) => state.library?.groups);
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
  const moving = request.folderId
    ? (groups ?? []).find((group) => group.id === request.folderId)
    : undefined;
  // The Folder went (deleted as this opened): there is nothing to move.
  if (request.folderId !== undefined && moving === undefined) return null;
  return (
    <MoveToPicker
      anchor={request.anchor}
      name={moving ? moving.name : nameOfMoved(request.items)}
      current={moving ? moving.parentId : folders.size === 1 ? (current ?? null) : undefined}
      forFolder={moving}
      onChoose={(folderId) =>
        moving ? void moveFolderThere(moving.id, folderId) : void moveThere(request.items, folderId)
      }
      onCreate={
        moving
          ? undefined
          : (name) => {
              void moveIntoNew(request.items, name);
            }
      }
      onClose={() => useSidebarMove.getState().hide()}
    />
  );
}
