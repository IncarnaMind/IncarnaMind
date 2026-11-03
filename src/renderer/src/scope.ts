import type {
  Document,
  DocumentGroupAssignment,
  DocumentKind,
  Folder,
  LibraryGroup,
  SearchScope,
  Tag,
} from "../../core/api";
import type { MessageKey } from "../../shared/i18n";
import {
  folderScope,
  holdsText,
  SCOPE_KINDS,
  type ScopeKind,
  scopeIds,
} from "../../shared/searchScope";
import { buildFolderTree, flattenFolderTree, folderPath } from "./folders";
import { matchName, queryWords } from "./matcher";

/** What a scope item gone without its name is called: "Deleted Folder". */
export const DELETED_NAMES: Record<ScopeKind, MessageKey> = {
  folder: "scope.chip.deleted.folder",
  tag: "scope.chip.deleted.tag",
  document: "scope.chip.deleted.document",
};

/** The Folders, Tags and Documents a Search scope can name, as the app store holds them. */
export interface ScopeLibrary {
  folders: readonly Folder[];
  groups?: readonly LibraryGroup[];
  /** In-app Folders deleted since: a scope naming one still shows its name. */
  deletedGroups?: readonly LibraryGroup[];
  tags: readonly Tag[];
  documents: readonly Document[];
  /** Which in-app Folder each Document is filed in; the counts of those Folders read it. */
  assignments?: readonly DocumentGroupAssignment[];
}

/** A Folder, Tag or Document the "@" picker offers for a Question's Search scope. */
export interface ScopeChoice {
  /**
   * For a Folder or Tag: how many Documents it holds that can be searched (0: it is empty, and a
   * search limited to it finds nothing). Undefined for a Document.
   */
  count?: number;
  kind: ScopeKind;
  id: string;
  name: string;
  /** A Folder's parent Folders' names, outermost first: where it is. Empty otherwise. */
  path: string[];
  sourceLocation?: boolean;
  /** The Folder wall this item belongs to, if any. */
  walled?: string | null;
  /** A Document's kind, for its icon. */
  documentKind: DocumentKind | null;
}

/** A Search scope item as a chip on its Question. */
export interface ScopeChip {
  /** The same count as its choice's; undefined for a Document, or once it is deleted. */
  count?: number;
  kind: ScopeKind;
  id: string;
  /**
   * Its name, or null once it is deleted and its name is gone with it. An
   * in-app Folder deleted keeps its name here.
   */
  name: string | null;
  /** Its place, a Folder's own name last: "Thesis › Chapter 2"; empty for a Tag or Document. */
  path: string[];
  /** Deleted since: the search ignores it. */
  deleted: boolean;
  documentKind: DocumentKind | null;
}

/** The most choices of one kind the picker lists at once; typing narrows them. */
const MAX_CHOICES_PER_KIND = 50;

/**
 * How many Documents each Folder and Tag holds that can be searched (#764): an in-app
 * Folder's filed Documents and those of the Folders inside it (suggested ones too, unless
 * a Folder there keeps its work inside it), a Linked folder's Documents with those in its
 * sub-Folders, and a Tag's.
 */
export function scopeCounts(library: ScopeLibrary): Map<string, number> {
  const counts = new Map<string, number>();
  const live = library.documents.filter(holdsText);
  const liveIds = new Set(live.map((document) => document.id));
  const groups = library.groups ?? [];
  const assignments = library.assignments ?? [];
  const byId = new Map(groups.map((group) => [group.id, group]));
  const insideWall = (id: string): boolean => {
    const seen = new Set<string>();
    let at: LibraryGroup | undefined = byId.get(id);
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      if (at.keepInside) return true;
      at = at.parentId === null ? undefined : byId.get(at.parentId);
    }
    return false;
  };
  const sumUp = (
    ids: readonly string[],
    parentOf: (id: string) => string | null,
    direct: ReadonlyMap<string, number>,
  ): Map<string, number> => {
    const known = new Set(ids);
    const children = new Map<string, string[]>();
    for (const id of ids) {
      const parent = parentOf(id);
      if (parent !== null && known.has(parent))
        children.set(parent, [...(children.get(parent) ?? []), id]);
    }
    const counted = new Map<string, number>();
    const count = (id: string, seen: Set<string>): number => {
      const held = counted.get(id);
      if (held !== undefined) return held;
      if (seen.has(id)) return 0;
      seen.add(id);
      const total =
        (direct.get(id) ?? 0) +
        (children.get(id) ?? []).reduce((sum, child) => sum + count(child, seen), 0);
      counted.set(id, total);
      return total;
    };
    for (const id of ids) count(id, new Set());
    return counted;
  };
  const groupDirect = new Map<string, number>();
  for (const group of groups) {
    groupDirect.set(
      group.id,
      assignments.filter(
        (each) =>
          each.groupId === group.id &&
          liveIds.has(each.documentId) &&
          (!insideWall(group.id) || each.source === "user"),
      ).length,
    );
  }
  for (const [id, held] of sumUp(
    groups.map((group) => group.id),
    (id) => byId.get(id)?.parentId ?? null,
    groupDirect,
  ))
    counts.set(id, held);
  const linkedById = new Map(library.folders.map((folder) => [folder.id, folder]));
  const linkedDirect = new Map<string, number>();
  for (const document of live) {
    if (document.folderId)
      linkedDirect.set(document.folderId, (linkedDirect.get(document.folderId) ?? 0) + 1);
  }
  for (const [id, held] of sumUp(
    library.folders.map((folder) => folder.id),
    (id) => linkedById.get(id)?.parentId ?? null,
    linkedDirect,
  ))
    counts.set(id, held);
  for (const tag of library.tags) {
    counts.set(
      tag.id,
      live.filter((document) => document.tags.some((each) => each.tagId === tag.id)).length,
    );
  }
  return counts;
}

