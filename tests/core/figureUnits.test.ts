/**
 * A figure keeps exactly the units its Document states (#1332): the assistant is told never to add
 * a currency the Document doesn't state, nor to turn percentage points into a percent.
 */
import { describe, expect, test } from "vitest";
import { documentInstructions } from "../../src/core/answers/prompt";

describe("What the assistant is told", () => {
  // protects=every way of citing tells the model to keep each figure's currency, unit and scale as its Document gives them, with the currency example in English and Chinese and the points example; fails_when=a mode leaves it out; no_claim=what a real model writes, which the pull request's hand check covers.
  test.each(["tools", "structured-output", "none"] as const)("in %s", (mode) => {
    const told = documentInstructions(mode, { total: 1, names: ["Employment agreement"] });
    expect(told).toContain(
      "A figure taken from a Passage keeps exactly the currency, unit and scale its Document gives it",
    );
    expect(told).toContain("54,000（未注明币种）");
    expect(told).toContain('"2 percentage points" never becomes "2%"');
  });
});
