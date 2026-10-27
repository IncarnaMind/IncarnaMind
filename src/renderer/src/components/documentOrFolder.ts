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

/** A scope naming exactly the chosen Folder or Document. */
export function documentOrFolderScope(choice: DocumentOrFolderChoice): SearchScope {
  return {
    folderIds: choice.kind === "folder" ? [choice.id] : [],
    tagIds: [],
    documentIds: choice.kind === "document" ? [choice.id] : [],
  };
}
