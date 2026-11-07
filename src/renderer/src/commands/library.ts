import { attentionIds } from "../attention";
import { looseDocumentIds, organizeDocuments } from "../organizeDocuments";
import { confirmReview, openReview, useOrganizeReview } from "../organizeReview";
import { documentsOfCause, fixOrganizeProblem } from "../organizeFix";
import { retryableIds, unsettledProblemsOf } from "../reviewProblems";
import { allExamples, isOwnDocument, useAppStore } from "../store";
import type { Command } from "./registry";

/** How many Documents wait in Suggestions to be confirmed. */
const waitingCount = () =>
  useOrganizeReview.getState().count ?? useAppStore.getState().library?.reviewCount ?? 0;

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
    when: () => waitingCount() > 0,
    reversible: true,
    // Nothing moves from the chat: the assistant's Organize replies with its own Review (#1569).
    assistant: false,
    run: openReview,
  },
  {
    id: "library.confirmSuggestions",
    label: "organizeReview.confirmCommand",
    keywords: ["organizeReview.confirmCommand.keywords"],
    group: "main",
    when: () => useOrganizeReview.getState().open,
    reversible: true,
    assistant: false,
    run: () => confirmReview(),
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
    // What it proposes waits in the Review, where nothing moves before Confirm (#1569).
    reversible: true,
    // The assistant's Organize is documents.organize, which replies with its Review (#2252).
    assistant: false,
    async run() {
      useAppStore.getState().openLibrary();
      await organizeDocuments(null);
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
