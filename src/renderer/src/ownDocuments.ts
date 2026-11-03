import { useMemo } from "react";
import type { Document } from "../../core/api";
import { useFirstOpen } from "./firstOpen";
import { type AppState, allExamples, exampleMindIds, isOwnDocument, useAppStore } from "./store";

/** How many of the User's own loose Documents there may be before a Folder is offered (#1942). */
export const DAY_ONE_DOCUMENTS = 8;

/** The User's own Documents: the examples' left out. */
export function useOwnDocuments(): readonly Document[] {
  const documents = useAppStore((state) => state.documents);
  const examples = useAppStore((state) => state.examples);
  const otherExamples = useAppStore((state) => state.otherExamples);
  return useMemo(
    () => documents.filter((each) => isOwnDocument(each, allExamples({ examples, otherExamples }))),
    [documents, examples, otherExamples],
  );
}

/**
 * The Documents the Library page lists: the User's own, once they have one;
 * until then the examples', so a Library opened on a first run is not empty
 * (#1942).
 */
export function useLibraryDocuments(): readonly Document[] {
  const own = useOwnDocuments();
  const all = useAppStore((state) => state.documents);
  return own.length > 0 ? own : all;
}

/**
 * Whether a Document of the User's own carries a Tag. Before one does, nothing
 * names Tags: not the sidebar's section, and not the footer's asking for a
 * model (#1942). The examples' own Tags are not the User's.
 */
export const ownsATag = (state: Pick<AppState, "documents" | "examples" | "otherExamples">) =>
  state.documents.some((each) => each.tags.length > 0 && isOwnDocument(each, allExamples(state)));

/**
 * Whether the sidebar names the Library. It waits while the first open's steps show and the User
 * has nothing of their own; once they have a Document or a Note, it is there, where Recently
 * deleted and every file are (#2376).
 */
export function useLibraryShown(): boolean {
  const firstOpen = useFirstOpen();
  const documents = useOwnDocuments();
  const hasOwnNote = useAppStore((state) => {
    const examples = new Set(exampleMindIds(state));
    return state.minds.some((mind) => !examples.has(mind.id));
  });
  return !firstOpen || documents.length > 0 || hasOwnNote;
}
