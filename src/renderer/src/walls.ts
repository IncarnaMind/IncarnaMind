/**
 * Folder walls as the window sees them (#1934): which walled Folder keeps a Document inside it,
 * judged from where a Note is. The core decides what is read and filed; this only says so.
 */
import {
  CITATION_NODE,
  type Document,
  type LibrarySnapshot,
  type Mind,
  type SearchScope,
} from "../../core/api";
import type { NodeJSON } from "../../shared/blockJson";
import { folderWallOf, isInsideFolder } from "./folders";
import { withTranscriptsFiled } from "./meetingTranscript";
import type { Translate } from "./objects";

/**
 * What of the Library the walls are read from. With the Documents and the Notes, a meeting's
 * Transcript is behind its Note's wall (#2528).
 */
type Walls = {
  groups: readonly Pick<
    LibrarySnapshot["groups"][number],
    "id" | "name" | "parentId" | "keepInside"
  >[];
  assignments: readonly Pick<LibrarySnapshot["assignments"][number], "documentId" | "groupId">[];
  documents?: readonly Pick<Document, "id" | "meetingMindId">[];
  minds?: readonly Pick<Mind, "id" | "folderId">[];
} | null;

/** The walls as the store holds them, with its Documents and Notes. */
export const wallsOf = (state: {
  library: LibrarySnapshot | null;
  documents: readonly Document[];
  minds: readonly Mind[];
}): Walls => state.library && { ...state.library, documents: state.documents, minds: state.minds };

const filingsOf = (library: NonNullable<Walls>) =>
  withTranscriptsFiled(library.assignments, library.documents ?? [], library.minds ?? []);

/**
 * What a move across walls says after its own line, in the ruled words: the wall it entered and
 * those it left, each by the path Move to… shows. The move's own sentence says what moved, so
 * these have no subject; a wall left for another is one sentence.
 */
export function wallLines(t: Translate, entered: string | null, left: readonly string[]): string {
  const leaving = [...new Set(left)].filter((name) => name !== entered);
  const first = leaving[0];
  if (entered !== null && first !== undefined) {
    return leaving.length === 1
      ? t("move.wallToWall", { into: entered, from: first })
      : leaving.length === 2
        ? t("move.wallToWall.many.one", { into: entered, from: first })
        : t("move.wallToWall.many", {
            into: entered,
            from: first,
            n: leaving.length - 1,
            total: leaving.length,
          });
  }
  if (entered !== null) return t("move.intoWall", { folder: entered });
  if (first === undefined) return "";
  if (leaving.length === 1) return t("move.outOfWall", { folder: first });
  return leaving.length === 2
    ? t("move.outOfWall.many.one", { folder: first })
    : t("move.outOfWall.many", { folder: first, n: leaving.length - 1, total: leaving.length });
}

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
  const groupId = filingsOf(library).find((each) => each.documentId === documentId)?.groupId;
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
    (library ? filingsOf(library) : []).flatMap((each) =>
      wallBehind(library, each.groupId) === null ? [] : [each.documentId],
    ),
  );
  return {
    ...scope,
    folderIds: scope.folderIds.filter((id) => wallBehind(library, id) === null),
    documentIds: scope.documentIds.filter((id) => !walled.has(id)),
  };
}
