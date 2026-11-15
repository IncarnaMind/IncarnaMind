import { describe, expect, test } from "vitest";
import type { Expected } from "../../eval/repeats/cases";
import { measuredLines, measuredLinesTable, type ScoredRow } from "../../eval/speed/measuredLines";

const WITHIN = {
  firstReading: { supported: 0.8, contradicted: 0.5 },
  band: 0.005,
  joinedUnder: 0.25,
};

/** A sentence by its scores: the highest among its Passages, then its Passage's (or the joined ones') alone. */
const row = (
  id: string,
  expected: Expected,
  top: [states: number, opposes: number],
  alone: [states: number, opposes: number] | null,
  more: Partial<ScoredRow> = {},
): ScoredRow => ({
  note: "note",
  id,
  kind: null,
  expected,
  cited: false,
  top: { states: top[0], opposes: top[1] },
  alone: alone && { states: alone[0], opposes: alone[1] },
  ...more,
});

const ROWS: ScoredRow[] = [
  row("stated", "supported", [0.99, 0.01], [0.99, 0.01]),
  row("stated-less", "supported", [0.97, 0.01], [0.96, 0.01]),
  row("stated-least", "supported", [0.9, 0.01], [0.85, 0.01]),
  row("condition-dropped", "unsupported", [0.98, 0.01], [0.93, 0.01], { kind: "near-miss" }),
  row("never-asked", "supported", [0.85, 0.01], null),
  row("opposed", "contradicted", [0.02, 0.9], [0.02, 0.7]),
  row("other-subject", "unsupported", [0.02, 0.62], [0.02, 0.655]),
  row("both-ways", "unsupported", [0.85, 0.6], [0.9, 0.7]),
  row("absent", "unsupported", [0.05, 0.02], [0.12, 0.03]),
  row("absent-far", "unsupported", [0.03, 0.01], [0.04, 0.01]),
  row("absent-near", "unsupported", [0.02, 0.01], [0.22, 0.01]),
  row("summary", "supported", [0.1, 0.02], [0.2, 0.01]),
  row("cites-its-own", "supported", [0.01, 0.01], null, { cited: true }),
];

describe("The verdict lines a replay's labelled sentences allow (#3118)", () => {
  // protects=the script that measures a model's lines gives, for each verdict, the line at which no sentence labelled otherwise is settled, names the sentence that sets it and the nearest one it still settles, and counts what it settles: a Supported or Contradicted sentence is held to the lower of its score among the Passages and its Passage's alone, clear of the band; Unsupported to the highest score any Passage or the joined ones got; a sentence leaning both ways, one never asked about alone and one that cites a Passage set no line; fails_when=a line settles a sentence labelled otherwise, another sentence is named as setting it, or a sentence the replay couldn't place moves a line; no_claim=that a set holds the sentences a line must keep out, which is the person's to judge.
  test("each line is set by the nearest sentence labelled otherwise", () => {
    const lines = measuredLines(ROWS, WITHIN);

    expect(lines).toMatchObject([
      {
        verdict: "supported",
        line: 0.93,
        keptOut: {
          id: "condition-dropped",
          kind: "near-miss",
          expected: "unsupported",
          score: 0.93,
        },
        nearest: { id: "stated-less", score: 0.96 },
        settled: 2,
        notAsked: 1,
      },
      {
        verdict: "contradicted",
        line: 0.62,
        keptOut: { id: "other-subject", score: 0.62 },
        nearest: { id: "opposed", score: 0.7 },
        settled: 1,
        notAsked: 0,
      },
      {
        verdict: "unsupported",
        line: 0.2,
        keptOut: { id: "summary", expected: "supported", score: 0.2 },
        nearest: { id: "absent", score: 0.12 },
        settled: 2,
      },
    ]);
    expect(measuredLinesTable(lines)[2]).toBe(
      "| supported | 0.93 | note condition-dropped (near-miss, labelled unsupported) at 0.930 | note stated-less (no kind, labelled supported) at 0.960 | 2 | 1 |",
    );
  });

  // protects=a line clears the sentence it keeps out by the band and no more: one whose Passage alone scores 0.984 allows 0.98 (a verdict needs 0.985) and one at 0.985 needs 0.99; a line is never under a first reading's, however low the sentence it keeps out; fails_when=a line is a step too low or too high at the band's edge, or falls under a first reading's line; no_claim=that the band is right for a model.
  test.each([
    [0.984, 0.98],
    [0.985, 0.99],
    [0.3, 0.8],
  ])(
    "a sentence labelled otherwise whose Passage alone scores %s allows Supported at %s",
    (score, line) => {
      const rows = [row("near-miss", "unsupported", [0.999, 0.01], [score, 0.01])];
      expect(measuredLines(rows, WITHIN)[0]).toMatchObject({ line, keptOut: { score } });
    },
  );

  // protects=a set with no sentence labelled otherwise near a line gives the lowest lines a reading allows, a first reading's for Supported and Contradicted and the score the replay joined Passages under for Unsupported, and says no sentence set the first two; fails_when=such a set gives a line under a first reading's or over the joined score, or names a sentence that set none; no_claim=that such a set is enough to measure a model.
  test("with no sentence labelled otherwise the lines are the lowest a reading allows", () => {
    const rows = [
      row("stated", "supported", [0.9, 0.01], [0.9, 0.01]),
      row("opposed", "contradicted", [0.01, 0.6], [0.01, 0.6]),
      row("absent", "unsupported", [0.1, 0.01], [0.2, 0.01]),
    ];
    expect(
      measuredLines(rows, WITHIN).map(({ line, keptOut, settled }) => [line, keptOut?.id, settled]),
    ).toEqual([
      [0.8, undefined, 1],
      [0.5, undefined, 1],
      [0.25, "opposed", 1],
    ]);
  });
});
