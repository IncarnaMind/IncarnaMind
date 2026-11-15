/**
 * The gate of a decision model in front of the check (#3118) is decided by these counts
 * (eval/evidence/3118-decision-first, run by eval/speed/decisionFirst.speed.ts), so each is tried
 * on sentences made to land in one cell before any paid run is scored.
 */
import { describe, expect, test } from "vitest";
import {
  asLabelled,
  decisionUsd,
  type ReplayRow,
  type ReplayShown,
  replayByLabel,
  replayOutcome,
  replayTally,
  shapesOf,
} from "../../eval/speed/decisionFirstScore";

const marked = (state: string): ReplayShown => ({ byDecision: true, state, firstReading: null });
const read = (firstReading: string | null, state = "unsupported"): ReplayShown => ({
  byDecision: false,
  state,
  firstReading,
});

describe("Scoring a decision model's Marks against labels (#3118)", () => {
  // protects=a Mark from the decision model counts as right only when it is the sentence's label: Supported or Contradicted on a sentence labelled Unsupported is a wrong Mark, the gate's first bar; fails_when=a wrong Mark is counted right or left out; no_claim=which sentences the decision model marks.
  test("a Mark is right only when it is the label", () => {
    expect(replayOutcome("supported", marked("supported"))).toBe("marked supported, right");
    expect(replayOutcome("contradicted", marked("contradicted"))).toBe(
      "marked contradicted, right",
    );
    expect(replayOutcome("unsupported", marked("supported"))).toBe("marked supported, wrong");
    expect(replayOutcome("unsupported", marked("contradicted"))).toBe("marked contradicted, wrong");
    expect(replayOutcome("contradicted", marked("supported"))).toBe("marked supported, wrong");
    expect(replayOutcome("supported", marked("contradicted"))).toBe("marked contradicted, wrong");
  });

  // protects=a sentence the AI model marks is scored by its first reading, never by the AI model's Mark, and one with no reading or not on the page gets its own cell; fails_when=the AI model's verdict is counted as the decision model's, or a missing sentence is counted as read; no_claim=the AI model's Marks.
  test("a first reading is scored apart from the AI model's Mark", () => {
    expect(replayOutcome("supported", read("supported", "contradicted"))).toBe(
      "first reading supported, right",
    );
    expect(replayOutcome("unsupported", read("contradicted", "unsupported"))).toBe(
      "first reading contradicted, wrong",
    );
    expect(replayOutcome("supported", read(null, "supported"))).toBe("no reading");
    expect(replayOutcome("supported", null)).toBe("not found in the Note");
  });

  // protects=the tally puts every sentence in exactly one cell and counts the decision model's Marks on sentences with a digit and with a Citation, the gate's figures bar; fails_when=a cell is skipped, a sentence is counted twice, or a first reading on a sentence with a digit is counted as a Mark; no_claim=what the app itself calls a figure.
  test("the tally counts each sentence once, and Marks on figures and Citations", () => {
    const tally = replayTally([
      {
        text: "The lease runs for a term.",
        expected: "supported",
        cited: true,
        shown: marked("supported"),
      },
      {
        text: "Rent is 12,000 a year.",
        expected: "supported",
        cited: false,
        shown: marked("supported"),
      },
      { text: "租期为３年。", expected: "contradicted", cited: false, shown: marked("supported") },
      {
        text: "Rent rose 4% in 2025.",
        expected: "supported",
        cited: true,
        shown: read("supported"),
      },
      { text: "The tenant may sublet.", expected: "unsupported", cited: false, shown: read(null) },
      { text: "Missing from the page.", expected: "supported", cited: false, shown: null },
    ]);

    expect(tally.outcomes).toEqual({
      "marked supported, right": 2,
      "marked supported, wrong": 1,
      "marked contradicted, right": 0,
      "marked contradicted, wrong": 0,
      "first reading supported, right": 1,
      "first reading supported, wrong": 0,
      "first reading contradicted, right": 0,
      "first reading contradicted, wrong": 0,
      "no reading": 1,
      "not found in the Note": 1,
    });
    expect(tally.markedWithDigit).toBe(2);
    expect(tally.markedWithCitation).toBe(1);
    expect(Object.values(tally.outcomes).reduce((sum, each) => sum + each, 0)).toBe(6);
  });

  // protects=on the paired run a Mark is as labelled by the set's own rule, where a label may allow two verdicts; fails_when=an allowed verdict is counted wrong or Supported passes on a sentence that must not be; no_claim=the labels themselves.
  test("a label that allows two verdicts accepts both and no other", () => {
    expect(asLabelled("not-contradicted", "supported")).toBe(true);
    expect(asLabelled("not-contradicted", "unsupported")).toBe(true);
    expect(asLabelled("not-contradicted", "contradicted")).toBe(false);
    expect(asLabelled("contradicted-or-unsupported", "supported")).toBe(false);
    expect(asLabelled("contradicted-or-unsupported", "contradicted")).toBe(true);
    expect(asLabelled("unsupported", "supported")).toBe(false);
    expect(asLabelled("supported", "supported")).toBe(true);
  });

  // protects=the decision model's cost is its host's input tokens at US$0.02 a million; fails_when=the price or the unit drifts; no_claim=what the host bills.
  test("the decision model's dollars are its input tokens at the listed price", () => {
    expect(decisionUsd(0)).toBe(0);
    expect(decisionUsd(400_000)).toBeCloseTo(0.008, 6);
  });
});

