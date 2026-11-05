import { attentionIds } from "../attention";
import { looseDocumentIds, organizeDocuments } from "../organizeDocuments";
import { fixOrganizeProblem } from "../organizeFix";
import { organizeFailedIds } from "../organizeOutcome";
import { type ReviewProblemKind, reviewProblemsOf } from "../reviewProblems";
import { allExamples, isOwnDocument, useAppStore } from "../store";
import { hasNotSorted, waitingIds } from "../suggestionReview";
import type { Command } from "./registry";

/** The User's own Documents, as the Library counts them (#2308). */
const ownNow = () => {
  const state = useAppStore.getState();
  return state.documents.filter((document) => isOwnDocument(document, allExamples(state)));
};

const problemsNow = () => {
  const state = useAppStore.getState();
  return reviewProblemsOf(ownNow(), state.library?.assignments ?? []);
};

const failedNow = () => {
  const state = useAppStore.getState();
  return organizeFailedIds(ownNow(), state.library?.assignments ?? []);
};

/** The Documents behind a cause, for the one action that fixes it (#2535). */
const documentsOfCause = (kind: ReviewProblemKind): readonly string[] =>
  problemsNow().find((problem) => problem.kind === kind)?.documentIds ?? [];

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
    when: () => failedNow().size > 0,
    reversible: true,
    run: () => {
      void organizeDocuments([...failedNow()]).catch(useAppStore.getState().reportError);
    },
  },
  {
    id: "library.addCredit",
    label: "answer.error.addCredit",
    keywords: ["library.addCredit.keywords"],
    group: "main",
    when: () => documentsOfCause("credit").length > 0,
    reversible: true,
    run: () => void fixOrganizeProblem("credit", documentsOfCause("credit")),
  },
  {
    id: "library.checkKey",
    label: "answer.error.checkKey",
    keywords: ["library.checkKey.keywords"],
    group: "main",
    when: () => documentsOfCause("keyRefused").length > 0,
    reversible: true,
    run: () => void fixOrganizeProblem("keyRefused", documentsOfCause("keyRefused")),
  },
  {
    id: "library.chooseModel",
    label: "answer.error.chooseModel",
    keywords: ["library.chooseModel.keywords"],
    group: "main",
    when: () => documentsOfCause("planLimit").length > 0,
    reversible: true,
    run: () => void fixOrganizeProblem("planLimit", documentsOfCause("planLimit")),
  },
];
