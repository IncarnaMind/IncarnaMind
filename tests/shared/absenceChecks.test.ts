import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes } from "../../src/core/api";
import { addedCouldChange, claimCheckShown, readClaimCheck } from "../../src/shared/claimChecks";

const ABSENCE: ClaimCheckAttributes = {
  id: "c1",
  request: "r1",
  action: "check-against-documents",
  state: "supported",
  reason: null,
  detail: null,
  providerId: "p1",
  modelId: "m1",
  text: "The lease has no break clause.",
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [{ documentId: "lease", contentHash: "v1" }],
  excluded: [],
  readDocuments: [
    {
      documentId: "lease",
      documentName: "Lease",
      contentHash: "v1",
      locations: [{ kind: "page", from: 1, to: 1 }],
    },
  ],
  checkedAt: "2026-10-27T00:00:00.000Z",
};

describe("An absence check's lifetime", () => {
  test("deleting a Document read whole makes the result need a re-check", () => {
    expect(
      claimCheckShown(ABSENCE, {
        text: ABSENCE.text,
        versions: new Map(),
        folderId: null,
        scope: null,
      }),
    ).toEqual({ state: "needs-recheck", why: "document-removed" });
  });

  test("a stored whole read keeps only valid Locations", () => {
    const parsed = readClaimCheck({
      ...ABSENCE,
      readDocuments: [
        {
          documentId: "lease",
          documentName: "Lease",
          contentHash: "v1",
          locations: [null, { kind: "page", from: 1, to: 1 }],
        },
      ],
    });

    expect(parsed?.readDocuments?.[0]?.locations).toEqual([{ kind: "page", from: 1, to: 1 }]);
  });

  test("a Document added to the scope can change a Supported absence", () => {
    expect(addedCouldChange(ABSENCE, { state: "supported" })).toBe(true);
    expect(addedCouldChange({ ...ABSENCE, readDocuments: [] }, { state: "supported" })).toBe(false);
  });
});
