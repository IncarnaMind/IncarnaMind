import { describe, expect, test } from "vitest";
import {
  sourceAttribution,
  sourceNameIn,
  sourceNameSpan,
} from "../../src/core/answers/checks/sourceAttribution";
import type { CitationAttributes } from "../../src/core/api";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel } from "../helpers/models";

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
    const named = {
      start: words.indexOf(sourceName),
      end: words.indexOf(sourceName) + sourceName.length,
    };
    test("passes only the unique exact title with its actual quote owner", () => {
      expect(sourceAttribution({ words, sourceName, documents, evidence: [citation(A)] })).toEqual({
        named,
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
        named,
        facet: { kind: "source" },
        outcome: "other",
        candidates: [],
        document: { id: C, name: other },
      });
    });
    test("a longer title needs its own checked binding, never fuzzy-first selection", () => {
      expect(
        sourceAttribution({
          words,
          sourceName,
          documents: [{ id: C, name: `${sourceName} appendix` }],
          evidence: [],
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
        named,
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
        named,
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
          named,
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

describe("descriptive references use only their checked scoped owner", () => {
  test.each([
    ["The lease says", "lease", "Employment agreement"],
    ["该租约规定", "租约", "劳动协议"],
  ])("a descriptive %s can bind the scoped checked Document", (words, sourceName, title) => {
    expect(
      sourceAttribution({
        words,
        sourceName,
        documents: [{ id: B, name: title }],
        evidence: [citation(B)],
      }),
    ).toEqual({
      named: {
        start: words.indexOf(sourceName),
        end: words.indexOf(sourceName) + sourceName.length,
      },
      facet: { kind: "source" },
      outcome: null,
      candidates: [],
      document: { id: B, name: title },
    });
    expect(
      sourceAttribution({ words, sourceName, documents: [{ id: B, name: title }], evidence: [] })
        ?.outcome,
    ).toBe("missing");
  });
  test.each([
    ["According to the 2024 Annual Report", "2024 Annual Report", "Annual Report 2023"],
    ["据2024年报", "2024年报", "2023年度报告"],
  ])("a number in %s cannot be borrowed from another title", (words, sourceName, title) => {
    expect(
      sourceAttribution({
        words,
        sourceName,
        documents: [{ id: B, name: title }],
        evidence: [citation(B)],
      }),
    ).toMatchObject({ outcome: "other", candidates: [], document: { id: B, name: title } });
  });
  test.each([
    ["According to the March 2024 report", "March 2024 report", "The statement covers April 2024."],
    ["据2024年3月报告", "2024年3月报告", "这份说明覆盖2024年4月。"],
  ])("full date semantics in %s do not collapse to numeric sets", (words, sourceName, quote) => {
    expect(
      sourceAttribution({
        words,
        sourceName,
        documents: [{ id: B, name: "Monthly statement" }],
        evidence: [{ ...citation(B), quote }],
      }),
    ).toMatchObject({ outcome: "other", document: { id: B, name: "Monthly statement" } });
  });
  test("mixed checked Document owners cannot become a first-Citation binding", () => {
    expect(
      sourceAttribution({
        words: "The lease says",
        sourceName: "lease",
        documents: [
          { id: A, name: "Employment agreement" },
          { id: B, name: "Property agreement" },
        ],
        evidence: [citation(A), citation(B)],
      }),
    ).toBeNull();
  });
});

describe("public Core descriptive Source attribution", () => {
  test.each([
    {
      language: "en",
      words: "The lease says",
      sourceName: "lease",
      fact: "the tenant may terminate.",
      title: "Employment agreement",
      quote: "The tenant may terminate.",
      expected: "supported",
    },
    {
      language: "zh-CN",
      words: "该租约规定",
      sourceName: "租约",
      fact: "承租人可以解约。",
      title: "劳动协议",
      quote: "承租人可以解约。",
      expected: "supported",
    },
    {
      language: "en",
      words: "According to the 2024 Annual Report",
      sourceName: "2024 Annual Report",
      fact: "revenue was £12 million.",
      title: "Annual Report 2023",
      quote: "In 2023, revenue was £12 million.",
      expected: "unsupported",
    },
    {
      language: "zh-CN",
      words: "据2024年报",
      sourceName: "2024年报",
      fact: "营收为1200万元。",
      title: "2023年度报告",
      quote: "2023年，营收为1200万元。",
      expected: "unsupported",
    },
  ] as const)("$language $sourceName binds only its actual checked Source", async (row) => {
    const claim = `${row.words}${row.language === "en" ? ", " : "，"}${row.fact}`;
    const frames: ModelCall[] = [];
    const model = scriptedModel((call) => {
      frames.push(call);
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return {
          text: `Parts: ${JSON.stringify([
            { kind: "fact", text: row.words, facet: { kind: "source" } },
            { kind: "fact", text: row.fact },
          ])}`,
          calls: [{ tool: "search_documents", input: { query: row.quote } }],
        };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(search.text).find((candidate) =>
          candidate.text.includes(row.quote),
        );
        if (!passage)
          throw new Error("The descriptive Source fixture's actual quote was not found.");
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, quote: row.quote }] },
            },
          ],
        };
      }
      return {
        text: [
          "Verdict: supported",
          "Scope: none, same",
          "Topic: found",
          "Roles: none, same",
          "Calculation: none",
          "Evidence: [1]",
          `${row.quote} [^1]`,
          `Facets: ${JSON.stringify({ items: [{ text: row.words, sourceName: row.sourceName, kind: "source", occurrence: 1, verdict: "supported", scope: "same", topic: "found", roles: "same", says: row.quote, evidence: [1] }] })}`,
        ].join("\n"),
      };
    });
    const { core } = await setUpWithDocuments(model, [], {
      now: manualClock("2026-10-30T12:00:00.000Z").now,
    });
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    const [document] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), `${row.title}.md`, row.quote),
    ]);
    if (!document) throw new Error("The descriptive Source fixture Document was not imported.");
    await core.updateSettings({ user: { language: row.language } });
    const before = model.doStreamCalls.length + model.doGenerateCalls.length;
    const result = await core.checkClaim({
      claim,
      scope: { folderIds: [], tagIds: [], documentIds: [document.id] },
    });
    expect(result.verdict).toBe(row.expected);
    const source = result.parts?.find((part) => part.facet?.kind === "source");
    expect(source).toMatchObject({
      verdict: row.expected,
      evidence: [
        {
          documentId: document.id,
          contentHash: document.contentHash,
          quote: row.quote,
          check: "found",
        },
      ],
    });
    expect(result.parts?.find((part) => !part.facet)?.verdict).toBe("supported");
    expect(model.doStreamCalls.length + model.doGenerateCalls.length - before).toBe(3);
    expect(frames).toHaveLength(3);
  });
});

