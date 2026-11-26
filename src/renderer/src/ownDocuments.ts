import { useMemo } from "react";
import type { Document } from "../../core/api";
import { useCanvases } from "./canvases";
import { useFirstOpen } from "./firstOpen";
import { isListedDocument } from "./meetingTranscript";
import {
  type AppState,
  allExamples,
  exampleMindIds,
  isExampleDocument,
  isOwnDocument,
  useAppStore,
} from "./store";

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

/** The Documents with rows of their own of every example, or of the first run's alone. */
export function useExampleDocuments({ firstOnly = false } = {}): readonly Document[] {
  const documents = useAppStore((state) => state.documents);
  const examples = useAppStore((state) => state.examples);
  const otherExamples = useAppStore((state) => state.otherExamples);
  return useMemo(() => {
    const made = allExamples({ examples, otherExamples: firstOnly ? [] : otherExamples });
    return documents.filter((each) => isListedDocument(each) && isExampleDocument(each, made));
  }, [documents, examples, otherExamples, firstOnly]);
}

/** Whether a Document, by id, belongs to an example. */
export function useIsExampleDocument(): (documentId: string) => boolean {
  const documents = useAppStore((state) => state.documents);
  const examples = useAppStore((state) => state.examples);
  const otherExamples = useAppStore((state) => state.otherExamples);
  return useMemo(() => {
    const made = allExamples({ examples, otherExamples });
    const ids = new Set(
      documents.filter((each) => isExampleDocument(each, made)).map((each) => each.id),
    );
    return (documentId) => ids.has(documentId);
  }, [documents, examples, otherExamples]);
}

/**
 * The Documents the Library page lists: the User's own, once they have one;
 * until then the examples', so a Library opened on a first run is not empty
 * (#1942).
 */
export function useLibraryDocuments(): readonly Document[] {
  const own = useOwnDocuments();
  const all = useListedDocuments();
  return own.length > 0 ? own : all;
}

/** Every Document with a row of its own: a Meeting's Transcript is its Note's (#2528). */
export function useListedDocuments(): readonly Document[] {
  const documents = useAppStore((state) => state.documents);
  return useMemo(() => documents.filter(isListedDocument), [documents]);
}

/**
 * Whether a Document of the User's own carries a Tag. Before one does, nothing
 * names Tags: not the sidebar's section, and not the footer's asking for a
 * model (#1942). The examples' own Tags are not the User's.
 */
export const ownsATag = (state: Pick<AppState, "documents" | "examples" | "otherExamples">) =>
  state.documents.some((each) => each.tags.length > 0 && isOwnDocument(each, allExamples(state)));

/**
 * Whether the workspace holds only examples so far: no Documents, Notes, Folders or Canvases of
 * the User's own, and at least one example Mind or Document. Asking in an example ends the quiet
 * first open without rearranging the sidebar into Library and Documents (#3819).
 */
export function useOnlyExamples(): boolean {
  const hasOwnDocuments = useAppStore((state) =>
    state.documents.some((each) => isOwnDocument(each, allExamples(state))),
  );
  const hasOwnNote = useAppStore((state) => {
    const examples = new Set(exampleMindIds(state));
    return state.minds.some((mind) => !examples.has(mind.id));
  });
  const hasOwnFolders = useAppStore((state) => (state.library?.groups.length ?? 0) > 0);
  const hasExample = useAppStore((state) => {
    const made = allExamples(state);
    const hasMind = made.some(
      (each) => each.mindId !== null && state.minds.some((mind) => mind.id === each.mindId),
    );
    return hasMind || state.documents.some((each) => isExampleDocument(each, made));
  });
  const hasCanvases = useCanvases((state) => state.canvases.length > 0);
  return !hasOwnDocuments && !hasOwnNote && !hasOwnFolders && !hasCanvases && hasExample;
}

/**
 * Whether the sidebar names the Library. It waits while the workspace holds only examples or the
 * first open's steps show and the User has nothing of their own; once they have a Document or a
 * Note, it is there, where Recently deleted and every file are (#2376, #3819).
 */
export function useLibraryShown(): boolean {
  const firstOpen = useFirstOpen();
  const onlyExamples = useOnlyExamples();
  const documents = useOwnDocuments();
  const hasOwnNote = useAppStore((state) => {
    const examples = new Set(exampleMindIds(state));
    return state.minds.some((mind) => !examples.has(mind.id));
  });
  return documents.length > 0 || hasOwnNote || (!firstOpen && !onlyExamples);
}
