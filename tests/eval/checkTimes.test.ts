/**
 * The check timing (eval/speed/README.md › Where a check's time goes) reads a mark as the page
 * shows it, so its first verdict is never a mark that shows none.
 */
import { describe, expect, test } from "vitest";
import { firstVerdictMs, type Landed, shownMark, shownState } from "../../eval/speed/checkTimes";
import type { ClaimCheckAttributes } from "../../src/core/api";

const WRITTEN = "Spring tides come at new and full moon, and they flood the harbour every year.";
const CUT = "Spring tides come at new and full moon.";

const mark = (state: ClaimCheckAttributes["state"], text: string): ClaimCheckAttributes => ({
  id: "c1",
  request: "r1",
  action: "check-against-documents",
  state,
  reason: null,
  detail: null,
  providerId: "p1",
  modelId: "m1",
  text,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-11-06T00:00:00.000Z",
});

describe("The check timing's first verdict", () => {
  // protects=a cut sentence's mark, which the page shows as needing a check again, is no verdict to the timing (#2532); fails_when=its stored Unsupported counts as the first verdict; no_claim=how the page words it.
  test("a mark the page shows as needing a check again is no first verdict", () => {
    const stale = shownState(mark("unsupported", WRITTEN), CUT, new Map());
    const valid = shownState(mark("supported", CUT), CUT, new Map());
    const landed: Landed[] = [
      { sentence: 0, ms: 1_200, verdict: stale },
      { sentence: 1, ms: 3_400, verdict: valid },
    ];

    expect(stale).toBe("needs-recheck");
    expect(valid).toBe("supported");
    expect(firstVerdictMs(landed)).toBe(3_400);
    expect(firstVerdictMs(landed.slice(0, 1))).toBeNull();
  });

  // protects=a sentence the timing couldn't check is no first verdict either (#2532); fails_when=Not checked or Can't check counts; no_claim=none beyond protects.
  test("a mark that couldn't be checked is no first verdict", () => {
    expect(
      firstVerdictMs([
        { sentence: 0, ms: 500, verdict: "not-checked" },
        { sentence: 1, ms: 800, verdict: "cant-check" },
        { sentence: 2, ms: 2_000, verdict: "unsupported" },
      ]),
    ).toBe(2_000);
  });
});

describe("The check timing's marks", () => {
  // protects=a Not checked mark keeps the reason the mark gives, so a run's report says why each sentence wasn't checked (#2532); fails_when=only the state is kept; no_claim=how the page words the reason.
  test("a Not checked mark keeps its reason, and a verdict has none", () => {
    expect(shownMark({ ...mark("not-checked", CUT), reason: "malformed" }, CUT, new Map())).toEqual(
      {
        verdict: "not-checked",
        reason: "malformed",
      },
    );
    expect(shownMark(mark("supported", CUT), CUT, new Map())).toEqual({ verdict: "supported" });
  });
});
