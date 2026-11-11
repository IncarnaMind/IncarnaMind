/**
 * What the judge said about each sentence the checks evaluation checked (#2910): every reply the
 * model gave, with the Tool calls it made, kept beside the outcome so a control that fails can be
 * read; and, from them, why a sentence came back "no evidence". The core says only that it did.
 * A calculation that wasn't made is told from a quote that wasn't found by what the replies and
 * the app's answers to the model's records show.
 */
import { readVerdict } from "../../../src/core/answers/checks/prompt";
import { asksForFixes } from "../../../src/core/answers/citations";
import { DOCUMENT_TOOLS } from "../../../src/core/tools";
import type { WatchedRequest } from "../../repeats/requests";

export interface JudgeCall {
  tool: string;
  input: string;
  result: string | null;
}

/** One request a check made to the model, in the order made. */
export interface JudgeRequest {
  /** What it is for: "check" is the Run, "restate" the explanation asked for again in the interface's language. */
  kind: string;
  /** The part of the sentence it checks; null for the whole sentence. */
  part: string | null;
  /** The check sent the Run back to calculate before it gave its verdict. */
  calculateAsked: boolean;
  reply: string;
  calls: JudgeCall[];
}

export function judgeRecord(requests: readonly WatchedRequest[]): JudgeRequest[] {
  return requests.map(({ kind, part, calculateAsked, reply, calls }) => ({
    kind,
    part,
    calculateAsked,
    reply,
    calls: calls.map(({ tool, input, result }) => ({ tool, input, result })),
  }));
}

export const NOT_CHECKED_CAUSES = [
  "quote-not-found",
  "calculation-not-made",
  "malformed",
  "other",
] as const;

/**
 * Why a sentence wasn't checked. "malformed": the reply held no verdict that could be read.
 * "quote-not-found" and "calculation-not-made" are what the core calls "no-evidence": a quote the
 * Citation check didn't find, or no usable calculation where the sentence needed one.
 * "other" is every other reason the core gives: a refusal, a failed request, a limit.
 */
export type NotCheckedCause = (typeof NOT_CHECKED_CAUSES)[number];

const callsOf = (judge: readonly JudgeRequest[], tool: string) =>
  judge.flatMap((request) => request.calls).filter((call) => call.tool === tool);

function quoteTurnedAway(judge: readonly JudgeRequest[]): boolean {
  const last = callsOf(judge, DOCUMENT_TOOLS.cite).at(-1);
  return last?.result != null && asksForFixes(last.result);
}

function calculationOwed(judge: readonly JudgeRequest[]): boolean {
  if (callsOf(judge, DOCUMENT_TOOLS.calculate).length > 0) return true;
  if (judge.some((request) => request.calculateAsked)) return true;
  const verdict = judge.findLast(
    (request) => request.kind === "check" && request.reply.trim() !== "",
  );
  return (readVerdict(verdict?.reply ?? "")?.calculations?.length ?? 0) > 0;
}

/**
 * The cause of a Not checked, from the core's reason (`ClaimCheckFailure`) and the replies kept for
 * it. The check turns a quote away before it asks for a calculation, so a quote the app didn't find
 * is the cause first; with none, a sentence that was to be calculated is "calculation-not-made".
 */
export function causeOf(
  code: string | undefined,
  judge: readonly JudgeRequest[] | undefined,
): NotCheckedCause {
  if (code === "malformed") return "malformed";
  if (code !== "no-evidence") return "other";
  const replies = judge ?? [];
  return !quoteTurnedAway(replies) && calculationOwed(replies)
    ? "calculation-not-made"
    : "quote-not-found";
}

export type CauseCounts = Record<NotCheckedCause, number>;

/** How many of the Not checked outcomes there are of each cause. */
export function countCauses(
  outcomes: readonly { code?: string; judge?: readonly JudgeRequest[] }[],
): CauseCounts {
  const counts: CauseCounts = {
    "quote-not-found": 0,
    "calculation-not-made": 0,
    malformed: 0,
    other: 0,
  };
  for (const outcome of outcomes) counts[causeOf(outcome.code, outcome.judge)]++;
  return counts;
}
