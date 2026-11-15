/**
 * How the gate of a decision model in front of the check (#3118) scores what a run left on the
 * page (eval/evidence/3118-decision-first): against the labels, and in the host's dollars.
 */
import type { Expected } from "../repeats/cases";

// The host's listed price for Decider v1.2; it charges nothing for output.
const DECIDER_USD_PER_MILLION_INPUT = 0.02;

/** What the decision host's own count of input tokens costs at its listed price. */
export const decisionUsd = (inputTokens: number) =>
  (inputTokens / 1e6) * DECIDER_USD_PER_MILLION_INPUT;

/** Whether a Mark is the verdict the Documents give its sentence (eval/repeats/cases.ts). */
export function asLabelled(expected: Expected, state: string): boolean {
  if (expected === "supported" || expected === "contradicted") return state === expected;
  if (expected === "not-contradicted") return state === "supported" || state === "unsupported";
  if (expected === "contradicted-or-unsupported")
    return state === "contradicted" || state === "unsupported";
  return state === "unsupported";
}

export const REPLAY_OUTCOMES = [
  "marked supported, right",
  "marked supported, wrong",
  "marked contradicted, right",
  "marked contradicted, wrong",
  "first reading supported, right",
  "first reading supported, wrong",
  "first reading contradicted, right",
  "first reading contradicted, wrong",
  "no reading",
  "not found in the Note",
] as const;

export type ReplayOutcome = (typeof REPLAY_OUTCOMES)[number];

/** What the page shows of one labelled sentence after a replay, or null when it isn't on the page. */
export interface ReplayShown {
  /** Whether the decision model gave the Mark, and the Mark's verdict. */
  byDecision: boolean;
  state: string;
  /** The first reading's verdict, where the sentence got one. */
  firstReading: string | null;
}

/**
 * One labelled sentence's outcome. A Mark or a first reading is right only when it is the label
 * itself: on a sentence labelled Unsupported both verdicts are wrong.
 */
export function replayOutcome(expected: string, shown: ReplayShown | null): ReplayOutcome {
  if (!shown) return "not found in the Note";
  const verdict = shown.byDecision ? shown.state : shown.firstReading;
  if (verdict !== "supported" && verdict !== "contradicted") return "no reading";
  const what = shown.byDecision ? "marked" : "first reading";
  return `${what} ${verdict}, ${verdict === expected ? "right" : "wrong"}`;
}

/** The gate's own reading of "a sentence with a figure", apart from the app's: any digit. */
export const hasDigit = (sentence: string) => /\p{Nd}/u.test(sentence);

export interface ReplayTally {
  outcomes: Record<ReplayOutcome, number>;
  /** Marks from the decision model on a sentence with a digit, and on one with a Citation. */
  markedWithDigit: number;
  markedWithCitation: number;
}

export function replayTally(
  sentences: readonly {
    text: string;
    expected: string;
    cited: boolean;
    shown: ReplayShown | null;
  }[],
): ReplayTally {
  const outcomes = Object.fromEntries(REPLAY_OUTCOMES.map((each) => [each, 0])) as Record<
    ReplayOutcome,
    number
  >;
  let markedWithDigit = 0;
  let markedWithCitation = 0;
  for (const sentence of sentences) {
    const outcome = replayOutcome(sentence.expected, sentence.shown);
    outcomes[outcome]++;
    if (!outcome.startsWith("marked")) continue;
    if (hasDigit(sentence.text)) markedWithDigit++;
    if (sentence.cited) markedWithCitation++;
  }
  return { outcomes, markedWithDigit, markedWithCitation };
}
