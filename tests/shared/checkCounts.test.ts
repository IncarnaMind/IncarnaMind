import { describe, expect, test } from "vitest";
import {
  type CheckedSentence,
  type ClaimCheckShown,
  checkedSentence,
  toCheckCount,
} from "../../src/shared/claimChecks";

/*
 * The one count every check surface reads (#1909): a claim no check covers
 * now is to check, whether it has no check, one that failed, or one that no
 * longer holds; a verdict that holds covers it; a sentence the User keeps or
 * one the last whole-Mind check found makes no claim counts as nothing.
 */

const CLAIM = "Spring tides come at new moon and at full moon.";
const SHORT = "Thanks!";

const state = (
  text: string,
  check: ClaimCheckShown | null,
  { skipped = false, kept = false } = {},
): CheckedSentence => checkedSentence({ text, check, skipped, kept });

describe("The one count of sentences to check (#1909)", () => {
  test("a claim with no check is to check, and one the next run names first is fresh", () => {
    expect(state(CLAIM, null)).toEqual({ kind: "to-check", fresh: true, why: "none" });
  });

  test("a check that failed or no longer holds is not checked yet", () => {
    expect(state(CLAIM, { state: "not-checked", reason: "rate-limit" })).toEqual({
      kind: "to-check",
      fresh: false,
      why: "failed",
    });
    for (const why of [
      "edited",
      "new-version",
      "document-removed",
      "scope",
      "search-scope",
    ] as const)
      expect(state(CLAIM, { state: "needs-recheck", why })).toEqual({
        kind: "to-check",
        fresh: false,
        why: "recheck",
      });
  });

  test("a verdict that holds covers it", () => {
    for (const verdict of ["supported", "unsupported", "contradicted"] as const)
      expect(state(CLAIM, { state: verdict })).toEqual({ kind: "covered" });
  });

  test("a check still running is not to check", () => {
    expect(state(CLAIM, { state: "checking" })).toEqual({ kind: "checking" });
  });

  test("a shown verdict decides before isClaim and skipped: a figure or a short line is still a verdict (#1909)", () => {
    expect(state("100", { state: "contradicted" })).toEqual({ kind: "covered" });
    expect(state("Next steps", { state: "contradicted" })).toEqual({ kind: "covered" });
    expect(state("38.6%", { state: "unsupported" })).toEqual({ kind: "covered" });
    expect(state("Next steps", { state: "supported" })).toEqual({ kind: "covered" });
  });

  test("a check that failed on a sentence the whole-Mind check skipped is still to check (#1909)", () => {
    expect(state(CLAIM, { state: "not-checked", reason: "failed" }, { skipped: true })).toEqual({
      kind: "to-check",
      fresh: false,
      why: "failed",
    });
    expect(state(CLAIM, { state: "needs-recheck", why: "edited" }, { skipped: true })).toEqual({
      kind: "to-check",
      fresh: false,
      why: "recheck",
    });
  });

  test("a sentence kept as the User's own view counts as nothing, before its mark reads it", () => {
    expect(state(CLAIM, { state: "kept" })).toEqual({ kind: "kept" });
    expect(state(CLAIM, null, { kept: true })).toEqual({ kind: "kept" });
  });

  test("a sentence that makes no claim, and one the last whole-Mind check found makes none, counts as nothing", () => {
    expect(state(SHORT, null)).toEqual({ kind: "not-claim" });
    expect(state(CLAIM, null, { skipped: true })).toEqual({ kind: "not-claim" });
  });

  test("counts them the one way, whatever their marks", () => {
    expect(
      toCheckCount([
        state(CLAIM, null),
        state(CLAIM, { state: "not-checked", reason: "failed" }),
        state(CLAIM, { state: "needs-recheck", why: "edited" }),
        state(CLAIM, { state: "supported" }),
        state(CLAIM, { state: "checking" }),
        state(SHORT, null),
      ]),
    ).toBe(3);
  });
});
