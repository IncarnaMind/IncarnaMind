import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, FigureCheckAttributes } from "../../src/core/api";
import { addedCouldChange, claimCheckShown, readClaimCheck } from "../../src/shared/claimChecks";
import { readFigures } from "../../src/shared/figures";

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
        footing: "not-yet-known",
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

  // protects=a result stands for a reader only while it reaches every Document the result rests on, a whole read in a figure sentence's remainder too (#3458 review); fails_when=a Supported figure sentence whose remainder read a Document whole stays Supported for an agent that no longer reaches it
  test("a reader that doesn't reach a Document read whole, in a figure sentence's remainder too, finds it needs a re-check", () => {
    const text = "Rent was 12, and the lease has no break clause.";
    const [reading] = readFigures("12", { language: "en" });
    if (!reading) throw new Error("No figure.");
    const figure: FigureCheckAttributes = {
      ...ABSENCE,
      id: "rent",
      text,
      readDocuments: [],
      locator: {
        kind: "text",
        from: { blockId: "block", offset: 9 },
        to: { blockId: "block", offset: 11 },
      },
      reading,
      calculated: null,
      sourceInput: null,
      roundedFrom: null,
      difference: null,
      footing: [],
    };
    const check: ClaimCheckAttributes = {
      ...ABSENCE,
      text,
      readDocuments: [],
      figures: [figure],
      remainder: { ...ABSENCE, id: "rest", text },
    };
    const now = {
      footing: "not-yet-known" as const,
      text,
      versions: new Map([["lease", "v1"]]),
      folderId: null,
      scope: null,
    };
    expect(claimCheckShown(check, { ...now, reach: new Set(["lease"]) })).toEqual({
      state: "supported",
    });
    expect(claimCheckShown(check, { ...now, reach: new Set(["survey"]) })).toEqual({
      state: "needs-recheck",
      why: "reach",
    });
  });

  test("a Document added to the scope can change a Supported absence", () => {
    expect(addedCouldChange(ABSENCE, { state: "supported" })).toBe(true);
    expect(addedCouldChange({ ...ABSENCE, readDocuments: [] }, { state: "supported" })).toBe(false);
  });
});
