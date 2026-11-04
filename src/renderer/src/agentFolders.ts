/**
 * What an agent may be allowed to read, as the list of choices in Settings →
 * Agents shows it. Pure: no store, no bridge, so the tests import it.
 */
import {
  type Document,
  type DocumentGroupAssignment,
  type LibraryGroup,
  NOT_IN_A_FOLDER_ID,
} from "../../core/api";
import { treeCounts } from "./libraryPage";

export interface AgentFolderRow {
  /** The Folder's id, or `NOT_IN_A_FOLDER_ID`. */
  id: string;
  /** The Folder's name; null for Not in a Folder, which the interface names. */
  name: string | null;
  /** How many Documents it holds now, those in its sub-Folders too. */
  documents: number;
}

/**
 * Every Folder in the order given, then Not in a Folder while it holds a
 * Document, as the Library lists them.
 */
export function agentFolderRows(
  folders: readonly LibraryGroup[],
  documents: readonly Document[],
  assignments: readonly Pick<DocumentGroupAssignment, "documentId" | "groupId">[],
): AgentFolderRow[] {
  const folderOf = new Map(assignments.map((each) => [each.documentId, each.groupId]));
  const counts = treeCounts(
    folders,
    documents.flatMap((document) => {
      const id = folderOf.get(document.id) ?? null;
      return id === null ? [] : [{ folderId: id }];
    }),
  );
  const known = new Set(folders.map((folder) => folder.id));
  const loose = documents.filter((document) => {
    const id = folderOf.get(document.id) ?? null;
    return id === null || !known.has(id);
  });
  return [
    ...folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      documents: counts.get(folder.id) ?? 0,
    })),
    ...(loose.length > 0 ? [{ id: NOT_IN_A_FOLDER_ID, name: null, documents: loose.length }] : []),
  ];
}

/** Whether Not in a Folder is the only choice: every Document is in none. */
export const onlyNotInAFolder = (rows: readonly AgentFolderRow[]): boolean =>
  rows.length === 1 && rows[0]?.id === NOT_IN_A_FOLDER_ID;
