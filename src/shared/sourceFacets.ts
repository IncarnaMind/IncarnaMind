import type {
  CitationAttributes,
  ClaimCheckBasis,
  ClaimCheckPart,
  Document,
  DocumentGroupAssignment,
  Folder,
  LibraryGroup,
  Tag,
} from "../core/api";
import { checkedScope } from "./claimChecks";
import { readPartPlans } from "./claimParts";
import { displayName } from "./documentNames";
import { NO_SCOPE, resolveSearchScope } from "./searchScope";
import { normaliseText } from "./text";
import { keptInsideName, scopeOutsideWalls } from "./walls";

export interface SourceFacetLibrary {
  documents: readonly Document[];
  folders: readonly Folder[];
  tags: readonly Tag[];
  groups?: readonly LibraryGroup[];
  assignments?: readonly DocumentGroupAssignment[];
}

export interface SourceFacetChoice {
  document: Document;
  folder: string | null;
  citation: CitationAttributes | null;
  needsRecheck: boolean;
}

export type SourceChoiceProblem =
  | { kind: "unavailable" }
  | { kind: "deleted"; name: string }
  | { kind: "walled"; name: string; folder: string }
  | { kind: "out-of-scope"; name: string }
  | { kind: "renamed"; name: string; currentName: string };

type SourceCheck = Pick<ClaimCheckBasis, "text" | "scope" | "excluded" | "parts">;

function sourceEligibility(
  check: Pick<SourceCheck, "scope" | "excluded">,
  library: SourceFacetLibrary,
  mindFolderId: string | null,
) {
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
  return (name: string, document: Document | undefined): SourceChoiceProblem | null => {
    if (!document) return { kind: "deleted", name };
    const wall = keptInsideName(walls, document.id, mindFolderId);
    if (wall !== null) return { kind: "walled", name, folder: wall };
    if ((ids !== null && !ids.has(document.id)) || excluded.has(document.id) || document.notCited)
      return { kind: "out-of-scope", name };
    const currentName = displayName(document);
    return title(currentName) === title(name) ? null : { kind: "renamed", name, currentName };
  };
}

export function sourceFacetChoices(
  check: Pick<ClaimCheckBasis, "text" | "scope" | "excluded">,
  part: ClaimCheckPart,
  library: SourceFacetLibrary,
  mindFolderId: string | null,
): { name: string; choices: SourceFacetChoice[] } | null {
  const facet = part.facet;
  if (facet?.kind !== "source" || !facet.named || !facet.candidates) return null;
  const { start, end } = facet.named;
  if (start < part.span.start || end > part.span.end || end <= start) return null;
  const name = check.text.slice(start, end);
  if (name.trim() === "") return null;
  const problem = sourceEligibility(check, library, mindFolderId);
  const choices = facet.candidates.flatMap(({ documentId, citationId }) => {
    const document = library.documents.find((each) => each.id === documentId);
    if (!document || problem(name, document)) return [];
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

export function sourceChoiceProblem(
  check: SourceCheck,
  library: SourceFacetLibrary | null,
  mindFolderId: string | null,
): SourceChoiceProblem | null {
  const selected = (check.parts ?? []).filter(
    (part) => part.facet?.kind === "source" && part.facet.selectedDocumentId !== undefined,
  );
  if (selected.length === 0) return null;
  if (!library || library.groups === undefined || library.assignments === undefined)
    return { kind: "unavailable" };
  const problem = sourceEligibility(check, library, mindFolderId);
  const problems: SourceChoiceProblem[] = [];
  for (const part of selected) {
    const facet = part.facet;
    if (facet?.kind !== "source" || !facet.named || readPartPlans([part], check.text) === null)
      return { kind: "unavailable" };
    const name = check.text.slice(facet.named.start, facet.named.end);
    if (name.trim() === "") return { kind: "unavailable" };
    const found = problem(
      name,
      library.documents.find((each) => each.id === facet.selectedDocumentId),
    );
    if (found) problems.push(found);
  }
  for (const kind of ["deleted", "walled", "out-of-scope", "renamed"] as const) {
    const found = problems.find((problem) => problem.kind === kind);
    if (found) return found;
  }
  return null;
}
