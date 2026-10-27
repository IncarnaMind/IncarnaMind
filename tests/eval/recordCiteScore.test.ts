import { describe, expect, test } from "vitest";
import { scoreRecordCase } from "../../eval/record-cites/score";
import type { RecordSetCase } from "../../eval/record-cites/set";
import type { ClaimCheckResult, RecordCiteResult } from "../../src/core";

const testCase: RecordSetCase = {
  id: "case-1",
  language: "en",
  claim: "Trial briefs are due (ECF No. 41 at 3).",
  cites: [
    {
      raw: "ECF No. 41 at 3",
      outcome: "supported",
      document: "regency-ecf-41",
      location: { kind: "page", from: 3, to: 3, printed: { from: "3", to: "3" } },
      passageContains: "Trial briefs",
    },
  ],
  checked: "2026-10-27",
};

const cite: RecordCiteResult = {
  raw: "ECF No. 41 at 3",
  outcome: "supported",
  documentId: "doc-1",
  location: { kind: "page", from: 3, to: 3, printed: { from: "3", to: "3" } },
  pageFrom: 3,
  pageTo: 3,
  passage: "Trial briefs are due by September 2, 2021.",
};

const result = (recordCites: RecordCiteResult[]): ClaimCheckResult => ({
  verdict: "supported",
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  versions: [],
  excluded: [],
  recordCites,
});

const keyOf = (id: string | undefined) => (id === "doc-1" ? "regency-ecf-41" : undefined);

describe("public record-cite scoring", () => {
  test("accepts the keyed result and lists a wrong outcome and unexpected nearby suggestion", () => {
    expect(scoreRecordCase(testCase, result([cite]), null, [], keyOf).misses).toEqual([]);

    const wrong = scoreRecordCase(
      testCase,
      result([
        {
          ...cite,
          outcome: "not-found",
          nearby: {
            location: { kind: "page", from: 4, to: 4 },
            pageFrom: 4,
            pageTo: 4,
            passage: "Unkeyed suggestion",
          },
        },
      ]),
      null,
      [],
      keyOf,
    );

    expect(wrong.misses).toHaveLength(1);
    expect(wrong.misses[0]?.reasons).toEqual(
      expect.arrayContaining(["not-found instead of supported", "unexpected nearby suggestion"]),
    );
    expect(wrong.misses[0]?.actual?.outcome).toBe("not-found");
  });
});
