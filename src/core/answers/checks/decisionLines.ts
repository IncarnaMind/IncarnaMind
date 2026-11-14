/**
 * The lines a decision model's scores are read against in a sentence's first reading (#3118).
 *
 * Lines are measured, for one model on one host and for the two questions in ./decisionFirst as
 * they are worded: a change to either wording, or another model, needs its own measurement. They
 * are data: a newly measured model adds a row here and nothing else.
 */
import type { DecisionHost } from "../../providers/catalog/decisions";

export interface DecisionLines {
  /**
   * A score at or over a line, clear of `band`, is the sentence's verdict. `band` is the widest a
   * score moved between two runs of the same request: a score that near a line is a first reading.
   * Absent for a model whose verdicts weren't measured to hold.
   */
  verdict?: { supported: number; contradicted: number; band: number };
  /** A score at or over these is a first reading, which the User's AI model confirms or changes. */
  firstReading: { supported: number; contradicted: number };
}

const MEASURED: Readonly<Record<string, DecisionLines>> = {
  "openrouter:perplexity/pplx-decider-v1.2": {
    verdict: { supported: 0.98, contradicted: 0.9, band: 0.005 },
    firstReading: { supported: 0.8, contradicted: 0.5 },
  },
};

/** The lines measured for a model on a host; null for one not measured, which reads nothing. */
export const decisionLinesFor = (host: DecisionHost, modelId: string): DecisionLines | null =>
  MEASURED[`${host}:${modelId}`] ?? null;

/** A Passage's two scores: how surely it states the sentence, and how surely it says the opposite. */
export interface PassageScores {
  passageId: string;
  states: number;
  opposes: number;
}

/**
 * What the scores of a sentence's Passages come to: a verdict or a first reading resting on one
 * Passage, or nothing. A Passage that says the opposite outranks one that states the sentence, as
 * measured.
 */
export type Reading = {
  verdict: "supported" | "contradicted";
  passageId: string;
  final: boolean;
} | null;

const best = (scores: readonly PassageScores[], of: "states" | "opposes") =>
  scores.reduce<PassageScores | null>(
    (top, each) => (top === null || each[of] > top[of] ? each : top),
    null,
  );

export function readingOf(scores: readonly PassageScores[], lines: DecisionLines): Reading {
  const stating = best(scores, "states");
  const opposing = best(scores, "opposes");
  if (!stating || !opposing) return null;
  const { verdict, firstReading } = lines;
  if (verdict && opposing.opposes >= verdict.contradicted + verdict.band)
    return { verdict: "contradicted", passageId: opposing.passageId, final: true };
  if (
    verdict &&
    stating.states >= verdict.supported + verdict.band &&
    opposing.opposes < verdict.contradicted - verdict.band
  )
    return { verdict: "supported", passageId: stating.passageId, final: true };
  const states = stating.states >= firstReading.supported;
  const opposes = opposing.opposes >= firstReading.contradicted;
  if (states === opposes) return null;
  return states
    ? { verdict: "supported", passageId: stating.passageId, final: false }
    : { verdict: "contradicted", passageId: opposing.passageId, final: false };
}