const row = (
  id: string,
  text: string,
  expected: string,
  shown: ReplayShown | null,
  sure: string | null = null,
): ReplayRow => ({ note: "n", id, text, expected, cited: false, shown, sure });

describe("Scoring the shapes of the check on the same sentences (#3118)", () => {
  // protects=the by-label table puts each sentence in one cell by its label and by a digit or none, and a sure score a rule held back is counted under the rule that held it (a digit, else no line to quote) with how many were the label; fails_when=a Mark is counted as a first reading, a held-back sentence lands under the other rule, or one the decision model marked is counted as held back; no_claim=what the app calls a figure.
  test("a sure score a rule held back is counted by rule and by its label", () => {
    const { counts, heldBack } = replayByLabel([
      row("1", "The lease runs for a term.", "supported", marked("supported"), "supported"),
      row("2", "Rent is 12,000 a year.", "supported", read("supported"), "supported"),
      row("3", "Rent rose 4% in 2025.", "contradicted", read("supported"), "supported"),
      row("4", "The tenant may sublet.", "contradicted", read("contradicted"), "contradicted"),
      row("5", "The landlord insures it.", "unsupported", read("supported")),
      row("6", "The roof is slate.", "unsupported", read(null)),
    ]);

    expect(counts.find((each) => each.label === "supported" && each.figure)).toEqual({
      label: "supported",
      figure: true,
      sentences: 1,
      marked: 0,
      readingRight: 1,
      readingWrong: 0,
      none: 0,
    });
    expect(counts.find((each) => each.label === "supported" && !each.figure)?.marked).toBe(1);
    expect(counts.find((each) => each.label === "contradicted" && each.figure)?.readingWrong).toBe(
      1,
    );
    expect(counts.find((each) => each.label === "unsupported" && !each.figure)).toMatchObject({
      sentences: 2,
      readingWrong: 1,
      none: 1,
    });
    expect(counts.reduce((sum, each) => sum + each.sentences, 0)).toBe(6);
    expect(heldBack).toEqual([
      { rule: "a figure", sentences: 2, asLabelled: 1 },
      { rule: "no line to quote", sentences: 1, asLabelled: 1 },
    ]);
  });

  // protects=the three shapes are scored on the sentences both runs hold: the AI model alone by the main run's Marks, the decision model alone by its Mark or first reading, and both by the reading where it leans on a sentence with no digit and the AI model's Mark elsewhere; fails_when=a shape takes the other run's verdict, a sentence with a digit keeps the decision model's reading under "both", or a wrong verdict is counted right; no_claim=which shape ships.
  test("each shape takes its verdict from the right run", () => {
    const decision = [
      row("1", "The lease runs for a term.", "supported", marked("supported")),
      row("2", "Rent is 12,000 a year.", "supported", read("contradicted")),
      row("3", "The tenant may sublet.", "unsupported", read("supported")),
      row("4", "The roof is slate.", "supported", read(null)),
      row("5", "Only in the first run.", "supported", marked("supported")),
    ];
    const main = [
      row("1", "The lease runs for a term.", "supported", read(null, "unsupported")),
      row("2", "Rent is 12,000 a year.", "supported", read(null, "supported")),
      row("3", "The tenant may sublet.", "unsupported", read(null, "unsupported")),
      row("4", "The roof is slate.", "supported", read(null, "not-checked")),
    ];

    expect(shapesOf(decision, main)).toEqual([
      {
        shape: "the AI model alone",
        right: 2,
        wrongSupported: 0,
        wrongContradicted: 0,
        wrongUnsupported: 1,
        nothing: 1,
        toAiModel: 4,
      },
      {
        shape: "the decision model alone",
        right: 1,
        wrongSupported: 1,
        wrongContradicted: 1,
        wrongUnsupported: 0,
        nothing: 1,
        toAiModel: 0,
      },
      {
        shape: "both",
        right: 2,
        wrongSupported: 1,
        wrongContradicted: 0,
        wrongUnsupported: 0,
        nothing: 1,
        toAiModel: 2,
      },
    ]);
  });
});
