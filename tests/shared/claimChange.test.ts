import { describe, expect, test } from "vitest";
import {
  CHANGE_CHARS,
  changeProblem,
  givenChange,
  readClaimChange,
} from "../../src/shared/claimChange";
import { INLINE_NODE } from "../../src/shared/sentences";

/*
 * A change the User's own AI gives with a check (#3715) is the sentence's words only: the core and
 * the card read it by one rule, so one the core refuses is never one the card shows.
 */

describe("what a change may hold", () => {
  test.each([
    ["a Citation token", { replace: "two boats", with: "one boat [cite:ab12cd]" }, "citation"],
    ["a line break", { replace: "two boats", with: "one\nboat" }, "line-break"],
    ["a line separator", { replace: "two boats", with: "one boat" }, "line-break"],
    ["the object character", { replace: `two${INLINE_NODE} boats`, with: "one boat" }, "object"],
    ["more than a sentence", { replace: "two", with: "x".repeat(CHANGE_CHARS + 1) }, "too-long"],
    ["the words it replaces", { replace: "two boats", with: "two boats" }, "same"],
  ] as const)("refuses one holding %s", (_, change, problem) => {
    expect(changeProblem(change)).toBe(problem);
    expect(readClaimChange(change)).toBeNull();
  });

  test("keeps the sentence's words, and taking words out", () => {
    for (const change of [
      { replace: "two boats", with: "one boat" },
      { replace: " at all states of the tide", with: "" },
      { replace: "两条船", with: "一条船" },
    ]) {
      expect(changeProblem(change)).toBeNull();
      expect(readClaimChange(change)).toEqual(change);
    }
  });

  test("reads no change from anything but two strings with words to replace", () => {
    for (const value of [
      null,
      "two boats",
      { replace: "", with: "x" },
      { replace: "two" },
      { with: "x" },
    ])
      expect(givenChange(value)).toBeNull();
  });
});
