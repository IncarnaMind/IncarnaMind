import { describe, expect, test } from "vitest";
import { readClaimCheck } from "../../src/shared/claimChecks";

describe("a mark an older build reads", () => {
  const mark = {
    id: "check-1",
    request: "request-1",
    action: "check-against-documents",
    state: "not-checked",
    reason: "a-reason-from-a-later-build",
    detail: '{"shown":"£1,284 million"}',
    providerId: null,
    modelId: "claude-haiku-5-5",
    text: "Revenue was £1,284 million.",
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [],
    excluded: [],
    checkedAt: "2026-11-14T00:00:00.000Z",
  };

  // protects=a reason this build doesn't know, as an older build meets "two-readings", reads as Not checked with no reason and nothing thrown, in a sentence and in a part (#3088); fails_when=reading the mark throws or the mark is dropped; no_claim=what the card shows for no reason.
  test("drops a reason it doesn't know, in the sentence and in its parts", () => {
    expect(readClaimCheck(mark)).toMatchObject({ state: "not-checked", reason: null });
    const parted = readClaimCheck({
      ...mark,
      parts: [
        {
          kind: "fact",
          span: { start: 0, end: 26 },
          verdict: "not-checked",
          reason: "a-reason-from-a-later-build",
          detail: null,
        },
      ],
    });
    expect(parted).toMatchObject({ state: "not-checked" });
    expect(parted?.reason).not.toBe("a-reason-from-a-later-build");
  });
});
