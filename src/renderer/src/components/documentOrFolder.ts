import type { SearchScope } from "../../../core/api";
import { NO_SCOPE } from "../../../shared/searchScope";
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
  const walls = new Map(
    (library.groups ?? [])
      .filter((group) => group.keepInside)
      .map((group) => [group.id, group.name]),
  );
  const filings = (library.assignments ?? []).filter(
    (each) => choice.kind === "document" && each.documentId === choice.id,
  );
  const behind =
    choice.kind === "folder"
      ? walls.has(choice.id)
        ? choice.id
        : null
      : (filings.find((each) => walls.has(each.groupId ?? ""))?.groupId ?? null);
  if (wall === null) return behind === null ? null : { inside: walls.get(behind) ?? "" };
  const filedInside =
    choice.kind === "folder"
      ? choice.id === wall
      : filings.some((each) => each.groupId === wall && each.source === "user");
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
