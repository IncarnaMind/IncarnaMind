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

type Held = Pick<DocumentGroupAssignment, "documentId" | "status" | "groupId" | "source" | "error">;

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
 * The failures a count, its causes and Try again agree on: only the Documents whose latest run
 * failed and whose place the User hasn't settled, so a manual place is never counted or retried.
 */
export function unsettledProblemsOf(
  documents: readonly Pick<Document, "id" | "tagging">[],
  assignments: readonly Held[],
): ReviewProblem[] {
  const held = new Map(assignments.map((item) => [item.documentId, item]));
  const unsettled = documents.filter((document) => {
    const state = organizeStateOf(document, held.get(document.id));
    return state.run === "failed" && !state.manual;
  });
  return reviewProblemsOf(unsettled, assignments);
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

/** Whether a cause can be named: it has words of its own and the service Organize sends to is known. */
export const namedProblem = (kind: ReviewProblemKind, service: string | null): boolean =>
  kind !== "other" && service !== null;

/** The one action a line offers: its cause's fix where it can be named, else Try again (#2308). */
export const problemAction = (kind: ReviewProblemKind, service: string | null): "fix" | "retry" =>
  namedProblem(kind, service) && PROBLEM_FIX[kind] !== undefined ? "fix" : "retry";

/** The cause in mid-sentence, for the Not in a Folder header and a Folder row's prefix (#2308). */
export const CAUSE_WORDS: Record<Exclude<ReviewProblemKind, "other">, MessageKey> = {
  credit: "library.cause.credit",
  keyRefused: "library.cause.keyRefused",
  planLimit: "library.cause.planLimit",
  rateLimit: "library.cause.rateLimit",
};

/** Whether Try again can help a cause: it has no fix of its own, so retrying is its action. */
export const retryableCause = (kind: ReviewProblemKind): boolean =>
  kind === "other" || kind === "rateLimit";

/** The Documents Try again may send: only those whose cause a retry can help (#2308). */
export function retryableIds(problems: readonly ReviewProblem[]): string[] {
  return problems.flatMap((problem) => (retryableCause(problem.kind) ? problem.documentIds : []));
}

/** The cause alone, for a Document's own row, whose place already says it is Organize's (#2308). */
export const ROW_PROBLEM_WORDS: Record<ReviewProblemKind, MessageKey> = {
  credit: "library.row.problem.credit",
  keyRefused: "library.row.problem.keyRefused",
  planLimit: "library.row.problem.planLimit",
  rateLimit: "library.row.problem.rateLimit",
  other: "library.row.problem.other",
};

/** A Document's own row's reason: the short cause it shows, and the whole sentence on hover. */
export interface ReviewReason {
  kind: ReviewProblemKind;
  /** The whole ruled sentence, for the row's tooltip and accessible name. */
  title: string;
}

/** The short cause and the whole sentence a Document's own row shows; `kind` is "other" when it can't name it. */
export function reviewReason(
  kind: ReviewProblemKind,
  service: string | null,
  t: Translate,
): ReviewReason {
  const named = namedProblem(kind, service);
  return {
    kind: named ? kind : "other",
    title: named ? problemLine(kind, 1, service, t) : t("library.row.problem.other.title"),
  };
}

/**
 * A Folder row's cause, prefixed because the place no longer says it is Organize's (#2308); a
 * cause it can't name keeps its own short word.
 */
export function folderProblemWords(kind: ReviewProblemKind, t: Translate): string {
  return kind === "other"
    ? t(ROW_PROBLEM_WORDS.other)
    : t("library.row.problem.folder", { cause: t(CAUSE_WORDS[kind]) });
}

/**
 * The Not in a Folder header's words (#2308): the count, and the cause when every failure shares
 * one the Library can name. The caller adds Try again only when `retryableCause` says so.
 */
export function notOrganizedLine(
  problems: readonly ReviewProblem[],
  count: number,
  t: Translate,
): string {
  const shared = problems.length === 1 ? problems[0] : undefined;
  if (shared !== undefined && shared.kind !== "other") {
    const cause = t(CAUSE_WORDS[shared.kind]);
    return t(
      count === 1
        ? "library.organize.notOrganized.cause.one"
        : "library.organize.notOrganized.cause",
      { count, cause },
    );
  }
  return t(count === 1 ? "library.organize.notOrganized.one" : "library.organize.notOrganized", {
    count,
  });
}
