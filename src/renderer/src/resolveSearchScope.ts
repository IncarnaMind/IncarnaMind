import type { LibraryGroup, SearchScope } from "../../core/api";
import { folderScope, mindSearchScope } from "../../shared/searchScope";
import { folderWallOf } from "./folders";
import { scopeWithin } from "./scope";

interface ScopeInputs {
  /** The scope the User chose in the box, if they did. */
  draft: SearchScope | null;
  /** The Folder of the Note the box is in. */
  folderId: string | null;
  folderHolds: boolean;
  /** The walled Folder of the turn; null outside every wall. */
  wall: string | null;
  /** The Folder the Library shows in front. */
  libraryFolderId: string | null;
  /** No Note is open in the box: the core reads the Library's walled Folder only then (#2529). */
  noNote: boolean;
  groups: readonly LibraryGroup[] | undefined;
}

/**
 * What the next Question searches, worked out once for everything that says it: the chat box's
 * chips and Ask, and the line above the conversation (#2948). Behind a wall that Folder alone; with
 * the Library showing a Folder, that Folder in front, alone inside its own wall (#2529).
 */
export function resolveSearchScope({
  draft,
  folderId,
  folderHolds,
  wall,
  libraryFolderId,
  noNote,
  groups,
}: ScopeInputs): {
  /** Within the turn's wall, before the Library's Folder is put in front. */
  scope: SearchScope;
  resolved: SearchScope;
  libraryWalled: boolean;
} {
  const scope = scopeWithin(wall, mindSearchScope(draft, folderId, folderHolds));
  if (libraryFolderId === null) return { scope, resolved: scope, libraryWalled: false };
  const libraryWalled = folderWallOf(groups ?? [], libraryFolderId) !== null;
  // With a Note open the Question keeps to the Note's own wall, whatever Folder the Library shows.
  if (libraryWalled && !noNote) return { scope, resolved: scope, libraryWalled: false };
  const resolved = libraryWalled
    ? folderScope(libraryFolderId)
    : {
        ...scope,
        folderIds: [libraryFolderId, ...scope.folderIds.filter((id) => id !== libraryFolderId)],
      };
  return { scope, resolved, libraryWalled };
}
