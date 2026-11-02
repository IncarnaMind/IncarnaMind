import { useEffect, useState } from "react";
import type { PassageSearchResult, SearchScope } from "../../core/api";
import { hasSearchScope, holdsText } from "../../shared/searchScope";
import { core } from "./core";
import { scopeDocumentIds } from "./scope";
import { type AppState, allExamples, isOwnDocument, useAppStore } from "./store";
import { useTurnWall } from "./turnWall";

/** How many passages local search shows where a model can't answer yet (#763). */
const FOUND_PASSAGES = 4;

/**
 * Where a Question is asked: the Folder whose wall decides what a search on this computer reads
 * (#1934). `known` false is a Question whose Folder wasn't recorded: neither side of a wall is
 * known, so nothing is read, as the core reads such a turn.
 */
export interface LocalPlace {
  folderId: string | null;
  /** Whether the Question has a Note: a scope naming one walled Folder reads inside it only with none. */
  mind: boolean;
  known: boolean;
}

/** The place of a Question waiting in the composer: the wall the core says its turn is on. */
export function useWaitingPlace(mindId: string | null, conversationId: string | null): LocalPlace {
  const wall = useTurnWall({ mindId, conversationId });
  return { folderId: wall ?? null, mind: mindId !== null, known: wall !== undefined };
}

/** The place of a Question already asked: its Note's Folder now, else the Folder recorded with it. */
export function useQuestionPlace(question: {
  askedFrom?: { mindId: string | null } | null;
  folderAskedIn?: string;
}): LocalPlace {
  const mindId = question.askedFrom?.mindId ?? null;
  const folderId = useAppStore((state) =>
    mindId === null ? undefined : state.minds.find((each) => each.id === mindId)?.folderId,
  );
  if (folderId !== undefined) return { folderId, mind: true, known: true };
  if (question.folderAskedIn === undefined) return { folderId: null, mind: false, known: false };
  return {
    folderId: question.folderAskedIn === "" ? null : question.folderAskedIn,
    mind: false,
    known: true,
  };
}

/** The Documents with text to search. */
const searchable = (state: AppState) => state.documents.filter(holdsText);

/**
 * The Documents a search on this computer reads with no Search scope: the User's own once they
 * have one, else every Document, which on day one is the example's (#1942). Undefined reads all.
 */
function defaultDocumentIds(): string[] | undefined {
  const state = useAppStore.getState();
  const examples = allExamples(state);
  const own = searchable(state).filter((document) => isOwnDocument(document, examples));
  return own.length > 0 ? own.map((document) => document.id) : undefined;
}

/**
 * The Documents a local search reads for a Question: its Search scope's, or the default ones,
 * kept to its side of the Folder walls as the core keeps an Answer (#1934). Inside a walled
 * Folder it reads only what the User filed there (never Organize's suggestions); outside every
 * wall it never reads one a wall keeps inside. One difference from the core remains: a file
 * IncarnaMind wrote from inside a wall and saved outside it carries no Folder on this page
 * (#2442).
 */
export function localSearchIds(scope: SearchScope | null, place: LocalPlace): string[] | undefined {
  if (!place.known) return [];
  const state = useAppStore.getState();
  const groups = state.library?.groups ?? [];
  const assignments = state.library?.assignments ?? [];
  const walls = new Set(groups.filter((group) => group.keepInside).map((group) => group.id));
  const behind = (wallId: string) =>
    assignments.filter((each) => each.groupId === wallId).map((each) => each.documentId);
  // Inside a wall the core reads the Documents the User filed there, not Organize's suggestions.
  const behindUser = (wallId: string) =>
    assignments
      .filter((each) => each.groupId === wallId && each.source === "user")
      .map((each) => each.documentId);
  const inside = place.folderId !== null && walls.has(place.folderId) ? place.folderId : null;
  // Asked with no Note, a scope naming one walled Folder alone reads inside that wall.
  const explicit =
    !place.mind &&
    scope !== null &&
    scope.folderIds.length === 1 &&
    walls.has(scope.folderIds[0] ?? "") &&
    scope.tagIds.length + scope.documentIds.length === 0
      ? (scope.folderIds[0] ?? null)
      : null;
  const wallId = inside ?? explicit;
  if (wallId !== null) {
    const held = new Set(behindUser(wallId));
    return searchable(state)
      .filter((document) => held.has(document.id))
      .map((document) => document.id);
  }
  const ids =
    scope && hasSearchScope(scope)
      ? scopeDocumentIds(
          {
            folders: state.folders,
            groups: state.library?.groups,
            tags: state.tags,
            documents: state.documents,
            assignments: state.library?.assignments,
          },
          scope,
        )
      : defaultDocumentIds();
  if (walls.size === 0) return ids;
  const hidden = new Set([...walls].flatMap(behind));
  return (ids ?? searchable(state).map((document) => document.id)).filter((id) => !hidden.has(id));
}

/** A search on this computer for a Question: keyword only, so it works with no model and offline. */
export function searchLocally(
  text: string,
  scope: SearchScope | null,
  place: LocalPlace,
): Promise<PassageSearchResult[]> {
  const documentIds = localSearchIds(scope, place);
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
  place: LocalPlace,
): PassageSearchResult[] {
  const [found, setFound] = useState<PassageSearchResult[]>([]);
  // A Document, Folder or Tag added, read, moved or walled changes what a local search can find.
  const library = useAppStore((state) =>
    [
      ...state.documents.map(
        (each) =>
          `${each.id}:${each.name}:${each.status}:${each.fileStatus}:${each.folderId}:${each.tags
            .map((tag) => tag.tagId)
            .join(",")}`,
      ),
      ...(state.library?.groups ?? []).map((each) => `${each.id}:${each.keepInside}`),
      ...(state.library?.assignments ?? []).map(
        (each) => `${each.documentId}:${each.groupId ?? ""}`,
      ),
    ].join("|"),
  );
  const wanted =
    text === null
      ? ""
      : `${text}\u0000${JSON.stringify(scope ?? null)}\u0000${place.folderId ?? ""}\u0000${
          place.mind ? 1 : 0
        }\u0000${place.known ? 1 : 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` is the words, the scope and the place; `library` is when to look again.
  useEffect(() => {
    if (wanted === "") {
      setFound([]);
      return;
    }
    let current = true;
    searchLocally(text ?? "", scope, place).then(
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
