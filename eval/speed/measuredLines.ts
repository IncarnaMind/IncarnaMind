/**
 * The verdict lines a replay's labelled sentences allow a decision model, each with the sentences
 * that set it (#3118), so a newly measured model adds data to
 * src/core/answers/checks/decisionLines.ts and no code.
 *
 * It reads what a replay saved (marks.json of decisionFirst.speed.ts), run with the verdict lines
 * at a first reading's (INCARNAMIND_EVAL_SPEED_LINES), so that the Passage of every leaning
 * sentence was asked about alone. It asks no model, and it reads scores and labels only: what
 * they allow is a floor, to which a person adds room for sentences the set doesn't hold.
 */
import type { DecisionLines } from "../../src/core/answers/checks/decisionLines";
import type { Expected } from "../repeats/cases";
import { type AskedAlone, asLabelled } from "./decisionFirstScore";

/** One labelled sentence of a replay with its scores. */
export interface ScoredRow {
  note: string;
  id: string;
  kind: string | null;
  expected: Expected;
  cited: boolean;
  /** The highest score any Passage got on each question in the sentence's first request. */
  top: { states: number; opposes: number } | null;
  /** Its Passage asked about alone or, where no Passage is about it, the nearest ones joined. */
  alone: AskedAlone | null;
}

/** A sentence beside a line, by its note and id, with the score the line is held to. */
export interface Placed {
  note: string;
  id: string;
  kind: string | null;
  expected: Expected;
  score: number;
}

export interface MeasuredLine {
  verdict: "supported" | "contradicted" | "unsupported";
  line: number;
  /** The sentence labelled otherwise that the line keeps out: nearest to it. Null where there is none. */
  keptOut: Placed | null;
  /** The sentence labelled so that the line still settles: nearest to it. */
  nearest: Placed | null;
  /** How many sentences labelled so the line settles. */
  settled: number;
  /** Sentences that lean this way and were never asked about alone: the replay can't place them. */
  notAsked: number;
}

/** What the lines are measured within: a first reading's lines, the band, and the score under which the replay joined a sentence's Passages. */
export interface MeasuredWithin {
  firstReading: DecisionLines["firstReading"];
  band: number;
  joinedUnder: number;
}

const HUNDREDTHS = 100;
const ROUNDING = 1e-9;

const placed = (row: ScoredRow, score: number): Placed => ({
  note: row.note,
  id: row.id,
  kind: row.kind,
  expected: row.expected,
  score,
});

const most = (rows: readonly Placed[], sign: 1 | -1): Placed | null =>
  rows.reduce<Placed | null>(
    (top, each) => (top === null || sign * each.score > sign * top.score ? each : top),
    null,
  );

/** The side a sentence leans to in its first request, as a reading does: none where it leans both ways. */
function leaning(
  { top }: ScoredRow,
  { firstReading }: MeasuredWithin,
): "supported" | "contradicted" | null {
  if (!top) return null;
  const states = top.states >= firstReading.supported;
  const opposes = top.opposes >= firstReading.contradicted;
  if (states === opposes) return null;
  return states ? "supported" : "contradicted";
}

/**
 * The lowest line, to two decimals and no lower than a first reading's, at which no sentence
 * labelled otherwise is settled: a verdict needs its score among the Passages and its Passage's
 * alone both clear of the line by the band, so a sentence is held to the lower of the two.
 */
function verdictLine(
  side: "supported" | "contradicted",
  rows: readonly ScoredRow[],
  within: MeasuredWithin,
): MeasuredLine {
  const of = side === "supported" ? "states" : "opposes";
  const leans = rows.filter((row) => leaning(row, within) === side);
  const asked = leans.flatMap((row) =>
    row.top && row.alone ? [placed(row, Math.min(row.top[of], row.alone[of]))] : [],
  );
  const keptOut = most(
    asked.filter((each) => !asLabelled(each.expected, side)),
    1,
  );
  const line = Math.max(
    within.firstReading[side],
    keptOut
      ? (Math.floor((keptOut.score - within.band) * HUNDREDTHS + ROUNDING) + 1) / HUNDREDTHS
      : 0,
  );
  const settled = asked.filter(
    (each) => asLabelled(each.expected, side) && each.score >= line + within.band,
  );
  return {
    verdict: side,
    line,
    keptOut,
    nearest: most(settled, -1),
    settled: settled.length,
    notAsked: leans.length - asked.length,
  };
}

/**
 * The highest line, to two decimals and no higher than the replay joined Passages under, below
 * which no sentence labelled otherwise falls: a sentence is Unsupported where every Passage, and
 * the nearest ones joined, score under the line on both questions. One that cites a Passage is
 * never Unsupported on a decision model's word.
 */
function unsupportedLine(rows: readonly ScoredRow[], within: MeasuredWithin): MeasuredLine {
  const about = rows.flatMap((row) =>
    row.top && !row.cited
      ? [
          placed(
            row,
            Math.max(
              row.top.states,
              row.top.opposes,
              row.alone?.states ?? 0,
              row.alone?.opposes ?? 0,
            ),
          ),
        ]
      : [],
  );
  const keptOut = most(
    about.filter((each) => !asLabelled(each.expected, "unsupported")),
    -1,
  );
  const line = Math.min(
    within.joinedUnder,
    keptOut
      ? Math.floor(keptOut.score * HUNDREDTHS + ROUNDING) / HUNDREDTHS
      : Number.POSITIVE_INFINITY,
  );
  const settled = about.filter(
    (each) => asLabelled(each.expected, "unsupported") && each.score < line,
  );
  return {
    verdict: "unsupported",
    line,
    keptOut,
    nearest: most(settled, 1),
    settled: settled.length,
    notAsked: 0,
  };
}

/** The three verdict lines the replay's sentences allow, each with the sentences that set it. */
export const measuredLines = (
  rows: readonly ScoredRow[],
  within: MeasuredWithin,
): MeasuredLine[] => [
  verdictLine("supported", rows, within),
  verdictLine("contradicted", rows, within),
  unsupportedLine(rows, within),
];

const told = (each: Placed | null) =>
  each
    ? `${each.note} ${each.id} (${each.kind ?? "no kind"}, labelled ${each.expected}) at ${each.score.toFixed(3)}`
    : "none";

/** The lines as a table: sentences by note and id, never by their words. */
export const measuredLinesTable = (lines: readonly MeasuredLine[]): string[] => [
  "| Verdict | Line | Kept out, labelled otherwise | Nearest it settles | Sentences it settles | Leaning, not asked about alone |",
  "|---|---|---|---|---|---|",
  ...lines.map(
    (each) =>
      `| ${each.verdict} | ${each.line.toFixed(2)} | ${told(each.keptOut)} | ${told(each.nearest)} | ${each.settled} | ${each.notAsked} |`,
  ),
];