/** Every Folder, Tag and Document, in the sidebar's order: Folders as a tree, depth first. */
function everything(library: ScopeLibrary): ScopeChoice[] {
  const counts = scopeCounts(library);
  const groups = library.groups ?? [];
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const groupWall = (id: string): string | null => {
    const seen = new Set<string>();
    let at: LibraryGroup | undefined = groupById.get(id);
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      if (at.keepInside) return at.id;
      at = at.parentId === null ? undefined : groupById.get(at.parentId);
    }
    return null;
  };
  const documentWall = (documentId: string) => {
    const filed = (library.assignments ?? []).find((each) => each.documentId === documentId);
    return filed?.groupId ? groupWall(filed.groupId) : null;
  };
  const names = new Map(library.folders.map((folder) => [folder.id, folder.name]));
  const parents = new Map(library.folders.map((folder) => [folder.id, folder.parentId]));
  const pathOf = (folder: Folder) => {
    const path: string[] = [];
    const seen = new Set<string>([folder.id]);
    let parent = folder.parentId;
    for (; parent && !seen.has(parent); parent = parents.get(parent) ?? null) {
      seen.add(parent);
      const name = names.get(parent);
      if (name !== undefined) path.unshift(name);
    }
    return path;
  };
  return [
    ...flattenFolderTree(buildFolderTree(groups)).map(
      ({ folder }): ScopeChoice => ({
        kind: "folder",
        id: folder.id,
        name: folder.name,
        path: folderPath(groups, folder.id).slice(0, -1),
        documentKind: null,
        count: counts.get(folder.id) ?? 0,
        walled: groupWall(folder.id),
      }),
    ),
    ...flattenFolderTree(buildFolderTree(library.folders)).map(
      ({ folder }): ScopeChoice => ({
        kind: "folder",
        id: folder.id,
        name: folder.name,
        path: pathOf(folder),
        sourceLocation: groups.length > 0,
        documentKind: null,
        count: counts.get(folder.id) ?? 0,
      }),
    ),
    ...library.tags.map(
      (tag): ScopeChoice => ({
        kind: "tag",
        id: tag.id,
        name: tag.name,
        path: [],
        documentKind: null,
        count: counts.get(tag.id) ?? 0,
      }),
    ),
    ...library.documents.map(
      (document): ScopeChoice => ({
        kind: "document",
        id: document.id,
        name: document.name,
        path: [],
        documentKind: document.kind,
        walled: documentWall(document.id),
      }),
    ),
  ];
}

/**
 * What the picker offers for `query` (typed after the "@"): the Folders, Tags
 * and Documents whose names match it, a Chinese name by its pinyin too (the
 * matcher ⌘K uses), those starting a word first, grouped in that order. Those
 * already in the scope aren't offered again.
 */
export function scopeChoices(
  library: ScopeLibrary,
  scope: SearchScope,
  query: string,
): ScopeChoice[] {
  const words = queryWords(query);
  const chosen = new Set(
    SCOPE_KINDS.flatMap((kind) => scopeIds(scope, kind).map((id) => `${kind}:${id}`)),
  );
  const all = everything(library).filter((choice) => !chosen.has(`${choice.kind}:${choice.id}`));
  return SCOPE_KINDS.flatMap((kind) => {
    const ofKind = all.filter((choice) => choice.kind === kind);
    const matching =
      words.length === 0
        ? ofKind
        : ofKind
            .flatMap((choice, index) => {
              const match = matchName(words, choice.name);
              return match && !match.typo ? [{ choice, index, match }] : [];
            })
            .sort(
              (a, b) =>
                Number(b.match.atWordStart) - Number(a.match.atWordStart) || a.index - b.index,
            )
            .map(({ choice }) => choice);
    return matching.slice(0, MAX_CHOICES_PER_KIND);
  });
}

/** A Question's Search scope as chips, Folders first, then Tags, then Documents, each in the order chosen. */
export function scopeChips(library: ScopeLibrary, scope: SearchScope): ScopeChip[] {
  const counts = scopeCounts(library);
  const folders = new Map(
    [...library.folders, ...(library.groups ?? [])].map((folder) => [folder.id, folder]),
  );
  const deletedFolders = new Map((library.deletedGroups ?? []).map((group) => [group.id, group]));
  const tags = new Map(library.tags.map((tag) => [tag.id, tag]));
  const documents = new Map(library.documents.map((document) => [document.id, document]));
  return [
    ...scope.folderIds.map((id): ScopeChip => {
      const live = folders.get(id);
      return {
        kind: "folder",
        id,
        name: live?.name ?? deletedFolders.get(id)?.name ?? null,
        path: folderPath(library.groups ?? [], id),
        deleted: !live,
        documentKind: null,
        ...(live && { count: counts.get(id) ?? 0 }),
      };
    }),
    ...scope.tagIds.map((id): ScopeChip => {
      const tag = tags.get(id);
      return {
        kind: "tag",
        id,
        name: tag?.name ?? null,
        path: [],
        deleted: !tag,
        documentKind: null,
        ...(tag && { count: counts.get(id) ?? 0 }),
      };
    }),
    ...scope.documentIds.map((id): ScopeChip => {
      const document = documents.get(id);
      return {
        kind: "document",
        id,
        name: document?.name ?? null,
        path: [],
        deleted: !document,
        documentKind: document?.kind ?? null,
      };
    }),
  ];
}

/** What the composer searches: its wall's Folder alone behind a wall (`useTurnWall`), else `otherwise`. */
export const scopeWithin = (wall: string | null, otherwise: SearchScope): SearchScope =>
  wall === null ? otherwise : folderScope(wall);
