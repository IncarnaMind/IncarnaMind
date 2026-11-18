import { describe, expect, test } from "vitest";
import { readClaimCheck } from "../../src/shared/claimChecks";

describe("A mark an earlier whole read of a Document left", () => {
  test("reads current coverage and leaves older marks with their old action", () => {
    const current = readClaimCheck({
      id: "whole",
      action: "check-against-document",
      state: "unsupported",
      read: { pages: 2, of: 4 },
    });
    expect(current).toMatchObject({ action: "check-against-document", read: { pages: 2, of: 4 } });
    const older = readClaimCheck({ id: "older", action: "future-action", state: "unsupported" });
    expect(older).toMatchObject({ action: "find-support" });
    expect(older?.read).toBeUndefined();
  });
});
