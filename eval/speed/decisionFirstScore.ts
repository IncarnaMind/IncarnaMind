/**
 * How the gate of a decision model in front of the check (#3118) scores what a run left on the
 * page (eval/evidence/3118-decision-first): against the labels, and in the host's dollars.
 */
import { type DecisionLines, standsAlone } from "../../src/core/answers/checks/decisionLines";
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
  "marked unsupported, right",
  "marked unsupported, wrong",
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
 * itself: on a sentence labelled Unsupported a first reading either way is wrong.
 */
export function replayOutcome(expected: string, shown: ReplayShown | null): ReplayOutcome {
  if (!shown) return "not found in the Note";
  const right = (verdict: string) => (verdict === expected ? "right" : "wrong");
  if (shown.byDecision && shown.state === "unsupported")
    return `marked unsupported, ${right(shown.state)}`;
  const verdict = shown.byDecision ? shown.state : shown.firstReading;
  if (verdict !== "supported" && verdict !== "contradicted") return "no reading";
  return `${shown.byDecision ? "marked" : "first reading"} ${verdict}, ${right(verdict)}`;
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

const LABELS = ["supported", "contradicted", "unsupported"] as const;
const LEANS = ["supported", "contradicted"] as const;
type Lean = (typeof LEANS)[number];

const isLean = (verdict: string | null | undefined): verdict is Lean =>
  verdict === "supported" || verdict === "contradicted";

/** One labelled sentence as a run left it on the page. */
/**
 * A request about a sentence after its first: about one Passage or one line alone (`several` 0),
 * or about the lines of one Passage, with each question's answer.
 */
export interface HostLater {
  sentence: string;
  several: number;
  answers: Record<string, number>;
}

/** The step that kept a sure score from being the decision model's Mark, with the scores it went by. */
export type HeldBackStep =
  | { step: "not asked again" | "no line to rest on" }
  | { step: "its Passage alone"; states: number; opposes: number }
  | { step: "the amount"; same: number };

/** What the model said of one Passage asked about alone, and of its amounts where that was asked. */
export interface AskedAlone {
  states: number;
  opposes: number;
  same?: number;
  /** How surely the sentence drops a condition or limit its Passage sets, where asked. */
  leavesOut?: number;
}

/**
 * What the model said of a sentence's Passage asked about alone, from the requests that followed
 * the sentence's first: the first about one Passage with both questions, sent before any about a
 * line alone. For a sentence no Passage is about, it is the nearest ones joined.
 */
export function askedAlone(later: readonly HostLater[]): AskedAlone | null {
  const alone = later.find(
    ({ several, answers }) => several === 0 && answers.B !== undefined && answers.C !== undefined,
  );
  if (alone?.answers.B === undefined || alone.answers.C === undefined) return null;
  const same = later.find(({ several, answers }) => several === 0 && answers.N !== undefined)
    ?.answers.N;
  const leavesOut = later.find(({ several, answers }) => several === 0 && answers.L !== undefined)
    ?.answers.L;
  return {
    states: alone.answers.B,
    opposes: alone.answers.C,
    ...(same !== undefined && { same }),
    ...(leavesOut !== undefined && { leavesOut }),
  };
}

/** Why a sure score gave no Mark, from what the model said of its Passage asked about alone. */
export function heldBackBy(
  side: "supported" | "contradicted",
  alone: AskedAlone | null,
  lines: DecisionLines,
): HeldBackStep {
  if (!alone) return { step: "not asked again" };
  const { states, opposes, same } = alone;
  if (!standsAlone(side, alone, lines)) return { step: "its Passage alone", states, opposes };
  if (same !== undefined && same < (lines.verdict?.sameAmount ?? Number.POSITIVE_INFINITY))
    return { step: "the amount", same };
  return { step: "no line to rest on" };
}

export interface ReplayRow {
  note: string;
  id: string;
  text: string;
  expected: string;
  cited: boolean;
  shown: ReplayShown | null;
  /** What the decision model's scores alone are sure of, whatever a rule then held back. */
  sure: string | null;
}

export interface LabelCounts {
  label: string;
  figure: boolean;
  sentences: number;
  marked: number;
  /** First readings that lean the label's way, and the other way. */
  readingRight: number;
  readingWrong: number;
  none: number;
}

export interface HeldBack {
  rule: "a figure" | "no line to quote";
  sentences: number;
  /** Of them, those whose sure score is the sentence's label. */
  asLabelled: number;
}

/**
 * What the decision model did by label and by figure or none, and what its sure scores would have
 * been right about where a rule held the Mark back: a figure, by the gate's digit test, or else no
 * line to quote.
 */
export function replayByLabel(rows: readonly ReplayRow[]): {
  counts: LabelCounts[];
  heldBack: HeldBack[];
} {
  const counts = LABELS.flatMap((label) =>
    [true, false].map((figure): LabelCounts => {
      const mine = rows.filter((each) => each.expected === label && hasDigit(each.text) === figure);
      const readings = mine.filter((each) => !each.shown?.byDecision);
      const leaning = readings.filter((each) => isLean(each.shown?.firstReading));
      const readingRight = leaning.filter((each) => each.shown?.firstReading === label).length;
      const marked = mine.length - readings.length;
      return {
        label,
        figure,
        sentences: mine.length,
        marked,
        readingRight,
        readingWrong: leaning.length - readingRight,
        none: readings.length - leaning.length,
      };
    }),
  );
  const held = rows.filter((each) => isLean(each.sure) && !each.shown?.byDecision);
  const heldBack = (["a figure", "no line to quote"] as const).map((rule): HeldBack => {
    const mine = held.filter((each) => hasDigit(each.text) === (rule === "a figure"));
    return {
      rule,
      sentences: mine.length,
      asLabelled: mine.filter((each) => each.sure === each.expected).length,
    };
  });
  return { counts, heldBack };
}

export const SHAPES = ["the AI model alone", "the decision model alone", "both"] as const;
export type Shape = (typeof SHAPES)[number];

export interface ShapeCounts {
  shape: Shape;
  right: number;
  wrongSupported: number;
  wrongContradicted: number;
  wrongUnsupported: number;
  nothing: number;
  /** Sentences of this shape that reach the AI model. */
  toAiModel: number;
}

/** The verdict a run's page shows for a sentence: a Mark's, or nothing. */
const markOf = (shown: ReplayShown | null) =>
  shown && (LABELS as readonly string[]).includes(shown.state) ? shown.state : null;

/** What the decision model alone says of a sentence: its Mark, or what its first reading leans to. */
const readingOf = (shown: ReplayShown | null) => {
  const verdict = shown?.byDecision ? shown.state : shown?.firstReading;
  return isLean(verdict) ? verdict : null;
};

/**
 * The three shapes of the check scored on the same sentences from two runs: `decision` with the
 * decision model in front, `main` with the AI model alone. "Both" takes the decision model's
 * reading where it leans and the sentence has no digit, and the AI model's Mark elsewhere.
 */
export function shapesOf(
  decision: readonly ReplayRow[],
  main: readonly ReplayRow[],
): ShapeCounts[] {
  const mainOf = new Map(main.map((each) => [`${each.note} ${each.id}`, each]));
  const pairs = decision.flatMap((each) => {
    const other = mainOf.get(`${each.note} ${each.id}`);
    return other ? [{ row: each, read: readingOf(each.shown), mark: markOf(other.shown) }] : [];
  });
  return SHAPES.map((shape): ShapeCounts => {
    const shown = pairs.map(({ row, read, mark }) => {
      const own = shape === "both" && !hasDigit(row.text) ? read : null;
      const verdict =
        shape === "the AI model alone"
          ? mark
          : shape === "the decision model alone"
            ? read
            : (own ?? mark);
      const toAiModel = shape === "the AI model alone" || (shape === "both" && own === null);
      return { expected: row.expected, verdict, toAiModel };
    });
    const wrong = (verdict: string) =>
      shown.filter((each) => each.verdict === verdict && each.expected !== verdict).length;
    return {
      shape,
      right: shown.filter((each) => each.verdict === each.expected).length,
      wrongSupported: wrong("supported"),
      wrongContradicted: wrong("contradicted"),
      wrongUnsupported: wrong("unsupported"),
      nothing: shown.filter((each) => each.verdict === null).length,
      toAiModel: shown.filter((each) => each.toAiModel).length,
    };
  });
}
