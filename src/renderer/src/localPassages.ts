import { useEffect, useState } from "react";
import type { PassageSearchResult, SearchScope } from "../../core/api";
import { hasSearchScope, holdsText } from "../../shared/searchScope";
import { core } from "./core";
import { scopeDocumentIds } from "./scope";
import { allExamples, isOwnDocument, useAppStore } from "./store";

/** How many passages local search shows where a model can't answer yet (#763). */
const FOUND_PASSAGES = 4;

/**
 * The Documents a search on this computer reads with no Search scope: the User's own once they
 * have one, else every Document, which on day one is the example's (#1942). Undefined reads all.
 */
function defaultDocumentIds(): string[] | undefined {
  const state = useAppStore.getState();
  const examples = allExamples(state);
  const own = state.documents.filter(
    (document) => holdsText(document) && isOwnDocument(document, examples),
  );
  return own.length > 0 ? own.map((document) => document.id) : undefined;
}

/** The Documents a Question's local search reads: its Search scope's, or the default ones. */
export function localSearchIds(scope: SearchScope | null): string[] | undefined {
  // A Question asked with nothing chosen carries an empty scope, as the core reads it: every Document.
  if (!scope || !hasSearchScope(scope)) return defaultDocumentIds();
  const state = useAppStore.getState();
  return scopeDocumentIds(
    {
      folders: state.folders,
      groups: state.library?.groups,
      tags: state.tags,
      documents: state.documents,
      assignments: state.library?.assignments,
    },
    scope,
  );
}

/** A search on this computer for a Question: keyword only, so it works with no model and offline. */
export function searchLocally(
  text: string,
  scope: SearchScope | null,
): Promise<PassageSearchResult[]> {
  const documentIds = localSearchIds(scope);
  return core.searchPassages(text, {
    mode: "keyword",
    limit: FOUND_PASSAGES,
    ...(documentIds && { documentIds }),
  });
}

/**
 * What a Question's own words find on this computer, while no model can answer it (#763): the
 * passages and the Documents they are from, as local search finds them, never read by a model.
 */
export function useFoundPassages(
  text: string | null,
  scope: SearchScope | null,
): PassageSearchResult[] {
  const [found, setFound] = useState<PassageSearchResult[]>([]);
  // A Document added, read or moved changes what a local search can find.
  const library = useAppStore((state) =>
    state.documents
      .map(
        (each) =>
          `${each.id}:${each.name}:${each.status}:${each.fileStatus}:${each.folderId}:${each.tags
            .map((tag) => tag.tagId)
            .join(",")}`,
      )
      .join("|"),
  );
  const wanted = text === null ? "" : `${text}\u0000${JSON.stringify(scope ?? null)}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` is the words and the scope; `library` is when to look again.
  useEffect(() => {
    if (wanted === "") {
      setFound([]);
      return;
    }
    let current = true;
    searchLocally(text ?? "", scope).then(
      (passages) => {
        if (current) setFound(passages);
      },
      (error: unknown) => {
        if (current) setFound([]);
        console.warn("A search on this computer couldn't look through the Documents.", error);
      },
    );
    return () => {
      current = false;
    };
  }, [wanted, library]);
  return wanted === "" ? [] : found;
}
