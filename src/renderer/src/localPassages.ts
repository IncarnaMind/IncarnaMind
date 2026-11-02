import { useEffect, useState } from "react";
import type { PassageSearchPlace, PassageSearchResult, SearchScope } from "../../core/api";
import { useConversations } from "./conversations";
import { core } from "./core";
import { useAppStore } from "./store";

/** How many passages local search shows where a model can't answer yet (#763). */
const FOUND_PASSAGES = 4;

const NONE: Found = { passages: [], failed: false };

/** Where a Question waiting in the composer stands: the turn whose wall the core judges (#1934). */
export function useWaitingPlace(
  mindId: string | null,
  conversationId: string | null,
): PassageSearchPlace {
  return { kind: "turn", mindId, conversationId };
}

/** Where a Question already asked stands: its Note now, else the Folder recorded with it. */
export function useQuestionPlace(
  question: {
    askedFrom?: { mindId: string | null; deleted?: boolean } | null;
    folderAskedIn?: string;
  } | null,
): PassageSearchPlace {
  return {
    kind: "asked",
    askedFrom: question?.askedFrom ?? null,
    ...(question?.folderAskedIn !== undefined && { folderAskedIn: question.folderAskedIn }),
  };
}

/** A search on this computer for a Question: keyword only, so it works with no model and offline. */
export function searchLocally(
  text: string,
  scope: SearchScope | null,
  place: PassageSearchPlace,
): Promise<PassageSearchResult[]> {
  return core.searchPassages(text, { mode: "keyword", limit: FOUND_PASSAGES, scope, place });
}

interface Found {
  passages: PassageSearchResult[];
  /** The search couldn't run: nothing is said of what matched, rather than that nothing did. */
  failed: boolean;
}

/**
 * What a Question's own words find on this computer, while no model can answer it (#763): the
 * passages and the Documents they are from, as local search finds them, keeping to the Question's
 * side of the Folder walls as the core keeps an Answer (#1934). Never read by a model.
 */
export function useFoundPassages(
  text: string | null,
  scope: SearchScope | null,
  place: PassageSearchPlace,
): Found {
  const [found, setFound] = useState<Found>(NONE);
  // A Document, Folder, Tag or wall added, read, moved or changed changes what a search can find.
  // The state itself, by identity: no list is walked to notice a change.
  const documents = useAppStore((state) => state.documents);
  const library = useAppStore((state) => state.library);
  const tags = useAppStore((state) => state.tags);
  const folders = useAppStore((state) => state.folders);
  const minds = useAppStore((state) => state.minds);
  const conversations = useConversations((state) => state.list);
  // Small, and only a Question has one: its scope and its place, never the Documents it reads.
  const asked = text === null ? "" : JSON.stringify([scope ?? null, place]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` holds the words, the scope and the place; the Library's state says when to look again.
  useEffect(() => {
    if (text === null) return;
    let current = true;
    searchLocally(text, scope, place).then(
      (passages) => {
        if (current) setFound({ passages, failed: false });
      },
      (error: unknown) => {
        if (current) setFound({ passages: [], failed: true });
        console.warn("A search on this computer couldn't look through the Documents.", error);
      },
    );
    return () => {
      current = false;
    };
  }, [asked, documents, library, tags, folders, minds, conversations]);
  return text === null ? NONE : found;
}
