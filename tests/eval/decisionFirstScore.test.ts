/**
 * The gate of a decision model in front of the check (#3118) is decided by these counts
 * (eval/evidence/3118-decision-first, run by eval/speed/decisionFirst.speed.ts), so each is tried
 * on sentences made to land in one cell before any paid run is scored.
 */
import { describe, expect, test } from "vitest";
import {
  asLabelled,
  decisionUsd,
  type ReplayShown,
  replayOutcome,
  replayTally,
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
