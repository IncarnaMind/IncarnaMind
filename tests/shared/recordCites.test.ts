import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, RecordCiteResult } from "../../src/core/api";
import type { NoteParagraph } from "../../src/core/recordCites/referents";
import {
  claimCheckShown,
  claimMarkState,
  readClaimCheck,
  restsOn,
} from "../../src/shared/claimChecks";
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
    // A key with no value in a mark kept Tie out figures from seeing its checks end.
    expect(Object.keys(readClaimCheck(check) ?? {})).not.toContain("recordCites");
    expect(restsOn(check)).toEqual([]);
  });
});

describe("an Id. or supra as the text it refers back to changes", () => {
  const claim = "Then he left the room. Id. at 46:1.";
  const idCite: RecordCiteResult = {
    raw: "Id. at 46:1",
    from: claim.indexOf("Id."),
    to: claim.length - 1,
    outcome: "supported",
    via: ["Smith Dep. 45:3"],
  };
  const check = { ...attributes([idCite]), text: claim };
  const shownWith = (before: string, note = true) =>
    claimCheckShown(check, {
      text: claim,
      versions: null,
      folderId: null,
      scope: null,
      ...(note && {
        note: {
          paragraphs: (): NoteParagraph[] => [
            { blockId: "before", text: before },
            { blockId: "this", text: claim },
          ],
          place: { blockId: "this", from: 0 },
        },
      }),
    });

  test("keeps its result while the cite it refers back to reads as it did", () => {
    expect(shownWith("He admitted it (Smith Dep. 45:3).")).toEqual({ state: "supported" });
  });

  test("needs re-check when that cite or what stands between them changes", () => {
    for (const before of [
      "He admitted it (Jones Dep. 45:3).",
      "He admitted it (Smith Dep. 45:3). He signed (Ex. 7 at 2).",
      "He admitted it (Smith Dep. 45:3). The law is 42 U.S.C. § 1983.",
      "He admitted it.",
    ]) {
      expect(shownWith(before)).toEqual({ state: "needs-recheck", why: "referent" });
    }
  });

  test("a sentence edited is Edited first, and without the Note nothing is assumed", () => {
    expect(
      claimCheckShown(check, {
        text: "Then he left. Id. at 46:1.",
        versions: null,
        folderId: null,
        scope: null,
      }),
    ).toEqual({ state: "needs-recheck", why: "edited" });
    expect(shownWith("He admitted it (Jones Dep. 45:3).", false)).toEqual({ state: "supported" });
  });

  test("round-trips what it was read through", () => {
    expect(readClaimCheck(check)?.recordCites?.[0]?.via).toEqual(["Smith Dep. 45:3"]);
  });
});

describe("the margin glyph of a sentence with record cites", () => {
  const cite = (outcome: RecordCiteResult["outcome"]): RecordCiteResult => ({
    raw: "Smith Dep. 45:3",
    outcome,
  });

  test("never shows Supported over a cite that is Unsupported, Not found or Choose", () => {
    for (const outcome of ["unsupported", "not-found", "choose"] as const) {
      expect(claimMarkState("supported", attributes([cite("supported"), cite(outcome)]))).toBe(
        "unsupported",
      );
    }
  });

  test("shows the sentence's own state otherwise", () => {
    expect(
      claimMarkState(
        "supported",
        attributes([cite("supported"), cite("partly"), cite("not-checked")]),
      ),
    ).toBe("supported");
    expect(claimMarkState("supported", attributes())).toBe("supported");
    expect(claimMarkState("contradicted", attributes([cite("not-found")]))).toBe("contradicted");
    expect(claimMarkState("needs-recheck", attributes([cite("choose")]))).toBe("needs-recheck");
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
