/**
 * What an agent may be allowed to read, as the list of choices in Settings →
 * Agents shows it. Pure: no store, no bridge, so the tests import it.
 */
import {
  ALL_SHARED_ID,
  type Document,
  type DocumentGroupAssignment,
  type Folder,
  type LibraryGroup,
  type LinkedFolder,
  NOT_IN_A_FOLDER_ID,
} from "../../core/api";
import { buildFolderTree, flattenFolderTree } from "./folders";
import { isListedDocument } from "./meetingTranscript";

export interface AgentFolderRow {
  /** The Folder's id, or `NOT_IN_A_FOLDER_ID`. */
  id: string;
  /** The Folder's name; null for Not in a Folder, which the interface names. */
  name: string | null;
  /** How many Documents an agent given it reads: its own and its inner Folders' up to a wall. */
  documents: number;
  /** 0 at the top level. */
  depth: number;
  /** It keeps its work inside it: shared only by its own choice, alone. */
  walled: boolean;
  /** The Folders above it whose choice shares it too (#3394), the nearest first. */
  sharedWith: string[];
  /** Where a Project's folder is on disk (ADR-0030), shown under its name; null for any other. */
  place: string | null;
}

/** Each Project's folder on disk, by the Project's id: its Linked folder's path, and the way in. */
export function projectPlaces(
  folders: readonly Pick<LibraryGroup, "id" | "boundFolderId">[],
  onDisk: readonly Pick<Folder, "id" | "linkedFolderId" | "relativePath">[],
  linked: readonly Pick<LinkedFolder, "id" | "path" | "folderId">[],
): Map<string, string> {
  const places = new Map<string, string>();
  for (const folder of folders) {
    const own = linked.find((each) => each.folderId === folder.boundFolderId);
    if (own) {
      places.set(folder.id, own.path);
      continue;
    }
    const bound = onDisk.find((each) => each.id === folder.boundFolderId);
    const root = bound && linked.find((each) => each.id === bound.linkedFolderId);
    if (!bound || !root) continue;
    const separator = root.path.includes("\\") && !root.path.includes("/") ? "\\" : "/";
    const inside = bound.relativePath.split("/").join(separator);
    places.set(folder.id, inside === "" ? root.path : `${root.path}${separator}${inside}`);
  }
  return places;
}

type Placed = Pick<LibraryGroup, "id" | "parentId" | "keepInside">;

/**
 * For each Folder, the Folders above it that share it when an agent is given them (#3394): a
 * Folder shares those inside it up to the next wall, as the core's reach does, so a walled
 * Folder is shared by none above it, and nothing inside it by any above the wall.
 */
export function sharedWithOf(folders: readonly Placed[]): Map<string, string[]> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return new Map(
    folders.map((folder) => {
      const above: string[] = [];
      const seen = new Set([folder.id]);
      let at = folder.keepInside ? undefined : byId.get(folder.parentId ?? "");
      while (at && !seen.has(at.id)) {
        seen.add(at.id);
        above.push(at.id);
        if (at.keepInside) break;
        at = byId.get(at.parentId ?? "");
      }
      return [folder.id, above];
    }),
  );
}

/** Whether a Folder is behind a wall: its own, or one above it (#3544). */
function behindWall(folder: Placed, byId: ReadonlyMap<string, Placed>): boolean {
  const seen = new Set<string>();
  for (let at: Placed | undefined = folder; at && !seen.has(at.id); ) {
    if (at.keepInside) return true;
    seen.add(at.id);
    at = byId.get(at.parentId ?? "");
  }
  return false;
}

/** The Folders an agent given all reads, as the core's reach has them: every one outside a wall. */
function outsideWalls(folders: readonly Placed[]): Placed[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return folders.filter((folder) => !behindWall(folder, byId));
}

/** The Folders an agent given `chosen` reads: those, and the Folders inside them up to a wall. */
export function foldersReached(folders: readonly Placed[], chosen: readonly string[]): string[] {
  if (chosen.includes(ALL_SHARED_ID)) return outsideWalls(folders).map((folder) => folder.id);
  return [...chosen.filter((id) => id !== NOT_IN_A_FOLDER_ID), ...sharedInside(folders, chosen)];
}

