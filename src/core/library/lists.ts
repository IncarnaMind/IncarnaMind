/**
 * The Library's own lists as tables (#2525): its Documents, its Folders and its notes, as a Note's
 * check may see them. No Document's text says how many Documents the Library holds or what they
 * are called, so a check's model counts these rows in code instead of searching for a Passage.
 */
import { createHash } from "node:crypto";
import type { AnalysisCell } from "../../shared/analysis";
import type { Document, LibraryListName, LibrarySource } from "../api";
import type { LibraryGroup } from "./types";

export interface LibraryList {
  columns: readonly string[];
  rows: readonly (readonly AnalysisCell[])[];
}

export type LibraryLists = Record<LibraryListName, LibraryList> & {
  /** Whose lists they are, in the scope chip's words: the whole Library, or what a wall leaves. */
  source: LibrarySource;
};

export const isLibraryList = (name: string): name is LibraryListName =>
  name === "documents" || name === "folders" || name === "notes";

export interface LibrarySeen {
  source: LibrarySource;
  documents: readonly Pick<Document, "id" | "name" | "kind" | "tags">[];
  folders: readonly Pick<LibraryGroup, "id" | "name" | "parentId">[];
  /** The Folder each filed Document is in, by the Document's id. */
  folderOf: ReadonlyMap<string, string>;
  tagNames: ReadonlyMap<string, string>;
  notes: readonly { name: string; folderId: string | null }[];
}

/**
 * A value that differs whenever any of the lists does, in whatever order their rows come: what a
 * check that counted them rests on.
 */
export const libraryVersion = ({ documents, folders, notes }: LibraryLists): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [documents, folders, notes].map(({ rows }) =>
          rows.map((row) => JSON.stringify(row)).sort(),
        ),
      ),
    )
    .digest("base64url")
    .slice(0, 22);

export function libraryLists(seen: LibrarySeen): LibraryLists {
  const folderName = new Map(seen.folders.map((folder) => [folder.id, folder.name]));
  const named = (folderId: string | null | undefined) => folderName.get(folderId ?? "") ?? "";
  const parentOf = new Map(seen.folders.map((folder) => [folder.id, folder.parentId]));
  const held = new Map<string, number>();
  for (const document of seen.documents) {
    // A Folder holds what is filed in it and in the Folders inside it, as the Library counts it.
    const above = new Set<string>();
    for (
      let at = seen.folderOf.get(document.id) ?? null;
      at !== null && folderName.has(at) && !above.has(at);
      at = parentOf.get(at) ?? null
    ) {
      above.add(at);
      held.set(at, (held.get(at) ?? 0) + 1);
    }
  }
  return {
    source: seen.source,
    documents: {
      columns: ["name", "kind", "folder", "tags"],
      rows: seen.documents.map((document) => [
        document.name,
        document.kind,
        named(seen.folderOf.get(document.id)),
        document.tags
          .flatMap((tag) => seen.tagNames.get(tag.tagId) ?? [])
          .sort()
          .join(", "),
      ]),
    },
    folders: {
      columns: ["name", "inside", "documents"],
      rows: seen.folders.map((folder) => [
        folder.name,
        named(folder.parentId),
        held.get(folder.id) ?? 0,
      ]),
    },
    notes: {
      columns: ["name", "folder"],
      rows: seen.notes.map((note) => [note.name, named(note.folderId)]),
    },
  };
}
