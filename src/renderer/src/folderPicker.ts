import type { LibraryGroup } from "../../core/api";
import { buildFolderTree, flattenFolderTree, folderPath } from "./folders";
import { matchName, queryWords } from "./matcher";

/** A Folder in Move to…, with the place it is in and how deep the tree indents it. */
export interface FolderTreeOption {
  folder: LibraryGroup;
  label: string;
  indent: number;
  /** Its place while a query narrows the list ("Thesis: Chapter 2 sources"), for the search. */
  keywords: string[];
  /** The place drawn beside its name; set when a query narrows, or another Folder in view has its name. */
  detail?: string;
}

/**
 * The Folders as an indented tree, filtered by a typed query; two Folders with one name are
 * told apart by their place even before a query narrows the tree (#2425).
 */
export function sharedFolderNames(groups: readonly LibraryGroup[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const folder of groups) {
    const name = folder.name.toLocaleLowerCase();
    if (seen.has(name)) shared.add(name);
    seen.add(name);
  }
  return shared;
}

export function folderTreeOptions(
  groups: readonly LibraryGroup[],
  query: string,
  t: (key: "move.inFolder", params: { path: string }) => string,
): FolderTreeOption[] {
  const words = queryWords(query);
  const shared = sharedFolderNames(groups);
  const options = flattenFolderTree(buildFolderTree(groups)).flatMap(
    ({ folder, depth }): FolderTreeOption[] => {
      const parentPath = folderPath(groups, folder.parentId).join(" › ");
      const twice = parentPath !== "" && shared.has(folder.name.toLocaleLowerCase());
      return [
        {
          folder,
          label: folder.name,
          indent: depth,
          keywords: parentPath ? [parentPath] : [],
          ...(twice && { detail: t("move.inFolder", { path: parentPath }) }),
        },
      ];
    },
  );
  if (words.length === 0) return options;
  return options.flatMap((option) => {
    const byName = matchName(words, option.label);
    const byPath = option.keywords.some((each) => matchName(words, each));
    if (!byName && !byPath) return [];
    const path = folderPath(groups, option.folder.parentId).join(" › ");
    return [{ ...option, indent: 0, ...(path && { detail: t("move.inFolder", { path }) }) }];
  });
}
