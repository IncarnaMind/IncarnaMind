/**
 * Folder walls as the window sees them (#1934): which walled Folder keeps a Document inside it,
 * judged from where a Note is. The core decides what is read and filed; this only says so.
 */
import { CITATION_NODE, type LibrarySnapshot } from "../../core/api";
import type { NodeJSON } from "../../shared/blockJson";

/** What of the Library the walls are read from. */
type Walls = {
  groups: readonly Pick<LibrarySnapshot["groups"][number], "id" | "name" | "keepInside">[];
  assignments: readonly Pick<LibrarySnapshot["assignments"][number], "documentId" | "groupId">[];
} | null;

/**
 * The name of the walled Folder that keeps `documentId` inside it, when work in `folderId` (null:
 * no Folder) is outside that wall; null when it may use the Document.
 */
export function keptInsideName(
  library: Walls,
  documentId: string | null,
  folderId: string | null,
): string | null {
  if (documentId === null) return null;
  const groupId = library?.assignments.find((each) => each.documentId === documentId)?.groupId;
  const wall = library?.groups.find((group) => group.id === groupId && group.keepInside);
  return wall && wall.id !== folderId ? wall.name : null;
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
