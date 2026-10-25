import { useAppStore } from "../store";
import { waitingIds } from "../suggestionReview";
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
    when: () => waitingIds().length > 0,
    reversible: true,
    run: () => useAppStore.getState().openLibrary("review"),
  },
];
