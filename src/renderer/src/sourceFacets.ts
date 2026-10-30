import type {
  CitationAttributes,
  ClaimCheckAttributes,
  ClaimCheckPart,
  Document,
} from "../../core/api";
import { checkedScope } from "../../shared/claimChecks";
import { displayName } from "../../shared/documentNames";
import { NO_SCOPE, resolveSearchScope } from "../../shared/searchScope";
import { normaliseText } from "../../shared/text";
import type { ScopeLibrary } from "./scope";
import { keptInsideName, scopeOutsideWalls } from "./walls";

export interface SourceFacetChoice {
  document: Document;
  folder: string | null;
  citation: CitationAttributes | null;
  needsRecheck: boolean;
}

export function sourceFacetChoices(
  check: Pick<ClaimCheckAttributes, "text" | "scope" | "excluded">,
  part: ClaimCheckPart,
  library: ScopeLibrary,
  mindFolderId: string | null,
): { name: string; choices: SourceFacetChoice[] } | null {
  const facet = part.facet;
  if (facet?.kind !== "source" || !facet.named || !facet.candidates) return null;
  const { start, end } = facet.named;
  if (start < part.span.start || end > part.span.end || end <= start) return null;
  const name = check.text.slice(start, end);
  if (name.trim() === "") return null;
  const walls = { groups: library.groups ?? [], assignments: library.assignments ?? [] };
  const scope = scopeOutsideWalls(walls, checkedScope(check.scope), mindFolderId);
  const ownWall = library.groups?.find((group) => group.id === mindFolderId && group.keepInside);
  const folderTree = (id: string): string[] => {
    if (!library.folders.some((folder) => folder.id === id)) return [];
    const found = new Set([id]);
    const pending = [id];
    while (pending.length > 0) {
      const parent = pending.pop();
      for (const folder of library.folders) {
        if (folder.parentId !== parent || found.has(folder.id)) continue;
        found.add(folder.id);
        pending.push(folder.id);
      }
    }
    return [...found];
  };
  const wanted = ownWall ? { ...NO_SCOPE, folderIds: [ownWall.id] } : (scope ?? NO_SCOPE);
  // Removing a forbidden Folder must not turn its empty scope into every Document (#1934).
  const forbiddenOnly =
    !ownWall &&
    checkedScope(check.scope) !== null &&
    scope !== null &&
    scope.folderIds.length + scope.tagIds.length + scope.documentIds.length === 0;
  const allowed = forbiddenOnly
    ? []
    : resolveSearchScope(wanted, {
        folderTree,
        organizedFolderDocuments: (id) => {
          const group = library.groups?.find((group) => group.id === id);
          if (!group) return [];
          return (library.assignments ?? [])
            .filter((each) => each.groupId === id && (!group.keepInside || each.source === "user"))
            .map((each) => each.documentId);
        },
        documentIds: (filter) =>
          library.documents
            .filter(
              (document) =>
                (!filter.folderIds ||
                  (document.folderId !== null && filter.folderIds.includes(document.folderId))) &&
                (!filter.tagId ||
                  (library.tags.some((tag) => tag.id === filter.tagId) &&
                    document.tags.some((tag) => tag.tagId === filter.tagId))) &&
                (!filter.ids || filter.ids.includes(document.id)),
            )
            .map((document) => document.id),
      });
  const ids = allowed === null ? null : new Set(allowed);
  const excluded = new Set(check.excluded.map((each) => each.documentId));
  const title = (text: string) => normaliseText(text).toLocaleLowerCase();
  const choices = facet.candidates.flatMap(({ documentId, citationId }) => {
    const document = library.documents.find((each) => each.id === documentId);
    if (
      !document ||
      (ids !== null && !ids.has(document.id)) ||
      excluded.has(document.id) ||
      document.notCited ||
      keptInsideName(walls, document.id, mindFolderId) !== null ||
      title(displayName(document)) !== title(name)
    )
      return [];
    const receipt = citationId
      ? part.evidence.find(
          (each) =>
            each.id === citationId && each.documentId === document.id && each.check === "found",
        )
      : undefined;
    const current = receipt?.contentHash === document.contentHash;
    const groupId = library.assignments?.find((each) => each.documentId === documentId)?.groupId;
    const folder =
      library.groups?.find((each) => each.id === groupId)?.name ??
      library.folders.find((each) => each.id === document.folderId)?.name ??
      null;
    return [
      {
        document,
        folder,
        citation: current ? (receipt ?? null) : null,
        needsRecheck: receipt !== undefined && !current,
      },
    ];
  });
  return { name, choices };
}
