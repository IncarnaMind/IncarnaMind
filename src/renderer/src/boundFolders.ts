import type { LibraryGroup, LinkedFolder } from "../../core/api";
import { projectPlaces } from "./agentFolders";
import { allExamples, useAppStore } from "./store";

/** A Folder bound to a folder on disk (#3613): its Linked folder, and where the folder is. */
export interface BoundPlace {
  linked: LinkedFolder;
  path: string;
}

type Places = Pick<ReturnType<typeof useAppStore.getState>, "folders" | "linkedFolders">;

/** Where a Folder is bound on disk, or null for a Folder bound to none. */
export function boundPlaceOf(
  group: Pick<LibraryGroup, "id" | "boundFolderId"> | undefined,
  state: Places,
): BoundPlace | null {
  if (!group?.boundFolderId) return null;
  const onDisk = state.folders.find((each) => each.id === group.boundFolderId);
  const linkedId = onDisk?.linkedFolderId;
  const linked =
    state.linkedFolders.find((each) => each.folderId === group.boundFolderId) ??
    state.linkedFolders.find((each) => each.id === linkedId);
  const path = projectPlaces([group], state.folders, state.linkedFolders).get(group.id);
  return linked && path ? { linked, path } : null;
}

/** The place of the Folder with this id, kept the same while nothing about it changes. */
export function useBoundPlace(groupId: string): BoundPlace | null {
  const group = useAppStore((state) => state.library?.groups.find((each) => each.id === groupId));
  const folders = useAppStore((state) => state.folders);
  const linkedFolders = useAppStore((state) => state.linkedFolders);
  return boundPlaceOf(group, { folders, linkedFolders });
}

/**
 * The User's Linked folders filed as no Folder: those whose Folder they turned off (#3613). The
 * examples' own folder is the Examples section's, never one of these.
 */
export function unboundLinkedFolders(
  state: Places & Pick<ReturnType<typeof useAppStore.getState>, "library">,
  exampleIds: ReadonlySet<string>,
): LinkedFolder[] {
  const bound = new Set((state.library?.groups ?? []).map((each) => each.boundFolderId));
  return state.linkedFolders.filter((linked) => {
    if (exampleIds.has(linked.id) || bound.has(linked.folderId)) return false;
    const inside = state.folders.filter((each) => each.linkedFolderId === linked.id);
    return !inside.some((each) => bound.has(each.id));
  });
}

/** The ids of the examples' own Linked folders. */
export const exampleLinkedIds = (state: ReturnType<typeof useAppStore.getState>): string =>
  allExamples(state)
    .flatMap((each) => (each.linkedFolderId ? [each.linkedFolderId] : []))
    .join(" ");
