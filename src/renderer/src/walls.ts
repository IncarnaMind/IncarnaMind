/**
 * Folder walls as the window sees them (#1934): which walled Folder keeps a Document inside it,
 * judged from where a Note is. The core decides what is read and filed; this only says so.
 */
import { CITATION_NODE, type LibrarySnapshot, type SearchScope } from "../../core/api";
import type { NodeJSON } from "../../shared/blockJson";
import { folderWallOf, isInsideFolder } from "./folders";

/** What of the Library the walls are read from. */
type Walls = {
  groups: readonly Pick<
    LibrarySnapshot["groups"][number],
    "id" | "name" | "parentId" | "keepInside"
  >[];
  assignments: readonly Pick<LibrarySnapshot["assignments"][number], "documentId" | "groupId">[];
} | null;

/** The walled Folder that keeps a Folder or a Document's Folder inside it; null outside every wall. */
const wallBehind = (
  library: Walls,
  folderId: string | null,
): { id: string; name: string } | null => {
  if (library === null || folderId === null) return null;
  const id = folderWallOf(library.groups, folderId);
  if (id === null) return null;
  return library.groups.find((group) => group.id === id) ?? null;
};

/**
 * The name of the walled Folder that keeps `documentId` inside it, when work in `folderId` (null:
 * no Folder) is outside that wall; null when it may use the Document. A Folder inside a walled
 * Folder is behind the same wall.
 */
export function keptInsideName(
  library: Walls,
  documentId: string | null,
  folderId: string | null,
): string | null {
  if (documentId === null || library === null) return null;
  const groupId = library.assignments.find((each) => each.documentId === documentId)?.groupId;
  const wall = wallBehind(library, groupId ?? null);
  if (wall === null) return null;
  const inside =
    folderId !== null &&
    (folderId === wall.id || isInsideFolder(library.groups, folderId, wall.id));
  return inside ? null : wall.name;
}

const citedIn = (node: NodeJSON): string[] => [
  ...(node.type === CITATION_NODE && typeof node.attrs?.documentId === "string"
    ? [node.attrs.documentId]
    : []),
  ...(node.content ?? []).flatMap(citedIn),
];

/** The walled Folder copying `blocks` into a Note in `folderId` takes Citations out of; null for none. */
export function copiedOutOf(
  library: Walls,
  blocks: readonly NodeJSON[],
  folderId: string | null,
): string | null {
  for (const documentId of blocks.flatMap(citedIn)) {
    const name = keptInsideName(library, documentId, folderId);
    if (name !== null) return name;
  }
  return null;
}

/**
 * An Answer's Search scope as a Note in `folderId` may keep it: one outside a wall never takes a
 * walled Folder or Document into its scope (#1934), as the core does for a Note not open.
 */
export function scopeOutsideWalls(
  library: Walls,
  scope: SearchScope | null,
  folderId: string | null,
): SearchScope | null {
  if (scope === null) return null;
  if (folderId !== null && wallBehind(library, folderId) !== null) return scope;
  const walled = new Set(
    (library?.assignments ?? []).flatMap((each) =>
      wallBehind(library, each.groupId) === null ? [] : [each.documentId],
    ),
  );
  return {
    ...scope,
    folderIds: scope.folderIds.filter((id) => wallBehind(library, id) === null),
    documentIds: scope.documentIds.filter((id) => !walled.has(id)),
  };
}
