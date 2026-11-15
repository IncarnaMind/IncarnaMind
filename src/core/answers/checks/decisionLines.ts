/**
 * The lines a decision model's scores are read against in a sentence's first reading (#3118).
 *
 * Lines are measured, for one model on one host and for the two questions in ./decisionFirst as
 * they are worded: a change to either wording, or another model, needs its own measurement. They
 * are data: a newly measured model adds an entry here and nothing else.
 */
import type { DecisionHost } from "../../providers/catalog/decisions";

export interface DecisionLines {
  /**
   * A score at or over a line, clear of `band`, is the sentence's verdict, where its Passage asked
   * about alone scores clear of the same line again. `band` is the widest a score moved between
   * two runs of the same request: a score that near a line is a first reading. `quote` holds the
   * lines for the Passage's line shown as the verdict's quote, measured apart and higher: what a
   * User reads as the proof. `sameAmount` is the line for a number the Passage writes another way.
   * Unsupported needs every Passage under `unsupported` on both questions: a score between it and
   * a first reading's line is a Passage about the sentence that doesn't settle it (a figure it
   * gives by a sum, a "may" for a "must"), which the AI model's check reads. Absent for a model
   * whose verdicts weren't measured to hold.
   */
  verdict?: {
    supported: number;
    contradicted: number;
    band: number;
    quote: { supported: number; contradicted: number };
    sameAmount: number;
    unsupported: number;
  };
  /** A score at or over these is a first reading, which the User's AI model confirms or changes. */
  firstReading: { supported: number; contradicted: number };
}

interface MeasuredDecisionModel {
  host: DecisionHost;
  modelId: string;
  lines: DecisionLines;
}

/** Every measured model, the best first. */
export const MEASURED_DECISION_MODELS: readonly [
  MeasuredDecisionModel,
  ...MeasuredDecisionModel[],
] = [
  {
    host: "openrouter",
    modelId: "perplexity/pplx-decider-v1.2",
    lines: {
      verdict: {
        // No lower: a sentence that drops its Passage's condition, or widens its subject, scored
        // 0.965 to 0.984 on that Passage asked about alone (#3118).
        supported: 0.98,
        contradicted: 0.85,
        band: 0.005,
        quote: { supported: 0.98, contradicted: 0.9 },
        sameAmount: 0.92,
        unsupported: 0.25,
      },
      firstReading: { supported: 0.8, contradicted: 0.5 },
    },
  },
];

/** The lines measured for a model on a host; null for one not measured, which reads nothing. */
export const decisionLinesFor = (host: DecisionHost, modelId: string): DecisionLines | null =>
  MEASURED_DECISION_MODELS.find((each) => each.host === host && each.modelId === modelId)?.lines ??
  null;

/** A Passage's two scores: how surely it states the sentence, and how surely it says the opposite. */
export interface PassageScores {
  passageId: string;
  states: number;
  opposes: number;
}

/**
 * What the scores of a sentence's Passages come to: a verdict or a first reading resting on one
 * Passage, Unsupported when none of them is about it either way, or nothing. Nothing too where one
 * Passage states the sentence and another says the opposite, each surely or only leaning (an old
 * Document states it, a later amendment leans against it): the Documents disagree, which no
 * single Passage's score settles.
 */
export type Reading =
  | { verdict: "supported" | "contradicted"; passageId: string; final: boolean }
  | { verdict: "unsupported" }
  | null;

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
  const sureStates = verdict !== undefined && stating.states >= verdict.supported + verdict.band;
  const sureOpposes =
    verdict !== undefined && opposing.opposes >= verdict.contradicted + verdict.band;
  const states = sureStates || stating.states >= firstReading.supported;
  const opposes = sureOpposes || opposing.opposes >= firstReading.contradicted;
  if (states && opposes) return null;
  if (sureOpposes) return { verdict: "contradicted", passageId: opposing.passageId, final: true };
  if (sureStates) return { verdict: "supported", passageId: stating.passageId, final: true };
  if (states) return { verdict: "supported", passageId: stating.passageId, final: false };
  if (opposes) return { verdict: "contradicted", passageId: opposing.passageId, final: false };
  const about = Math.max(stating.states, opposing.opposes);
  return verdict && about < verdict.unsupported ? { verdict: "unsupported" } : null;
}

/**
 * The Passages a reading found to be about the sentence, one way or the other, each with how
 * surely: those scored at or over the model's Unsupported line on either question, or, for a
 * model without that line, at or over the lower of its first reading's lines.
 */
export function passagesAbout(
  scores: readonly PassageScores[],
  { verdict, firstReading }: DecisionLines,
): Map<string, number> {
  const line = verdict?.unsupported ?? Math.min(firstReading.supported, firstReading.contradicted);
  return new Map(
    scores
      .map((each) => [each.passageId, Math.max(each.states, each.opposes)] as const)
      .filter(([, about]) => about >= line),
  );
}

type Side = "supported" | "contradicted";
type Alone = Pick<PassageScores, "states" | "opposes">;

const clear = (side: Side, alone: Alone, lines: Record<Side, number>, band: number) =>
  side === "contradicted"
    ? alone.opposes >= lines.contradicted + band
    : alone.states >= lines.supported + band && alone.opposes < lines.contradicted - band;

/** Whether a verdict the Passages' scores gave still holds when its Passage is asked about alone. */
export const standsAlone = (side: Side, alone: Alone, { verdict }: DecisionLines): boolean =>
  verdict !== undefined && clear(side, alone, verdict, verdict.band);

/** Whether a line of the verdict's Passage, asked about alone, may be shown as the verdict's quote. */
export const quoteStands = (side: Side, alone: Alone, { verdict }: DecisionLines): boolean =>
  verdict !== undefined && clear(side, alone, verdict.quote, verdict.band);
