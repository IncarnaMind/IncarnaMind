import { describe, expect, test } from "vitest";
import { resolveDeposition } from "../../src/core/documents/deposition";
import { parseRecordCite } from "../../src/core/recordCites/parser";
import type { RecordCiteDocument } from "../../src/core/recordCites/resolver";
import { resolveChosenRecordCite, resolveRecordCites } from "../../src/core/recordCites/resolver";

const choices = { previous: null, choices: {} };

const document = (units: RecordCiteDocument["units"]): RecordCiteDocument => ({
  id: "exhibit-7",
  name: "Exhibit 7.pdf",
  contentHash: "hash-exhibit-7",
  units,
});

describe("record-cite source resolution", () => {
  test("maps an exhibit's printed page to its physical Unit and exact passage", () => {
    const source = document([
      { page: 1, kind: "page", label: { printed: "1" }, text: "Repeated text" },
      { page: 4, kind: "page", label: { printed: "3" }, text: "Exact page" },
      { page: 5, kind: "page", label: { printed: "4" }, text: "Repeated text" },
    ]);

    expect(
      resolveRecordCites({ cites: [parseRecordCite("Ex. 7 at 3")], documents: [source], choices }),
    ).toEqual([
      {
        raw: "Ex. 7 at 3",
        outcome: "supported",
        documentId: "exhibit-7",
        documentName: "Exhibit 7.pdf",
        contentHash: "hash-exhibit-7",
        location: { kind: "page", from: 4, to: 4, printed: { from: "3", to: "3" } },
        pageFrom: 4,
        pageTo: 4,
        passage: "Exact page",
        nearby: {
          location: {
            kind: "page",
            from: 5,
            to: 5,
            printed: { from: "4", to: "4" },
          },
          pageFrom: 5,
          pageTo: 5,
          passage: "Repeated text",
        },
      },
    ]);
  });

  test("maps an ECF entry's printed page to its physical Unit", () => {
    const source = {
      ...document([{ page: 2, label: { printed: "5" }, text: "Docket page" }]),
      id: "ecf-41",
      name: "ECF No. 41.pdf",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("ECF No. 41 at 5")],
        documents: [source],
        choices,
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        documentId: "ecf-41",
        location: { kind: "page", from: 2, to: 2, printed: { from: "5", to: "5" } },
        pageFrom: 2,
        pageTo: 2,
        passage: "Docket page",
      },
    ]);
  });

  test("uses the physical page number when no distinct printed label is stored", () => {
    const source = document([{ page: 3, label: null, text: "Ordinary page" }]);
    expect(
      resolveRecordCites({ cites: [parseRecordCite("Ex. 7 at 3")], documents: [source], choices }),
    ).toMatchObject([
      {
        outcome: "supported",
        location: { kind: "page", from: 3, to: 3, printed: { from: "3", to: "3" } },
        passage: "Ordinary page",
      },
    ]);
  });

  test("returns every duplicate candidate instead of silently taking the first", () => {
    const first = document([{ page: 3, label: { printed: "3" }, text: "First" }]);
    const second = {
      ...document([{ page: 3, label: { printed: "3" }, text: "Second" }]),
      id: "exhibit-7-copy",
      contentHash: "hash-exhibit-7-copy",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Ex. 7 at 3")],
        documents: [first, second],
        choices,
      }),
    ).toEqual([
      {
        raw: "Ex. 7 at 3",
        outcome: "choose",
        candidates: [
          { id: "exhibit-7", name: "Exhibit 7.pdf" },
          { id: "exhibit-7-copy", name: "Exhibit 7.pdf" },
        ],
      },
    ]);
  });

  test("uses a saved choice by normalized alias and exact physical Location", () => {
    const first = document([{ page: 4, label: { printed: "3" }, text: "First" }]);
    const second = {
      ...document([{ page: 6, label: { printed: "3" }, text: "Chosen" }]),
      id: "chosen",
      contentHash: "hash-chosen",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Ex. 7 at 3")],
        documents: [first, second],
        choices: {
          previous: null,
          choices: {
            "  EX   7 ": {
              documentId: "chosen",
              location: {
                kind: "page",
                from: 6,
                to: 6,
                printed: { from: "3", to: "3" },
              },
            },
          },
        },
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        documentId: "chosen",
        location: { kind: "page", from: 6, to: 6, printed: { from: "3", to: "3" } },
        passage: "Chosen",
      },
    ]);
  });

  test("drops a deleted saved choice rather than substituting the remaining Document", () => {
    const remaining = document([{ page: 4, label: { printed: "3" }, text: "Remaining" }]);
    const result = resolveRecordCites({
      cites: [parseRecordCite("Ex. 7 at 3")],
      documents: [remaining],
      choices: {
        previous: null,
        choices: {
          "ex 7": {
            documentId: "deleted",
            location: { kind: "page", from: 9, to: 9 },
          },
        },
      },
    });

    expect(result).toEqual([
      {
        raw: "Ex. 7 at 3",
        outcome: "choose",
        candidates: [{ id: "exhibit-7", name: "Exhibit 7.pdf" }],
      },
    ]);
  });

  test("a deleted sole saved choice is not-found, not an empty picker", () => {
    const result = resolveRecordCites({
      cites: [parseRecordCite("Ex. 7 at 3")],
      documents: [],
      choices: {
        previous: null,
        choices: {
          "ex 7": {
            documentId: "deleted",
            location: { kind: "page", from: 9, to: 9 },
          },
        },
      },
    });

    expect(result).toEqual([{ raw: "Ex. 7 at 3", outcome: "not-found" }]);
  });

  test("invalidates a saved choice whose printed page changed", () => {
    const changed = document([{ page: 4, label: { printed: "amended" }, text: "Changed" }]);
    const result = resolveRecordCites({
      cites: [parseRecordCite("Ex. 7 at 3")],
      documents: [changed],
      choices: {
        previous: null,
        choices: {
          "ex 7": {
            documentId: "exhibit-7",
            location: {
              kind: "page",
              from: 4,
              to: 4,
              printed: { from: "3", to: "3" },
            },
          },
        },
      },
    });

    expect(result).toEqual([{ raw: "Ex. 7 at 3", outcome: "not-found" }]);
  });

  test("finds an exact Bates identifier without losing its prefix or leading zeros", () => {
    const source = {
      ...document([
        { page: 1, text: "PL-123 and PL-0001234 are different identifiers" },
        { page: 7, text: "PL-000123\nExact Bates page" },
      ]),
      id: "production",
      name: "Production.pdf",
      contentHash: "hash-production",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("PL-000123")],
        documents: [source],
        choices,
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        documentId: "production",
        location: { kind: "page", from: 7, to: 7, printed: { from: "PL 000123", to: "PL 000123" } },
        pageFrom: 7,
        pageTo: 7,
        passage: "PL-000123\nExact Bates page",
      },
    ]);
  });

  test("a Bates identifier with a trailing letter is a different identifier", () => {
    const source = {
      ...document([{ page: 7, text: "PL-000123A\nDifferent Bates page" }]),
      id: "production",
      name: "Production.pdf",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("PL-000123")],
        documents: [source],
        choices,
      }),
    ).toEqual([{ raw: "PL-000123", outcome: "not-found" }]);
  });

  test("resolves every exact Bates page in a five-page range", () => {
    const source = {
      ...document(
        Array.from({ length: 5 }, (_, index) => ({
          page: index + 8,
          text: `DEF ${String(index + 45).padStart(4, "0")}\nPage ${index + 45}`,
        })),
      ),
      id: "def-production",
      name: "Defendant production.pdf",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("DEF 0045–0049")],
        documents: [source],
        choices,
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        documentId: "def-production",
        pageFrom: 8,
        pageTo: 12,
        passage:
          "DEF 0045\nPage 45\nDEF 0046\nPage 46\nDEF 0047\nPage 47\nDEF 0048\nPage 48\nDEF 0049\nPage 49",
      },
    ]);
  });

  test("does not rescue an incomplete Bates range from its endpoints or the whole Document", () => {
    const source = {
      ...document([
        { page: 8, text: "DEF 0045\nStart" },
        { page: 9, text: "Unrelated text" },
        { page: 10, text: "DEF 0047 appears here, but two identifiers are absent" },
        { page: 11, text: "DEF 0049\nEnd" },
      ]),
      name: "DEF production.pdf",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("DEF 0045–0049")],
        documents: [source],
        choices,
      }),
    ).toEqual([{ raw: "DEF 0045–0049", outcome: "not-found" }]);
  });

  test("cuts a legal paragraph between explicit printed source labels", () => {
    const source = {
      ...document([
        {
          page: 5,
          text: "¶ 13 Previous\n¶ 14 Target begins\nand continues here\n¶ 15 Next",
        },
      ]),
      id: "complaint",
      name: "Complaint.pdf",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Compl. ¶ 14")],
        documents: [source],
        choices,
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        documentId: "complaint",
        location: { kind: "section", heading: null, paragraphs: { from: 14, to: 14 } },
        pageFrom: 5,
        pageTo: 5,
        passage: "¶ 14 Target begins\nand continues here",
      },
    ]);
  });

  test("keeps a numbered legal paragraph range exact across a page break", () => {
    const source = {
      ...document([
        { page: 2, text: "2. Previous\n3. Three\ncontinued" },
        { page: 3, text: "4. Four\n5. Five\n6. Six" },
      ]),
      id: "smith-declaration",
      name: "Smith Declaration.pdf",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Smith Decl. ¶¶ 3–5")],
        documents: [source],
        choices,
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        documentId: "smith-declaration",
        location: { kind: "section", heading: null, paragraphs: { from: 3, to: 5 } },
        pageFrom: 2,
        pageTo: 3,
        passage: "3. Three\ncontinued\n4. Four\n5. Five",
      },
    ]);
  });

  test("does not turn generated paragraph anchors into printed legal labels", () => {
    const source = {
      ...document([
        {
          page: 1,
          text: "Paragraph text without a printed number",
          anchors: [{ start: 0, end: 37, target: "p14" }],
        },
      ]),
      name: "Complaint.pdf",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Compl. ¶ 14")],
        documents: [source],
        choices,
      }),
    ).toEqual([{ raw: "Compl. ¶ 14", outcome: "not-found" }]);
  });

  test("reads recording times from existing cues, not page text", () => {
    const first = "Alice: Repeated text";
    const second = "Bob: Exact answer";
    const third = "Alice: Repeated text";
    const text = [first, second, third].join("\n");
    const secondStart = first.length + 1;
    const thirdStart = secondStart + second.length + 1;
    const source = {
      ...document([
        {
          page: 1,
          kind: "cues" as const,
          label: { from: 730_000, to: 755_000, speakers: ["Alice", "Bob", "Alice"] },
          text,
          anchors: [
            { start: 0, end: first.length, target: "t730000-735000" },
            {
              start: secondStart,
              end: secondStart + second.length,
              target: "t740000-745000",
            },
            {
              start: thirdStart,
              end: thirdStart + third.length,
              target: "t750000-755000",
            },
          ],
        },
      ]),
      id: "recording",
      name: "Recording.vtt",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("12:20")],
        documents: [
          { ...document([{ page: 1, text: "12:20 is only page text" }]), id: "not-a-recording" },
          source,
        ],
        choices,
      }),
    ).toEqual([
      {
        raw: "12:20",
        outcome: "supported",
        documentId: "recording",
        documentName: "Recording.vtt",
        contentHash: "hash-exhibit-7",
        location: { kind: "time", from: 740_000, to: 745_000, speaker: "Bob" },
        passage: "Bob: Exact answer",
      },
    ]);
  });

  test("keeps a recording range on its overlapping cues", () => {
    const first = "First";
    const second = "Second";
    const text = `${first}\n${second}`;
    const source = {
      ...document([
        {
          page: 1,
          kind: "cues" as const,
          text,
          anchors: [
            { start: 0, end: first.length, target: "t740000-745000" },
            { start: first.length + 1, end: text.length, target: "t750000-755000" },
          ],
        },
      ]),
      id: "recording-range",
      name: "Recording.vtt",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("12:20–12:35")],
        documents: [source],
        choices,
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        location: { kind: "time", from: 740_000, to: 755_000 },
        passage: "First\nSecond",
      },
    ]);
  });

  test("Id. at N uses the previous deposition's printed page map", () => {
    const source = {
      ...document([
        { page: 1, kind: "page" as const, text: "Page 45\n3 A. Deposition answer." },
        { page: 2, kind: "page" as const, text: "Page 46\n1 Q. Next?\n2 A. Whole page." },
      ]),
      id: "smith-deposition",
      name: "Smith Deposition.pdf",
    };

    const results = resolveRecordCites({
      cites: [
        parseRecordCite("Smith Dep. 45:3–3"),
        parseRecordCite("Id. at 46", { hasPrevious: true }),
      ],
      documents: [source],
      choices,
      resolveDeposition,
    });

    expect(results[1]).toMatchObject({
      raw: "Id. at 46",
      outcome: "supported",
      documentId: "smith-deposition",
      location: {
        kind: "page",
        from: 2,
        to: 2,
        printed: { from: "46", to: "46" },
        lines: { from: 1, to: 2 },
      },
      pageFrom: 2,
      pageTo: 2,
      passage: "Q. Next?\nA. Whole page.",
    });
  });

  test("chains Id., Id. at a new printed page, and supra through the previous item", () => {
    const source = document([
      { page: 4, label: { printed: "3" }, text: "Three" },
      { page: 9, label: { printed: "7" }, text: "Seven" },
    ]);
    const results = resolveRecordCites({
      cites: [
        parseRecordCite("Ex. 7 at 3"),
        parseRecordCite("Id.", { hasPrevious: true }),
        parseRecordCite("Id. at 7", { hasPrevious: true }),
        parseRecordCite("supra", { hasPrevious: true }),
      ],
      documents: [source],
      choices,
    });

    expect(results.map((result) => [result.outcome, result.pageFrom, result.passage])).toEqual([
      ["supported", 4, "Three"],
      ["supported", 4, "Three"],
      ["supported", 9, "Seven"],
      ["supported", 9, "Seven"],
    ]);
    expect(results[2]).toMatchObject({
      documentId: "exhibit-7",
      location: { kind: "page", from: 9, to: 9, printed: { from: "7", to: "7" } },
    });
  });

  test("does not invent an Id. referent before a record item or after an ambiguous one", () => {
    const source = document([{ page: 4, label: { printed: "3" }, text: "Three" }]);
    const duplicate = { ...source, id: "duplicate" };
    const results = resolveRecordCites({
      cites: [
        parseRecordCite("Id.", { hasPrevious: true }),
        parseRecordCite("Ex. 7 at 3"),
        parseRecordCite("supra", { hasPrevious: true }),
      ],
      documents: [source, duplicate],
      choices,
    });

    expect(results).toMatchObject([
      { raw: "Id.", outcome: "not-found" },
      { raw: "Ex. 7 at 3", outcome: "choose" },
      { raw: "supra", outcome: "not-found" },
    ]);
  });

  test("restores an isolated Id. from the saved previous record item", () => {
    const source = document([{ page: 4, label: { printed: "3" }, text: "Previous" }]);
    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Id.", { hasPrevious: true })],
        documents: [source],
        choices: {
          previous: {
            documentId: "exhibit-7",
            location: {
              kind: "page",
              from: 4,
              to: 4,
              printed: { from: "3", to: "3" },
            },
          },
          choices: {},
        },
      }),
    ).toMatchObject([
      { outcome: "supported", documentId: "exhibit-7", pageFrom: 4, passage: "Previous" },
    ]);
  });

  test("delegates deposition mapping to the injected mapper", () => {
    const source = {
      ...document([{ page: 8, text: "Physical page 8" }]),
      id: "smith-deposition",
      name: "Smith Deposition.pdf",
    };
    const calls: { documentId: string; from: number; to: number }[] = [];
    const result = resolveRecordCites({
      cites: [parseRecordCite("Smith Dep. 45:3–46:2")],
      documents: [source],
      choices,
      resolveDeposition: (units, location) => {
        calls.push({
          documentId: units === source.units ? "smith-deposition" : "wrong",
          from: location.from,
          to: location.to,
        });
        return {
          status: "found",
          location: {
            kind: "page",
            from: 8,
            to: 9,
            printed: { from: "45", to: "46" },
            lines: { from: 3, to: 2 },
          },
          units: [
            { page: 8, text: "Exact lines" },
            { page: 9, text: "across the page break" },
          ],
        };
      },
    });

    expect(calls[0]).toEqual({ documentId: "smith-deposition", from: 45, to: 46 });
    expect(calls.length).toBeGreaterThan(1);
    expect(result).toMatchObject([
      {
        raw: "Smith Dep. 45:3–46:2",
        outcome: "supported",
        documentId: "smith-deposition",
        documentName: "Smith Deposition.pdf",
        contentHash: "hash-exhibit-7",
        location: {
          kind: "page",
          from: 8,
          to: 9,
          printed: { from: "45", to: "46" },
          lines: { from: 3, to: 2 },
        },
        pageFrom: 8,
        pageTo: 9,
        passage: "Exact lines\nacross the page break",
      },
    ]);
  });

  test("offers the exact next deposition lines as a nearby candidate", () => {
    const source = {
      ...document([
        {
          page: 4,
          kind: "page" as const,
          text: "Page 45\n1 Q. First?\n2 A. Yes.\n3 The nearby fact.",
        },
        { page: 5, kind: "page" as const, text: "Page 46\n1 Later text" },
      ]),
      id: "smith-deposition",
      name: "Smith Deposition.pdf",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Smith Dep. 45:1–2")],
        documents: [source],
        choices,
        resolveDeposition,
      })[0]?.nearby,
    ).toEqual({
      location: {
        kind: "page",
        from: 4,
        to: 4,
        printed: { from: "45", to: "45" },
        lines: { from: 3, to: 3 },
      },
      pageFrom: 4,
      pageTo: 4,
      passage: "The nearby fact.",
    });
  });

  test("does not invent a parallel deposition map when no mapper is injected", () => {
    const source = {
      ...document([{ page: 45, label: { printed: "45" }, text: "3 Wrong fallback" }]),
      name: "Smith Deposition.pdf",
    };
    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Smith Dep. 45:3–12")],
        documents: [source],
        choices,
      }),
    ).toEqual([{ raw: "Smith Dep. 45:3–12", outcome: "not-found" }]);
  });

  test("honors a saved Bates Document choice instead of asking again", () => {
    const first = {
      ...document([{ page: 7, text: "PL-000123\nFirst" }]),
      id: "first-production",
      name: "First production.pdf",
    };
    const second = {
      ...document([{ page: 11, text: "PL-000123\nChosen" }]),
      id: "chosen-production",
      name: "Second production.pdf",
      contentHash: "hash-chosen-production",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("PL-000123")],
        documents: [first, second],
        choices: {
          previous: null,
          choices: {
            pl: {
              documentId: "chosen-production",
              location: {
                kind: "page",
                from: 11,
                to: 11,
                printed: { from: "PL 000123", to: "PL 000123" },
              },
            },
          },
        },
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        documentId: "chosen-production",
        contentHash: "hash-chosen-production",
        pageFrom: 11,
        passage: "PL-000123\nChosen",
      },
    ]);
  });

  test("honors a saved legal-paragraph Document choice", () => {
    const first = {
      ...document([{ page: 5, text: "¶ 14 First" }]),
      id: "first-complaint",
      name: "Complaint.pdf",
    };
    const second = {
      ...document([{ page: 8, text: "¶ 14 Chosen" }]),
      id: "chosen-complaint",
      name: "Complaint copy.pdf",
    };

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Compl. ¶ 14")],
        documents: [first, second],
        choices: {
          previous: null,
          choices: {
            compl: {
              documentId: "chosen-complaint",
              location: { kind: "section", heading: null, paragraphs: { from: 14, to: 14 } },
            },
          },
        },
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        documentId: "chosen-complaint",
        pageFrom: 8,
        passage: "¶ 14 Chosen",
      },
    ]);
  });

  test("revalidates a saved deposition Location through the injected mapper", () => {
    const source = { ...document([]), id: "smith-deposition", name: "Smith Deposition.pdf" };
    const savedLocation = {
      kind: "page" as const,
      from: 8,
      to: 8,
      printed: { from: "45", to: "45" },
      lines: { from: 3, to: 12 },
    };
    const calls: number[] = [];

    expect(
      resolveRecordCites({
        cites: [parseRecordCite("Smith Dep. 45:3–12")],
        documents: [source],
        choices: {
          previous: null,
          choices: { "smith dep": { documentId: "smith-deposition", location: savedLocation } },
        },
        resolveDeposition: (_units, location) => {
          calls.push(location.from);
          return {
            status: "found",
            location,
            units: [{ page: location.from, text: "Saved exact lines" }],
          };
        },
      }),
    ).toMatchObject([
      {
        outcome: "supported",
        documentId: "smith-deposition",
        location: savedLocation,
        passage: "Saved exact lines",
      },
    ]);
    expect(calls[0]).toBe(8);
    expect(calls.length).toBeGreaterThan(1);
  });

  test("resolves a chosen candidate by stable id even when its name does not match the alias", () => {
    const renamed = {
      ...document([{ page: 5, label: { printed: "5" }, text: "Chosen filing" }]),
      id: "chosen-docket",
      name: "Duplicate filing.pdf",
    };

    expect(resolveChosenRecordCite(parseRecordCite("Dkt. 41 at 5"), renamed)).toMatchObject({
      raw: "Dkt. 41 at 5",
      outcome: "supported",
      documentId: "chosen-docket",
      documentName: "Duplicate filing.pdf",
      pageFrom: 5,
      passage: "Chosen filing",
    });
  });

  test("turns parser failures into not-found results", () => {
    expect(
      resolveRecordCites({
        cites: [parseRecordCite("not a cite")],
        documents: [],
        choices,
      }),
    ).toEqual([{ raw: "not a cite", outcome: "not-found" }]);
  });
});
