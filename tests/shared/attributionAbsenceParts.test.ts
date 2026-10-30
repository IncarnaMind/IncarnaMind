import { describe, expect, test } from "vitest";
import type { Citation, ClaimCheckResult, ClaimFacet, ClaimPartPlan } from "../../src/core/api";
import { partWithResult, readClaimParts, resultFromParts } from "../../src/shared/claimParts";

const DOCUMENT = "aa5adc06-11ce-4f86-9026-2601af32f22d";
const CASES = [
  {
    language: "en",
    source: "According to Lease",
    speaker: "Nora said",
    time: "Currently",
    absence: "the lease has no break clause.",
    quote: "Nora signed the lease.",
  },
  {
    language: "zh-CN",
    source: "据租约",
    speaker: "诺拉说",
    time: "目前",
    absence: "租约没有提前解约条款。",
    quote: "诺拉签署了租约。",
  },
] as const;

function wholeRead(
  verdict: "supported" | "contradicted" = "supported",
): Exclude<ClaimCheckResult, { verdict: "not-checked" }> {
  return {
    verdict,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [{ documentId: DOCUMENT, contentHash: "lease-v1" }],
    excluded: [],
    readDocuments: [
      {
        documentId: DOCUMENT,
        documentName: "Lease",
        contentHash: "lease-v1",
        locations: [{ kind: "page", from: 1, to: 2 }],
      },
    ],
  };
}

describe.each(CASES)("$language whole-read proof stays with the ordinary absence", (row) => {
  const ordinary: ClaimPartPlan = { kind: "fact", span: { start: 0, end: row.absence.length } };
  const citation: Citation = {
    passageId: "lease-passage",
    documentId: DOCUMENT,
    documentName: "Lease",
    contentHash: "lease-v1",
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "page", from: 1, to: 1 },
    quote: row.quote,
    check: "found",
    checkReason: null,
  };

  test("a quote-free ordinary absence remains Supported and reloadable", () => {
    const part = partWithResult(ordinary, wholeRead());
    const result = resultFromParts([part]);
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.evidence).toEqual([]);
    expect(result.parts?.[0]?.readDocuments).toEqual(wholeRead().readDocuments);
    expect(result.readDocuments).toEqual(wholeRead().readDocuments);
    const stored = readClaimParts(result.parts, row.absence);
    expect(stored).toEqual(result.parts);
    expect(resultFromParts(stored ?? []).verdict).toBe("supported");
  });

  test("a contradiction still requires its found quote", () => {
    expect(resultFromParts([partWithResult(ordinary, wholeRead("contradicted"))])).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
  });

  test.each(["source", "speaker", "time"] as const)(
    "%s cannot borrow whole-read proof in place of its own Citation",
    (kind) => {
      const words = row[kind];
      const plan: ClaimPartPlan = {
        kind: "fact",
        span: { start: 0, end: words.length },
        facet: { kind },
      };
      const result = resultFromParts([partWithResult(plan, wholeRead())]);
      expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
      expect(result.parts?.[0]).toMatchObject({
        span: plan.span,
        facet: { kind },
        verdict: "not-checked",
        reason: "no-evidence",
      });
      const stored = readClaimParts(result.parts, words);
      expect(stored).not.toBeNull();
      expect(resultFromParts(stored ?? [])).toMatchObject({
        verdict: "not-checked",
        reason: "no-evidence",
      });
    },
  );

  test.each(["source", "speaker", "time"] as const)(
    "%s keeps a valid ordinary absence neighbor truthful",
    (kind) => {
      const words = row[kind];
      const offset = words.length + 2;
      const qualifier = partWithResult(
        {
          kind: "fact",
          span: { start: 0, end: words.length },
          facet: { kind },
        },
        wholeRead(),
      );
      const absence = partWithResult(
        {
          kind: "fact",
          span: { start: offset, end: offset + row.absence.length },
        },
        wholeRead(),
      );
      const result = resultFromParts([qualifier, absence]);
      expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
      expect(result.parts?.[0]).toMatchObject({ facet: { kind }, verdict: "not-checked" });
      expect(result.parts?.[1]).toEqual(absence);
      expect(result.parts?.[1]?.readDocuments).toEqual(wholeRead().readDocuments);
    },
  );

  test.each(["source", "speaker", "time"] as const)(
    "%s with its own found Citation stays Supported",
    (kind) => {
      const facet: ClaimFacet = { kind };
      const result = resultFromParts([
        partWithResult(
          {
            kind: "fact",
            span: { start: 0, end: row[kind].length },
            facet,
          },
          { ...wholeRead(), evidence: citation },
        ),
      ]);
      expect(result.verdict).toBe("supported");
      expect(result.parts?.[0]?.facet).toEqual(facet);
      expect(result.parts?.[0]?.evidence).toEqual([citation]);
    },
  );
});
