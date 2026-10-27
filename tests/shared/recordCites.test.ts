import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, RecordCiteResult } from "../../src/core/api";
import { readClaimCheck, restsOn } from "../../src/shared/claimChecks";

const location: RecordCiteResult["location"] = {
  kind: "page",
  from: 45,
  to: 46,
  printed: { from: "45", to: "46" },
  lines: { from: 3, to: 2 },
};

const resolved: RecordCiteResult = {
  raw: "Smith Dep. 45:3–46:2",
  from: 4,
  to: 26,
  outcome: "not-found",
  documentId: "doc-1",
  documentName: "Smith Deposition",
  contentHash: "hash-1",
  location,
  pageFrom: 45,
  pageTo: 46,
  passage: "The cited lines do not state the claim.",
  nearby: {
    location: { kind: "page", from: 47, to: 47, lines: { from: 5, to: 9 } },
    pageFrom: 47,
    pageTo: 47,
    passage: "The point appears nearby instead.",
  },
};

const attributes = (recordCites?: RecordCiteResult[]): ClaimCheckAttributes => ({
  id: "check-1",
  request: "request-1",
  action: "find-support",
  state: "supported",
  reason: null,
  detail: null,
  providerId: "provider",
  modelId: "model",
  text: "A sentence with record cites.",
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-27T00:00:00.000Z",
  ...(recordCites ? { recordCites } : {}),
});

describe("record-cite results in a claim-check mark", () => {
  test("round-trips every result and its nearby suggestion", () => {
    const cites: RecordCiteResult[] = [
      { ...resolved, outcome: "supported" },
      {
        ...resolved,
        raw: "Compl. ¶ 14",
        outcome: "partly",
        covered: "One part",
        uncovered: "Another",
      },
      resolved,
      { raw: "Ex. 7 at 3", outcome: "choose", candidates: [{ id: "doc-2", name: "Exhibit 7" }] },
    ];
    expect(readClaimCheck(attributes(cites))?.recordCites).toEqual(cites);
  });

  test("drops malformed entries and invalid Locations without losing valid ones", () => {
    const read = readClaimCheck(
      attributes([
        { raw: "bad", outcome: "not-found", location: { kind: "page", from: 0, to: 0 } },
        resolved,
      ]),
    );
    expect(read?.recordCites).toEqual([resolved]);
  });

  test("retains resolved and nearby sources, never unselected candidates", () => {
    const check = attributes([
      resolved,
      { raw: "Ex. 7 at 3", outcome: "choose", candidates: [{ id: "doc-2", name: "Exhibit 7" }] },
    ]);
    expect(restsOn(check).map((each) => [each.documentId, each.pageFrom, each.pageTo])).toEqual([
      ["doc-1", 45, 46],
      ["doc-1", 47, 47],
    ]);
  });

  test("an old check without record-cite entries reads exactly as before", () => {
    const check = attributes();
    expect(readClaimCheck(check)?.recordCites).toBeUndefined();
    expect(restsOn(check)).toEqual([]);
  });
});
