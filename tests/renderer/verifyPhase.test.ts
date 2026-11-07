import { expect, test } from "vitest";
import { shownPhase } from "../../src/renderer/src/editor/verifyPhase";

/*
 * Verify a document (#1624): until its check has marked a claim, the badge and its card keep
 * saying the claims are being found, never "Checking 0 of 0".
 */

test("a check that hasn't marked a claim yet still says it is finding them", () => {
  expect(shownPhase("checking", 0)).toBe("finding");
});

test("a check counts once it has marked a claim", () => {
  expect(shownPhase("checking", 1)).toBe("checking");
  expect(shownPhase("checking", 24)).toBe("checking");
});

test("finding, or no run, is shown as it is", () => {
  expect(shownPhase("finding", 0)).toBe("finding");
  expect(shownPhase(null, 0)).toBeNull();
  expect(shownPhase(null, 24)).toBeNull();
});