/**
 * The Folders ticked when the User goes from all to choosing Folders (#3544): those all reaches
 * now, each Folder inside another shared with it, and Not in a Folder while its row is listed.
 * Only what comes later stops being shared.
 */
export function choiceOfAll(
  folders: readonly Placed[],
  rows: readonly Pick<AgentFolderRow, "id">[],
): string[] {
  return [
    ...outsideWalls(folders)
      .filter((folder) => folder.parentId === null)
      .map((folder) => folder.id),
    ...rows.filter((row) => row.id === NOT_IN_A_FOLDER_ID).map((row) => row.id),
  ];
}

/**
 * Which Folders all leaves out, as the consent says so (#3544): none, or the Folders that keep
 * their work inside them, one bound to a folder on disk as any other (#3613).
 */
export function leftOutOfAll(
  folders: readonly Pick<LibraryGroup, "keepInside">[],
): "none" | "walled" {
  return folders.some((folder) => folder.keepInside) ? "walled" : "none";
}

/** The Folders an agent given `chosen` reads besides those it was given: the Folders inside them. */
export function sharedInside(folders: readonly Placed[], chosen: readonly string[]): string[] {
  const sharedWith = sharedWithOf(folders);
  return folders
    .filter(
      (folder) =>
        !chosen.includes(folder.id) &&
        (sharedWith.get(folder.id) ?? []).some((id) => chosen.includes(id)),
    )
    .map((folder) => folder.id);
}

/**
 * Every Folder as the Library's tree lists it, each under the one it is inside, then Not in a
 * Folder: while it holds a Document, while there is no Document at all, the place an agent can
 * start from (#3364), or while `keepUnfiled`, an agent's choice that can be taken back. The app's
 * own examples are never among Not in a Folder's (`isExample`), as an agent never reads them there.
 */
export function agentFolderRows(
  folders: readonly LibraryGroup[],
  documents: readonly Document[],
  assignments: readonly Pick<DocumentGroupAssignment, "documentId" | "groupId">[],
  keepUnfiled = false,
  isExample: (document: Document) => boolean = () => false,
  places: ReadonlyMap<string, string> = new Map(),
): AgentFolderRow[] {
  const folderOf = new Map(assignments.map((each) => [each.documentId, each.groupId]));
  const listed = documents.filter(isListedDocument);
  const sharedWith = sharedWithOf(folders);
  const counts = new Map<string, number>();
  for (const document of listed) {
    const id = folderOf.get(document.id) ?? null;
    if (id === null || !sharedWith.has(id)) continue;
    for (const each of [id, ...(sharedWith.get(id) ?? [])]) {
      counts.set(each, (counts.get(each) ?? 0) + 1);
    }
  }
  const loose = listed.filter((document) => {
    const id = folderOf.get(document.id) ?? null;
    return (id === null || !sharedWith.has(id)) && !isExample(document);
  });
  return [
    ...flattenFolderTree(buildFolderTree(folders)).map(({ folder, depth }) => ({
      id: folder.id,
      name: folder.name,
      documents: counts.get(folder.id) ?? 0,
      depth,
      walled: folder.keepInside,
      sharedWith: sharedWith.get(folder.id) ?? [],
      place: places.get(folder.id) ?? null,
    })),
    ...(loose.length > 0 || listed.every(isExample) || keepUnfiled
      ? [
          {
            id: NOT_IN_A_FOLDER_ID,
            name: null,
            documents: loose.length,
            depth: 0,
            walled: false,
            sharedWith: [],
            place: null,
          },
        ]
      : []),
  ];
}

/** Whether Not in a Folder is the only choice: every Document is in none. */
export const onlyNotInAFolder = (rows: readonly AgentFolderRow[]): boolean =>
  rows.length === 1 && rows[0]?.id === NOT_IN_A_FOLDER_ID;
