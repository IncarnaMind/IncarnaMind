import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, RecordCiteResult } from "../../src/core/api";
import { claimCheckShown, readClaimCheck, restsOn } from "../../src/shared/claimChecks";
import { translate } from "../../src/shared/i18n";
import { formatLocation } from "../../src/shared/locations";

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
      { ...resolved, outcome: "unsupported" },
      { ...resolved, outcome: "not-checked", reason: "malformed", detail: null },
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

  test("retains recording and paragraph evidence and invalidates it when deleted", () => {
    const check = attributes([
      {
        raw: "Recording Tr. at 12:20",
        outcome: "supported",
        documentId: "transcript",
        documentName: "Transcript",
        contentHash: "hash-transcript",
        location: { kind: "time", from: 740_000, to: 745_000 },
        passage: "The answer",
      },
      {
        raw: "Compl. ¶ 14",
        outcome: "supported",
        documentId: "complaint",
        documentName: "Complaint",
        contentHash: "hash-complaint",
        location: { kind: "section", heading: null, paragraphs: { from: 14, to: 14 } },
        passage: "¶ 14 The allegation",
      },
    ]);
    check.versions = [
      { documentId: "transcript", contentHash: "hash-transcript" },
      { documentId: "complaint", contentHash: "hash-complaint" },
    ];

    expect(restsOn(check).map((each) => [each.documentId, each.pageFrom, each.pageTo])).toEqual([
      ["transcript", null, null],
      ["complaint", null, null],
    ]);
    expect(
      claimCheckShown(check, {
        text: check.text,
        versions: new Map(),
        folderId: null,
        scope: null,
      }),
    ).toMatchObject({ state: "needs-recheck", why: "document-removed" });
  });

  test("an old check without record-cite entries reads exactly as before", () => {
    const check = attributes();
    expect(readClaimCheck(check)?.recordCites).toBeUndefined();
    expect(restsOn(check)).toEqual([]);
  });
});

describe("a deposition cite's Location as the card names it", () => {
  const across = {
    kind: "page",
    from: 8,
    to: 9,
    printed: { from: "45", to: "46" },
    lines: { from: 24, to: 2 },
  } as const;
  const one = { ...across, to: 8, printed: { from: "45", to: "45" }, lines: { from: 3, to: 3 } };

  test.each([
    ["en", across, "p. 45, line 24–p. 46, line 2"],
    ["en", one, "p. 45 · line 3"],
    ["zh-CN", across, "第 45 页第 24 行至第 46 页第 2 行"],
  ] as const)("in %s, %j reads %s", (language, location, shown) => {
    expect(formatLocation(location, (key, params) => translate(language, key, params))).toBe(shown);
  });
});
