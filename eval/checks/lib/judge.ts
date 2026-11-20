/**
 * What the judge said about each sentence the checks evaluation checked (#2910): every reply the
 * model gave, with the Tool calls it made, kept beside the outcome so a control that fails can be
 * read; and why a sentence came back Not checked.
 */
import type { HandedPassage } from "../../repeats/passagesHanded";
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
  reply: string;
  calls: JudgeCall[];
  /** The Passages the searches before this request handed the model, in order, new since the request before. */
  handed: HandedPassage[];
}

export function judgeRecord(requests: readonly WatchedRequest[]): JudgeRequest[] {
  let seen = 0;
  return requests.map(({ kind, reply, calls, handed }) => {
    const fresh = handed.slice(seen);
    seen = Math.max(seen, handed.length);
    return {
      kind,
      reply,
      calls: calls.map(({ tool, input, result }) => ({ tool, input, result })),
      handed: fresh,
    };
  });
}

export const NOT_CHECKED_CAUSES = ["quote-not-found", "malformed", "other"] as const;

/**
 * Why a sentence wasn't checked. "quote-not-found": what the core calls "no-evidence", a verdict
 * with no quote the Citation check found, whether the app turned the judge's `cite` away or it
 * recorded none. "malformed": the reply held no verdict that could be read. "other" is every
 * other reason the core gives: a refusal, a failed request, a limit.
 */
export type NotCheckedCause = (typeof NOT_CHECKED_CAUSES)[number];

/** The cause of a Not checked, from the core's reason (`ClaimCheckFailure`). */
export function causeOf(code: string | undefined): NotCheckedCause {
  if (code === "malformed") return "malformed";
  return code === "no-evidence" ? "quote-not-found" : "other";
}

export type CauseCounts = Record<NotCheckedCause, number>;

/** How many of the Not checked outcomes there are of each cause. */
export function countCauses(outcomes: readonly { code?: string }[]): CauseCounts {
  const counts: CauseCounts = { "quote-not-found": 0, malformed: 0, other: 0 };
  for (const outcome of outcomes) counts[causeOf(outcome.code)]++;
  return counts;
}
