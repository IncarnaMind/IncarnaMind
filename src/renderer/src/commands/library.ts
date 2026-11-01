import { looseDocumentIds, organizeDocuments } from "../organizeDocuments";
import { useAppStore } from "../store";
import { hasNotSorted, waitingIds } from "../suggestionReview";
import type { Command } from "./registry";

export const libraryCommands: readonly Command[] = [
  {
    id: "library.open",
    label: "library.open",
    keywords: ["library.open.keywords"],
    group: "open",
    top: 40,
    reversible: true,
    run: () => useAppStore.getState().openLibrary(),
  },
  {
    id: "library.review",
    label: "library.review.open",
    keywords: ["library.review.open.keywords"],
    group: "open",
    when: () => waitingIds().length > 0 || hasNotSorted(),
    reversible: true,
    run: () => useAppStore.getState().openLibrary("review"),
  },
  {
    id: "library.organize",
    label: "library.organize",
    keywords: ["library.organize.keywords"],
    group: "main",
    when: () => looseDocumentIds(useAppStore.getState()).length > 0,
    // Its suggestions wait in To review, and its Undo takes them back with the Folders it made.
    reversible: true,
    async run() {
      useAppStore.getState().openLibrary();
      await organizeDocuments(looseDocumentIds(useAppStore.getState()));
    },
  },
];
