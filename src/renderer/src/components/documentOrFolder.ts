import type { Document, Mind, SearchScope } from "../../../core/api";
import { NO_SCOPE } from "../../../shared/searchScope";
import { folderWallOf, isInsideFolder } from "../folders";
import { withTranscriptsFiled } from "../meetingTranscript";
import { type ScopeChoice, type ScopeLibrary, scopeChoices } from "../scope";

export type DocumentOrFolderChoice = Omit<ScopeChoice, "kind"> & {
  kind: "folder" | "document";
};

/** Folders and Documents matching a name, its pinyin or its initials; never Tags. */
export function documentOrFolderChoices(
  library: ScopeLibrary,
  query: string,
): DocumentOrFolderChoice[] {
  return scopeChoices(library, NO_SCOPE, query).filter(
    (choice): choice is DocumentOrFolderChoice =>
      choice.kind === "folder" || choice.kind === "document",
  );
}

/** What `keptFrom` reads of the Library: its Folders, where Documents are filed, and whose meeting each is. */
export interface FilingLibrary extends Pick<ScopeLibrary, "groups" | "assignments"> {
  documents: readonly Pick<Document, "id" | "meetingMindId">[];
  minds?: readonly Pick<Mind, "id" | "folderId">[];
}

/** What `readableFrom` reads of the Library: what `keptFrom` does, and each Document's status. */
export interface ReadableLibrary extends FilingLibrary {
  documents: readonly Pick<Document, "id" | "status" | "meetingMindId">[];
}

/**
 * Whether a Note in the in-app Folder `folderId` (null: in none) may read a Document or Folder
 * whole, as the shared picker offers them: on the Note's side of a Folder wall, and a Document
 * with text.
 */
export function readableFrom(
  library: ReadableLibrary,
  folderId: string | null,
  choice: Pick<DocumentOrFolderChoice, "kind" | "id">,
): boolean {
  const wall = folderId === null ? null : folderWallOf(library.groups ?? [], folderId);
  const textless =
    choice.kind === "document" &&
    library.documents.find((each) => each.id === choice.id)?.status === "no-text";
  return !textless && keptFrom(library, choice, wall) === null;
}

/**
 * Why a Note behind `wall` (null: outside every wall) can't read a choice whole, as its searches
 * can't (#1934): outside, one a wall keeps inside names that wall's Folder; inside, anything but
 * the wall's Folder and the Documents the User filed in it is outside. Null when it can.
 */
export function keptFrom(
  library: FilingLibrary,
  choice: Pick<DocumentOrFolderChoice, "kind" | "id">,
  wall: string | null,
): { inside: string } | "outside" | null {
  const groups = library.groups ?? [];
  const names = new Map(groups.map((group) => [group.id, group.name]));
  const filings = withTranscriptsFiled(
    library.assignments ?? [],
    library.documents,
    library.minds ?? [],
  ).filter((each) => choice.kind === "document" && each.documentId === choice.id);
  // A Folder inside a walled Folder is behind the same wall.
  const behind =
    choice.kind === "folder"
      ? folderWallOf(groups, choice.id)
      : (filings.flatMap((each) => {
          const found = folderWallOf(groups, each.groupId ?? "");
          return found === null ? [] : [found];
        })[0] ?? null);
  if (wall === null) return behind === null ? null : { inside: names.get(behind) ?? "" };
  const filedInside =
    choice.kind === "folder"
      ? choice.id === wall || isInsideFolder(groups, choice.id, wall)
      : filings.some(
          (each) =>
            each.groupId !== null &&
            each.source === "user" &&
            (each.groupId === wall || isInsideFolder(groups, each.groupId, wall)),
        );
  return filedInside ? null : "outside";
}

/** A scope naming exactly the chosen Folder or Document. */
export function documentOrFolderScope(choice: DocumentOrFolderChoice): SearchScope {
  return {
    folderIds: choice.kind === "folder" ? [choice.id] : [],
    tagIds: [],
    documentIds: choice.kind === "document" ? [choice.id] : [],
  };
}
