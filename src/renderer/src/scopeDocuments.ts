import { useEffect, useState } from "react";
import type { SearchScope } from "../../core/api";
import type { MessageKey } from "../../shared/i18n";
import { type ScopeKind, scopeName } from "../../shared/searchScope";
import { core } from "./core";
import { useT } from "./i18n";
import { DELETED_NAMES, type ScopeLibrary, scopeCounts } from "./scope";
import { type AppState, useAppStore } from "./store";

const libraryOf = (state: AppState): ScopeLibrary => ({
  folders: state.folders,
  groups: state.library?.groups,
  tags: state.tags,
  documents: state.documents,
  assignments: state.library?.assignments,
});

export const useFolderHoldsDocuments = (folderId: string | null): boolean =>
  useAppStore(
    (state) => folderId !== null && (scopeCounts(libraryOf(state)).get(folderId) ?? 0) > 0,
  );

/** As `useFolderHoldsDocuments`, read now: a Question asked outside React searches the same. */
export const folderHoldsDocumentsNow = (folderId: string | null): boolean =>
  folderId !== null && (scopeCounts(libraryOf(useAppStore.getState())).get(folderId) ?? 0) > 0;

/**
 * Whether a Search scope holds no Document that can be searched now (#748):
 * false for none (every Document), and until the core has answered. Asked
 * again when Documents come or change.
 */
export function useScopeEmpty(scope: SearchScope | null): boolean {
  const [empty, setEmpty] = useState(false);
  const wanted = scope ? JSON.stringify(scope) : null;
  const state = useAppStore((store) =>
    [
      ...store.documents.map((each) => `${each.id}:${each.status}:${each.fileStatus}`),
      // A Folder or Tag deleted, or a Document moved into one, changes what the scope holds.
      ...store.folders.map((each) => each.id),
      ...(store.library?.groups ?? []).map((each) => each.id),
      ...store.tags.map((each) => each.id),
      ...store.documents.map((each) => `${each.id}:${each.tags.length}:${each.folderId}`),
    ].join("|"),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` is when to ask again.
  useEffect(() => {
    if (wanted === null) {
      setEmpty(false);
      return;
    }
    let current = true;
    core
      .countScopeDocuments(JSON.parse(wanted) as SearchScope)
      .then((count) => {
        if (current) setEmpty(count === 0);
      })
      .catch(() => {
        if (current) setEmpty(false);
      });
    return () => {
      current = false;
    };
  }, [wanted, state]);
  return empty;
}

/**
 * A Search scope as a check's card names it: its first Folder, Tag or Document as named now
 * (`deleted` since: its kind's deleted name), and how many more it names; null for every Document.
 */
export function useScopeName(
  scope: SearchScope | null,
): { name: string; more: number; kind: ScopeKind; deleted: boolean } | null {
  const t = useT();
  const folders = useAppStore((state) => state.folders);
  const groups = useAppStore((state) => state.library?.groups);
  const deletedGroups = useAppStore((state) => state.library?.deletedGroups);
  const tags = useAppStore((state) => state.tags);
  const documents = useAppStore((state) => state.documents);
  if (!scope) return null;
  const named = scopeName(scope, (kind, id) => {
    const found =
      kind === "folder"
        ? [...folders, ...(groups ?? []), ...(deletedGroups ?? [])].find((each) => each.id === id)
        : kind === "tag"
          ? tags.find((each) => each.id === id)
          : documents.find((each) => each.id === id);
    return found?.name ?? null;
  });
  return (
    named && {
      name: named.name ?? t(DELETED_NAMES[named.kind]),
      more: named.more,
      kind: named.kind,
      deleted: named.name === null,
    }
  );
}

const GONE: Record<ScopeKind, MessageKey> = {
  folder: "checks.problem.scope.gone.folder",
  tag: "checks.problem.scope.gone.tag",
  document: "checks.problem.scope.gone.document",
};

/**
 * Why a check found nothing to check against in the Search scope the User set for the Mind:
 * the one item it names was deleted, it holds no Documents, or only the file the Mind was made from.
 */
export function useEmptyScopeLine(
  chosen: { scope: SearchScope; onlyLeftOut: boolean } | null,
): string | null {
  const t = useT();
  const named = useScopeName(chosen?.scope ?? null);
  if (!chosen || !named) return null;
  if (named.deleted && named.more === 0) return t(GONE[named.kind]);
  const why = chosen.onlyLeftOut ? "ownFile" : "empty";
  return named.more > 0
    ? t(`checks.problem.scope.${why}.more`, {
        scope: named.name,
        count: named.more,
        total: named.more + 1,
      })
    : t(`checks.problem.scope.${why}`, { scope: named.name });
}
