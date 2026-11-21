/**
 * Folder walls as the window sees them (#1934): which walled Folder keeps a Document inside it,
 * judged from where a Note is. The core decides what is read and filed; this only says so.
 */
import {
  CITATION_NODE,
  type DocumentWall,
  type LibraryGroup,
  type SearchScope,
} from "../../core/api";
import type { NodeJSON } from "../../shared/blockJson";
import { folderWallOf } from "./folders";
import type { Translate } from "./objects";

/** What of the Library the walls are read from (#3131). */
export interface WallLibrary {
  groups: readonly Pick<LibraryGroup, "id" | "name" | "parentId" | "keepInside">[];
  documentWalls?: Readonly<Record<string, DocumentWall>>;
}
type Walls = WallLibrary | null;

/** The walls as the store holds them. */
export const wallsOf = (state: { library: Walls }): Walls => state.library;

/**
 * The wall each Document is behind, as the core's search reads it (#3131): the nearest Folder
 * keeping its work inside it around where the Document is filed (#246), where its Meeting's Note
 * is (#2528), or where the Note IncarnaMind wrote its file from was (#1934). `byUser`: the User
 * filed it there, so a Note behind that wall searches it. A Document behind no wall is absent.
 * Every picker, chip and Citation takes this one reading.
 */
export function documentWalls(
  library: Pick<WallLibrary, "documentWalls">,
): Map<string, DocumentWall> {
  return new Map(Object.entries(library.documentWalls ?? {}));
}

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

/**
 * The name of the walled Folder that keeps `documentId` inside it, when work in `folderId` (null:
 * no Folder) is behind another wall or none; null when it may use the Document. A Folder inside a
 * walled Folder is behind the same wall, unless it keeps its own work inside it: then it is a
 * wall of its own, as the core reads it.
 */
export function keptInsideName(
  library: Walls,
  documentId: string | null,
  folderId: string | null,
): string | null {
  if (documentId === null || library === null) return null;
  const wallId = documentWalls(library).get(documentId)?.wallId;
  if (wallId === undefined) return null;
  const own = folderId === null ? null : folderWallOf(library.groups, folderId);
  if (own === wallId) return null;
  return library.groups.find((group) => group.id === wallId)?.name ?? null;
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
  if (scope === null || library === null) return scope;
  const groups = library.groups;
  if (folderId !== null && folderWallOf(groups, folderId) !== null) return scope;
  const walled = documentWalls(library);
  return {
    ...scope,
    folderIds: scope.folderIds.filter((id) => folderWallOf(groups, id) === null),
    documentIds: scope.documentIds.filter((id) => !walled.has(id)),
  };
}
