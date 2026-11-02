import type { SearchScope } from "../../../core/api";
import { NO_SCOPE } from "../../../shared/searchScope";
import { folderWallOf, isInsideFolder } from "../folders";
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

/**
 * Why a Note behind `wall` (null: outside every wall) can't read a choice whole, as its searches
 * can't (#1934): outside, one a wall keeps inside names that wall's Folder; inside, anything but
 * the wall's Folder and the Documents the User filed in it is outside. Null when it can.
 */
export function keptFrom(
  library: ScopeLibrary,
  choice: DocumentOrFolderChoice,
  wall: string | null,
): { inside: string } | "outside" | null {
  const groups = library.groups ?? [];
  const names = new Map(groups.map((group) => [group.id, group.name]));
  const filings = (library.assignments ?? []).filter(
    (each) => choice.kind === "document" && each.documentId === choice.id,
  );
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
