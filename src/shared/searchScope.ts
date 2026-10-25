/**
 * A Question's Search scope as its Block stores it (see `QuestionAttributes`):
 * read the same way by the core, which resolves it when the Question is asked,
 * and by the editor, which shows it as chips.
 */
import type { Document, QuestionAttributes, SearchScope } from "../core/api";

/** What a Search scope can name. */
export type ScopeKind = "folder" | "tag" | "document";

export const SCOPE_KINDS: readonly ScopeKind[] = ["folder", "tag", "document"];

/** The Question attribute that holds each kind's ids. */
export const SCOPE_ATTRIBUTES = {
  folder: "scopeFolderIds",
  tag: "scopeTagIds",
  document: "scopeDocumentIds",
} as const satisfies Record<ScopeKind, keyof QuestionAttributes>;

/** The ids in an attribute, in order, once each; anything that isn't a list of ids counts as none. */
function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && id !== "");
  return [...new Set(ids)];
}

/** A Question's Search scope, from its Block's attributes. */
export function searchScopeOf(attributes: Readonly<Record<string, unknown>>): SearchScope {
  return {
    folderIds: idsOf(attributes[SCOPE_ATTRIBUTES.folder]),
    tagIds: idsOf(attributes[SCOPE_ATTRIBUTES.tag]),
    documentIds: idsOf(attributes[SCOPE_ATTRIBUTES.document]),
  };
}

/** A Search scope as a Question's Block stores it: the inverse of `searchScopeOf`. */
export function scopeAttributesOf(
  scope: SearchScope,
): Pick<QuestionAttributes, (typeof SCOPE_ATTRIBUTES)[ScopeKind]> {
  const ids = (list: readonly string[]) => (list.length > 0 ? [...list] : null);
  return {
    [SCOPE_ATTRIBUTES.folder]: ids(scope.folderIds),
    [SCOPE_ATTRIBUTES.tag]: ids(scope.tagIds),
    [SCOPE_ATTRIBUTES.document]: ids(scope.documentIds),
  };
}

/** The ids of one kind in a Search scope. */
export function scopeIds(scope: SearchScope, kind: ScopeKind): string[] {
  return kind === "folder" ? scope.folderIds : kind === "tag" ? scope.tagIds : scope.documentIds;
}

/** Whether a Question has a Search scope at all. Without one, every Document is searched. */
export function hasSearchScope(scope: SearchScope): boolean {
  return scope.folderIds.length + scope.tagIds.length + scope.documentIds.length > 0;
}

/** Whether a Document counts among a Folder's or a Tag's: it is there, and has text to search or soon will. */
export const holdsText = (document: Pick<Document, "status" | "fileStatus">): boolean =>
  document.fileStatus !== "missing" &&
  document.status !== "failed" &&
  document.status !== "no-text";

/** A Search scope as it is kept outside a Question's Block (JSON { folderIds, tagIds, documentIds }); null for anything else. */
export function storedSearchScope(value: unknown): SearchScope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { folderIds, tagIds, documentIds } = value as Record<string, unknown>;
  return { folderIds: idsOf(folderIds), tagIds: idsOf(tagIds), documentIds: idsOf(documentIds) };
}

export const NO_SCOPE: SearchScope = { folderIds: [], tagIds: [], documentIds: [] };

export const folderScope = (folderId: string | null): SearchScope =>
  folderId === null ? NO_SCOPE : { folderIds: [folderId], tagIds: [], documentIds: [] };

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export const sameScope = (a: SearchScope, b: SearchScope): boolean =>
  SCOPE_KINDS.every((kind) => sameIds(scopeIds(a, kind), scopeIds(b, kind)));

/**
 * The scope to keep for a Mind once the User changes it: null (the Mind's
 * own again) when it is the Mind's own, so it follows the Mind to another Folder.
 */
export function chosenScope(scope: SearchScope, folderId: string | null): SearchScope | null {
  // A Folder's Mind with no scope left searches everything, by the User's choice: kept.
  return sameScope(scope, folderScope(folderId)) ? null : hasSearchScope(scope) ? scope : NO_SCOPE;
}

/**
 * How a Search scope is named where one name is shown: its first Folder, else Tag, else
 * Document (`name` null: deleted since), and how many more it names. Null for no scope.
 */
export function scopeName(
  scope: SearchScope,
  nameOf: (kind: ScopeKind, id: string) => string | null,
): { kind: ScopeKind; name: string | null; more: number } | null {
  const kind = SCOPE_KINDS.find((each) => scopeIds(scope, each).length > 0);
  const first = kind && scopeIds(scope, kind)[0];
  if (!kind || first === undefined) return null;
  const count = SCOPE_KINDS.reduce((total, each) => total + scopeIds(scope, each).length, 0);
  return { kind, name: nameOf(kind, first), more: count - 1 };
}

/** The Folder a Search scope is, when it is one Folder alone; null otherwise. */
export const oneFolderOf = (scope: SearchScope | null): string | null =>
  scope && scope.folderIds.length === 1 && scope.tagIds.length + scope.documentIds.length === 0
    ? (scope.folderIds[0] ?? null)
    : null;

/**
 * Where a new Mind made from a Question goes: the one Folder its scope names, else the Folder
 * of the Mind it came from, however far the search widened (#1359).
 */
export const filingFolder = (scope: SearchScope | null, mindFolderId: string | null) =>
  oneFolderOf(scope) ?? mindFolderId;

/**
 * What a Question from a Mind in `folderId` searches (#1359). `chosen` is the scope the User
 * set, null for none: the Mind's own, its Folder. The Mind's own Folder gives way to every
 * Document (no scope) while it holds none, so a Mind filed into an empty Folder still searches
 * what the User has; any other scope stays as chosen. Where new Minds are filed doesn't follow.
 */
export function mindSearchScope(
  chosen: SearchScope | null,
  folderId: string | null,
  folderHoldsDocument: boolean,
): SearchScope {
  if (chosen !== null && (folderId === null || oneFolderOf(chosen) !== folderId)) return chosen;
  return {
    folderIds: folderId !== null && folderHoldsDocument ? [folderId] : [],
    tagIds: [],
    documentIds: [],
  };
}
