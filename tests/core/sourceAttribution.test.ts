import { describe, expect, test } from "vitest";
import { sourceAttribution, sourceNameIn } from "../../src/core/answers/checks/sourceAttribution";
import type { CitationAttributes } from "../../src/core/api";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const citation = (documentId: string | null, documentName = "Atlas"): CitationAttributes => ({
  passageId: "checked-passage",
  documentId,
  documentName,
  contentHash: "checked-version",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "page", from: 1, to: 1 },
  quote: "Revenue was 10.",
  check: "found",
  checkReason: null,
});
const CASES = [
  {
    language: "en",
    words: "According to Atlas 2024",
    sourceName: "Atlas 2024",
    other: "Atlas 2023",
    normalized: "ＡＴＬＡＳ   ２０２４",
  },
  {
    language: "zh-CN",
    words: "据《年度报告2024》",
    sourceName: "年度报告2024",
    other: "年度报告2023",
    normalized: "年度 报告２０２４",
  },
];

describe.each(CASES)(
  "$language exact named Source guard",
  ({ words, sourceName, other, normalized }) => {
    const documents = [
      { id: A, name: sourceName },
      { id: C, name: other },
    ];
    test("passes only the unique exact title with its actual quote owner", () => {
      expect(sourceAttribution({ words, sourceName, documents, evidence: [citation(A)] })).toEqual({
        facet: { kind: "source" },
        outcome: null,
        candidates: [{ id: A, name: sourceName }],
        document: { id: A, name: sourceName },
      });
    });
    test("uses the existing normalizer and full title equality", () => {
      expect(
        sourceAttribution({ words, sourceName: normalized, documents, evidence: [citation(A)] })
          ?.outcome,
      ).toBeNull();
      expect(sourceNameIn(words, normalized)).toBe(true);
    });
    test("a wrong-year Source and equal value cannot resolve the named title", () => {
      expect(
        sourceAttribution({
          words,
          sourceName,
          documents: [{ id: C, name: other }],
          evidence: [citation(C, other)],
        }),
      ).toEqual({
        facet: { kind: "source" },
        outcome: "missing",
        candidates: [],
        document: null,
      });
    });
    test("does not accept a longer catalogue title as a fuzzy match", () => {
      expect(
        sourceAttribution({
          words,
          sourceName,
          documents: [{ id: C, name: `${sourceName} appendix` }],
          evidence: [citation(C)],
        })?.outcome,
      ).toBe("missing");
    });
    test("duplicate titles return every UUID and never infer selection from a quote", () => {
      expect(
        sourceAttribution({
          words,
          sourceName,
          documents: [
            { id: A, name: sourceName },
            { id: B, name: normalized },
          ],
          evidence: [citation(B)],
        }),
      ).toEqual({
        facet: { kind: "source" },
        outcome: "ambiguous",
        candidates: [
          { id: A, name: sourceName },
          { id: B, name: normalized },
        ],
        document: null,
      });
    });
    test("remembered B selects actual B among duplicate names", () => {
      expect(
        sourceAttribution({
          words,
          sourceName,
          selectedDocumentId: B,
          documents: [
            { id: A, name: sourceName },
            { id: B, name: sourceName },
          ],
          evidence: [citation(B)],
        }),
      ).toEqual({
        facet: { kind: "source", selectedDocumentId: B },
        outcome: null,
        candidates: [
          { id: A, name: sourceName },
          { id: B, name: sourceName },
        ],
        document: { id: B, name: sourceName },
      });
    });
    test("remembered B rejects a same-name A quote", () => {
      expect(
        sourceAttribution({
          words,
          sourceName,
          selectedDocumentId: B,
          documents: [
            { id: A, name: sourceName },
            { id: B, name: sourceName },
          ],
          evidence: [citation(A)],
        }),
      ).toMatchObject({
        facet: { selectedDocumentId: B },
        outcome: "other",
        document: { id: A, name: sourceName },
      });
    });
    test.each(["deleted", "out-of-scope", "renamed"] as const)(
      "%s B clears the selection and never falls back to remaining A",
      (mode) => {
        const live =
          mode === "renamed"
            ? [
                { id: A, name: sourceName },
                { id: B, name: other },
              ]
            : [{ id: A, name: sourceName }];
        expect(
          sourceAttribution({
            words,
            sourceName,
            selectedDocumentId: B,
            documents: live,
            evidence: [citation(A)],
          }),
        ).toEqual({
          facet: { kind: "source" },
          outcome: "choose-again",
          candidates: [{ id: A, name: sourceName }],
          document: null,
        });
      },
    );
    test("a valid selected Source survives when no quote was found", () => {
      expect(
        sourceAttribution({ words, sourceName, selectedDocumentId: A, documents, evidence: [] }),
      ).toMatchObject({
        facet: { kind: "source", selectedDocumentId: A },
        outcome: null,
        document: { id: A, name: sourceName },
      });
    });
    test("a correct heading quote cannot rescue a fact quote from another Document", () => {
      expect(
        sourceAttribution({
          words,
          sourceName,
          documents,
          evidence: [citation(A), citation(C, other)],
        }),
      ).toMatchObject({ outcome: "other", document: { id: C, name: other } });
    });
    test("wrong evidence order still identifies the first actual wrong Document", () => {
      expect(
        sourceAttribution({
          words,
          sourceName,
          documents,
          evidence: [citation(C, other), citation(A)],
        }),
      ).toMatchObject({ outcome: "other", document: { id: C, name: other } });
    });
    test.each([B, null])(
      "unknown or unscoped quote owner %j cannot leak its supplied name",
      (documentId) => {
        const result = sourceAttribution({
          words,
          sourceName,
          documents,
          evidence: [citation(A), citation(documentId, "Private outside title")],
        });
        expect(result).toMatchObject({ outcome: "other", document: null });
        expect(JSON.stringify(result)).not.toContain("Private outside title");
      },
    );
    test("an unread live Document remains a catalogue candidate without invented quote proof", () => {
      expect(sourceAttribution({ words, sourceName, documents, evidence: [] })).toMatchObject({
        outcome: null,
        candidates: [{ id: A, name: sourceName }],
      });
    });
    test("a source name absent from the literal target is malformed", () => {
      expect(
        sourceAttribution({ words, sourceName: other, documents, evidence: [citation(C)] }),
      ).toBeNull();
      expect(sourceNameIn(words, other)).toBe(false);
    });
  },
);

