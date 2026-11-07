import { attentionIds } from "../attention";
import { looseDocumentIds, organizeDocuments } from "../organizeDocuments";
import { documentsOfCause, fixOrganizeProblem } from "../organizeFix";
import { retryableIds, unsettledProblemsOf } from "../reviewProblems";
import { allExamples, isOwnDocument, useAppStore } from "../store";
import { hasNotSorted, waitingIds } from "../suggestionReview";
import type { Command } from "./registry";

/** The User's own Documents, as the Library counts them (#2308). */
const ownNow = () => {
  const state = useAppStore.getState();
  return state.documents.filter((document) => isOwnDocument(document, allExamples(state)));
};

/** The failed Documents Try again can help now: another cause needs its own fix first (#2308). */
const retryableNow = () =>
  retryableIds(unsettledProblemsOf(ownNow(), useAppStore.getState().library?.assignments ?? []));

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
    id: "library.reviewNext",
    label: "library.review.next",
    keywords: ["library.review.next.keywords"],
    group: "open",
    when: () => {
      const state = useAppStore.getState();
      return attentionIds(ownNow(), state.library?.assignments ?? []).some(
        (id) => !state.reviewedAttention.has(id),
      );
    },
    reversible: true,
    run: () => useAppStore.getState().reviewAttention(),
  },
  {
    id: "library.organize",
    label: "library.organize",
    keywords: ["library.organize.keywords"],
    group: "main",
    when: () => looseDocumentIds(useAppStore.getState()).length > 0,
    // Its suggestions wait in To review, and its Undo takes them back with the Folders it made.
    reversible: true,
    // The assistant's Organize is documents.organize, which files them at once with one Undo (#2252).
    assistant: false,
    async run() {
      useAppStore.getState().openLibrary();
      await organizeDocuments(looseDocumentIds(useAppStore.getState()));
    },
  },
  {
    id: "library.retryFailed",
    label: "library.retryFailed",
    keywords: ["library.retryFailed.keywords"],
    group: "main",
    when: () => retryableNow().length > 0,
    reversible: true,
    run: () => {
      const ids = retryableNow();
      if (ids.length === 0) return;
      void organizeDocuments([...ids]).catch(useAppStore.getState().reportError);
    },
  },
  {
    id: "library.addCredit",
    label: "library.addCredit",
    keywords: ["library.addCredit.keywords"],
    group: "main",
    assistant: { never: "keys" },
    when: () => documentsOfCause("credit").length > 0,
    reversible: true,
    run: () => void fixOrganizeProblem("credit"),
  },
  {
    id: "library.checkKey",
    label: "answer.error.checkKey",
    keywords: ["library.checkKey.keywords"],
    group: "main",
    assistant: { never: "keys" },
    when: () => documentsOfCause("keyRefused").length > 0,
    reversible: true,
    run: () => void fixOrganizeProblem("keyRefused"),
  },
  {
    id: "library.chooseModel",
    label: "answer.error.chooseModel",
    keywords: ["library.chooseModel.keywords"],
    group: "main",
    assistant: { never: "keys" },
    when: () => documentsOfCause("planLimit").length > 0,
    reversible: true,
    run: () => void fixOrganizeProblem("planLimit"),
  },
];