describe("named Source offset utility", () => {
  test.each([
    ["The lease says", "lease", 4, 9],
    ["😀据《ＡＴＬＡＳ》", "Atlas", 4, 9],
    ["据《e\u0301tude》", "étude", 2, 8],
    ["Atlastic then Atlas", "Atlas", 14, 19],
  ] as const)("returns the actual raw named title in %s", (words, name, start, end) => {
    expect(sourceNameSpan(words, name)).toEqual({ start, end });
  });
  test("keeps ANY matching semantics for repeated speaker/name proof", () => {
    expect(sourceNameIn("Atlas and Atlas", "Atlas")).toBe(true);
    expect(sourceNameSpan("Atlas and Atlas", "Atlas")).toBeNull();
    expect(
      sourceAttribution({
        words: "Atlas and Atlas",
        sourceName: "Atlas",
        documents: [{ id: A, name: "Atlas" }],
        evidence: [citation(A)],
      }),
    ).toBeNull();
  });
});

describe("descriptive number and title witnesses", () => {
  test.each([
    ["the 20% statement", "20% statement", "Coverage was 20.0%.", null],
    ["the 20% statement", "20% statement", "Coverage was 25%.", "other"],
    ["the 100% statement", "100% statement", "The ratio was 1.", "other"],
    ["the US$10 report", "US$10 report", "The amount was GBP10.", "other"],
    ["the US$1 million report", "US$1 million report", "The amount was USD1,000,000.", null],
  ] as const)("checks own base value and unit: %s / %s", (words, sourceName, quote, outcome) => {
    expect(
      sourceAttribution({
        words,
        sourceName,
        documents: [{ id: B, name: "Budget statement" }],
        evidence: [{ ...citation(B), quote }],
      })?.outcome,
    ).toBe(outcome);
  });
  test("an actual title may witness descriptive dates without becoming an exact display candidate", () => {
    expect(
      sourceAttribution({
        words: "the March 2024 report says",
        sourceName: "March 2024 report",
        documents: [{ id: B, name: "Board pack", title: "March 2024 report" }],
        evidence: [citation(B)],
      }),
    ).toMatchObject({ outcome: null, candidates: [], document: { id: B, name: "Board pack" } });
  });
  test("a hidden old title never rescues a renamed remembered UUID", () => {
    expect(
      sourceAttribution({
        words: "According to Atlas",
        sourceName: "Atlas",
        selectedDocumentId: B,
        documents: [{ id: B, name: "Renamed report", title: "Atlas" }],
        evidence: [citation(B)],
      }),
    ).toMatchObject({
      outcome: "choose-again",
      facet: { kind: "source" },
      candidates: [],
      document: null,
    });
  });
  test("a descriptive row requires an actual checked quote, not an empty or failed receipt", () => {
    for (const invalid of [
      { ...citation(B), check: "not-found" as const },
      { ...citation(B), quote: null },
      { ...citation(B), quote: "" },
    ]) {
      expect(
        sourceAttribution({
          words: "The lease says",
          sourceName: "lease",
          documents: [{ id: B, name: "Employment agreement" }],
          evidence: [invalid],
        }),
      ).toBeNull();
    }
  });
});

describe("descriptive reference readings stay strict", () => {
  test("an unresolved currency symbol cannot select its first numeric reading", () => {
    expect(
      sourceAttribution({
        words: "the ¥10 report says",
        sourceName: "¥10 report",
        documents: [{ id: B, name: "Budget statement" }],
        evidence: [{ ...citation(B), quote: "The amount was CNY10." }],
      })?.outcome,
    ).toBe("other");
  });
  test.each([
    ["the 1 March 2024 report says", "1 March 2024 report"],
    ["据2024年3月1日报告", "2024年3月1日报告"],
  ])("the same complete date can be stated in another format: %s", (words, sourceName) => {
    expect(
      sourceAttribution({
        words,
        sourceName,
        documents: [{ id: B, name: "Daily statement" }],
        evidence: [{ ...citation(B), quote: "On 2024-03-01, the rate was 5%." }],
      })?.outcome,
    ).toBeNull();
  });
});
