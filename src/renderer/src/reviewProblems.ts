/**
 * The Organize failures To review says in the Library's own words (#2308): the
 * Documents that met one cause, and that cause's one action, in one line for
 * the group instead of the provider's sentence in every row. Pure, so the tests
 * import it.
 */

import type { Document, DocumentGroupAssignment, ProviderErrorKind } from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { organizeStateOf } from "./organizeOutcome";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** What a group of failed Documents ran into, in the Library's words; `other` is one it can't name. */
export type ReviewProblemKind = "credit" | "keyRefused" | "planLimit" | "rateLimit" | "other";

const KINDS: readonly ReviewProblemKind[] = [
  "credit",
  "keyRefused",
  "planLimit",
  "rateLimit",
  "other",
];

const KIND_OF: Partial<Record<ProviderErrorKind, ReviewProblemKind>> = {
  "out-of-credit": "credit",
  auth: "keyRefused",
  "api-key-unreadable": "keyRefused",
  "plan-limit": "planLimit",
  "rate-limit": "rateLimit",
};

/** The kind the Library says in its own words; one it has no words for is `other`. */
export const reviewProblemKind = (kind: ProviderErrorKind): ReviewProblemKind =>
  KIND_OF[kind] ?? "other";

export const PROBLEM_WORDS: Record<Exclude<ReviewProblemKind, "other">, MessageKey> = {
  credit: "library.organize.problem.credit",
  keyRefused: "library.organize.problem.keyRefused",
  planLimit: "library.organize.problem.planLimit",
  rateLimit: "library.organize.problem.rateLimit",
};

/** The one action that fits the kind, where it has one. Try again follows it. */
export const PROBLEM_FIX: Partial<Record<ReviewProblemKind, MessageKey>> = {
  credit: "answer.error.addCredit",
  keyRefused: "answer.error.checkKey",
  planLimit: "answer.error.chooseModel",
};

export interface ReviewProblem {
  kind: ReviewProblemKind;
  /** The Documents whose latest run failed this way, in the order given. */
  documentIds: string[];
}

type Held = Pick<
  DocumentGroupAssignment,
  "documentId" | "status" | "groupId" | "source" | "suggested" | "error"
>;

/** The failures in these Documents, one entry per cause, in the order the Library names them. */
export function reviewProblemsOf(
  documents: readonly Pick<Document, "id" | "tagging">[],
  assignments: readonly Held[],
): ReviewProblem[] {
  const held = new Map(assignments.map((item) => [item.documentId, item]));
  const groups = new Map<ReviewProblemKind, string[]>();
  for (const document of documents) {
    const item = held.get(document.id);
    if (organizeStateOf(document, item).run !== "failed") continue;
    const kind = item?.error ? reviewProblemKind(item.error.kind) : "other";
    const list = groups.get(kind);
    if (list) list.push(document.id);
    else groups.set(kind, [document.id]);
  }
  return KINDS.flatMap((kind) => {
    const documentIds = groups.get(kind);
    return documentIds ? [{ kind, documentIds }] : [];
  });
}

/**
 * One group's line: the cause with the service it went to, or Organize's own
 * count when it can name neither. Never the provider's own sentence.
 */
export function problemLine(
  kind: ReviewProblemKind,
  count: number,
  service: string | null,
  t: Translate,
): string {
  if (kind === "other" || service === null) {
    return t(count === 1 ? "library.organize.failed.one" : "library.organize.failed", { count });
  }
  return t(PROBLEM_WORDS[kind], { service });
}