describe("literal Source names are not guessed", () => {
  test.each(["", " ", "\u200b"])("refuses an empty normalized title %j", (sourceName) => {
    expect(sourceNameIn("According to Atlas", sourceName)).toBe(false);
    expect(
      sourceAttribution({
        words: "According to Atlas",
        sourceName,
        documents: [{ id: A, name: "Atlas" }],
        evidence: [citation(A)],
      }),
    ).toBeNull();
  });
  test("returns only the catalogue identity fields", () => {
    const document = { id: A, name: "Atlas", localPath: "private-path" };
    const result = sourceAttribution({
      words: "According to Atlas",
      sourceName: "Atlas",
      documents: [document],
      evidence: [citation(A)],
    });
    expect(result?.document).toEqual({ id: A, name: "Atlas" });
    expect(result?.candidates).toEqual([{ id: A, name: "Atlas" }]);
    expect(JSON.stringify(result)).not.toContain("private-path");
  });
});

describe("normalized Source names keep original lexical boundaries", () => {
  test.each([
    ["According to Atlastic", "Atlas"],
    ["According to Atlas2024", "Atlas"],
    ["据20240年报告", "2024"],
    ["According to ÉAtlas", "Atlas"],
    ["According to AtlasÉ", "Atlas"],
    ["According to e\u0301Atlas", "Atlas"],
    ["According to Atlase\u0301", "Atlas"],
    ["据《ﬁ》", "f"],
  ])("refuses a partial title %s / %s", (words, name) => {
    expect(sourceNameIn(words, name)).toBe(false);
    expect(
      sourceAttribution({
        words,
        sourceName: name,
        documents: [{ id: A, name }],
        evidence: [citation(A)],
      }),
    ).toBeNull();
  });
  test.each([
    ["According to the Atlas", "Atlas"],
    ["据 the Atlas 报告", "Atlas"],
    ["据《ＡＴＬＡＳ》", "Atlas"],
    ["According to Atlastic, then Atlas", "Atlas"],
    ["据20240及2024报告", "2024"],
    ["According to Åland", "Åland"],
    ["据《e\u0301tude》", "étude"],
    ["据Atlas报告", "Atlas"],
    ["根据年度报告数据", "年度报告"],
  ])("binds a complete title at its raw span %s / %s", (words, name) => {
    expect(sourceNameIn(words, name)).toBe(true);
    expect(
      sourceAttribution({
        words,
        sourceName: name,
        documents: [{ id: A, name }],
        evidence: [citation(A)],
      })?.outcome,
    ).toBeNull();
  });
});
