import { useMemo } from "react";
import type { Document, LinkedFolder } from "../../core/api";
import { useFirstOpen } from "./firstOpen";
import { type AppState, allExamples, isOwnDocument, useAppStore } from "./store";

/** How many of the User's own Documents stay one flat list before the Library row comes (#1942). */
export const DAY_ONE_DOCUMENTS = 8;

const NO_GROUPS: readonly { id: string }[] = [];

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

/** The User's own Linked folders: the examples' left out. */
export function useOwnLinkedFolders(): readonly LinkedFolder[] {
  const linkedFolders = useAppStore((state) => state.linkedFolders);
  const examples = useAppStore((state) => state.examples);
  const otherExamples = useAppStore((state) => state.otherExamples);
  return useMemo(() => {
    const made = allExamples({ examples, otherExamples }).flatMap((each) =>
      each.linkedFolderId === null ? [] : [each.linkedFolderId],
    );
    return linkedFolders.filter((linked) => !made.includes(linked.id));
  }, [linkedFolders, examples, otherExamples]);
}

/**
 * Whether a Document of the User's own carries a Tag. Before one does, nothing
 * names Tags: not the sidebar's section, and not the footer's asking for a
 * model (#1942). The examples' own Tags are not the User's.
 */
export const ownsATag = (state: Pick<AppState, "documents" | "examples" | "otherExamples">) =>
  state.documents.some((each) => each.tags.length > 0 && isOwnDocument(each, allExamples(state)));

/**
 * Day one: the first open's steps still show, and the User has a few
 * Documents of their own and no Folder of their own. The sidebar then shows one
 * flat list called Documents, and the Library and Folders stay out of the way
 * until one of them helps (#1942). A User who has put the steps away gets the
 * sidebar as it was.
 */
export function useDayOne(): boolean {
  const firstOpen = useFirstOpen();
  const own = useOwnDocuments();
  const groups = useAppStore((state) => state.library)?.groups ?? NO_GROUPS;
  return firstOpen && own.length <= DAY_ONE_DOCUMENTS && groups.length === 0;
}
