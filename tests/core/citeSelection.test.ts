/**
 * Words the User selects in a Document's viewer are cited where they were
 * selected (#101): checked in those pages only, never moved to the same words
 * on another page, and without the running header and footer a selection
 * across a page break takes in.
 */
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { docxOf } from "../helpers/office";
import { buildPdf, type PdfPage } from "../helpers/pdf";

const HEADER = "Ferrand and Moss, Rate cuts and retail margins";
const REPEATED = "Margins recover within two quarters of each cut.";

/** Pages with a running header and a page number, as a paper prints them. */
const paper = (bodies: readonly (readonly string[])[]) =>
  buildPdf(bodies.map((lines, index): PdfPage => ({ lines: [HEADER, ...lines, `${index + 1}`] })));

const BODIES = [
  ["Grocers studied across the eleven chains.", REPEATED],
  ["Pooling the cuts, the recovery peaks in the second quarter.", REPEATED],
  [
    "The effect is larger for grocers that fund their stock",
    "at floating rates, as Table 3 shows.",
  ],
  ["Smaller chains recovered less, about 0.2 points.", "Only three of them are in the panel."],
];

async function addPaper(core: Core, bytes = paper(BODIES), name = "Rate cuts.pdf") {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createSourceFolder(), name, bytes),
  ]);
  return document as Document;
}

describe("citeSelection", () => {
  test("cites the page the words were selected on, though the same words come first on another", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: 2, text: REPEATED, linesBefore: 2, linesAfter: 1 }],
    });

    expect(cited).toMatchObject({ check: "found", pageFrom: 2, pageTo: 2, quote: REPEATED });
    expect(cited.location).toEqual({ kind: "page", from: 2, to: 2 });
    // Asked to find the same words, the general check takes the first page that has them.
    const anywhere = await core.recheckCitation({
      documentId: document.id,
      quote: REPEATED,
      pageFrom: null,
      pageTo: null,
    });
    expect(anywhere.pageFrom).toBe(1);
  });

  // The page number "3" is in the page's text too, but not at its edge: it isn't taken for the words.
  test("across a page break, leaves out the footer and header selected with the words", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [
        {
          unit: 3,
          text: "at floating rates, as Table 3 shows.\n3",
          linesBefore: 2,
          linesAfter: 0,
        },
        {
          unit: 4,
          text: `${HEADER}\nSmaller chains recovered less,`,
          linesBefore: 0,
          linesAfter: 2,
        },
      ],
    });

    expect(cited).toMatchObject({
      check: "found",
      pageFrom: 3,
      pageTo: 4,
      quote: "at floating rates, as Table 3 shows. Smaller chains recovered less,",
    });
    expect(cited.location).toEqual({ kind: "page", from: 3, to: 4 });
  });

  test("a selection that reaches only the next page's header cites one page", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [
        {
          unit: 3,
          text: "The effect is larger for grocers that fund their stock\n",
          linesBefore: 1,
          linesAfter: 2,
        },
        { unit: 4, text: HEADER, linesBefore: 0, linesAfter: 3 },
      ],
    });

    expect(cited).toMatchObject({ check: "found", pageFrom: 3, pageTo: 3 });
    expect(cited.quote).toBe("The effect is larger for grocers that fund their stock");
  });

  test("leaves nothing out away from the page's edges", async () => {
    const core = startCore(await createTempDataFolder());
    const pages = [...BODIES.slice(0, 2), ["One", "Two", "Three", "Four", "Five", "Six", "Seven"]];
    const document = await addPaper(core, paper([...pages, ...BODIES.slice(2)]));

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: 3, text: "Five\nNot on the page", linesBefore: 5, linesAfter: 5 }],
    });

    expect(cited).toMatchObject({ check: "not-found", pageFrom: 3, pageTo: 3 });
    expect(cited.quote).toBe("Five Not on the page");
  });

  test("words not on the page they were selected on are not found there, and keep that page", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);

    // Within the lines at the page's top, as the viewer counts them: still not taken for a header.
    for (const lines of [{}, { linesBefore: 1, linesAfter: 2 }]) {
      const cited = await core.citeSelection({
        documentId: document.id,
        parts: [{ unit: 4, text: "Grocers studied across the eleven chains.", ...lines }],
      });

      expect(cited).toMatchObject({
        check: "not-found",
        checkReason: "quote-not-on-pages",
        pageFrom: 4,
        pageTo: 4,
      });
      expect(cited.location).toEqual({ kind: "page", from: 4, to: 4 });
    }
  });

  test("is found only as the Citation check finds it again: a line with a page mark in it is not", async () => {
    const core = startCore(await createTempDataFolder());
    const line = "As shown in [p. 4] of the appendix, margins recover.";
    const document = await addPaper(core, buildPdf([{ lines: [line] }]), "Appendix note.pdf");

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: 1, text: line, linesBefore: 0, linesAfter: 0 }],
    });
    const again = await core.recheckCitation({
      documentId: document.id,
      quote: cited.quote,
      pageFrom: 1,
      pageTo: 1,
    });

    expect(again.check).toBe("not-found");
    expect(cited).toMatchObject({ check: "not-found", pageFrom: 1 });
  });

  test("more than two pages can't be cited", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [
        { unit: 1, text: REPEATED, linesBefore: 2, linesAfter: 1 },
        { unit: 2, text: BODIES[1]?.join("\n") ?? "", linesBefore: 1, linesAfter: 1 },
        { unit: 3, text: "The effect is larger", linesBefore: 1, linesAfter: 2 },
      ],
    });

    expect(cited).toMatchObject({ check: "not-found", checkReason: "too-many-pages" });
  });

  test("Chinese selected across a line break reads as one line, and is found", async () => {
    const core = startCore(await createTempDataFolder());
    const bytes = buildPdf([
      { chineseLines: ["降息之后，零售商的毛利率", "在两个季度内回升。"] },
      { chineseLines: ["小型连锁店回升较少。"] },
    ]);
    const document = await addPaper(core, bytes, "降息.pdf");

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: 1, text: "零售商的毛利率\n在两个季度内回升", linesBefore: 0, linesAfter: 0 }],
    });

    expect(cited).toMatchObject({ check: "found", pageFrom: 1, pageTo: 1 });
    expect(cited.quote).toBe("零售商的毛利率在两个季度内回升");
  });

  test("a word split at a line's end reads whole", async () => {
    const core = startCore(await createTempDataFolder());
    const bytes = buildPdf([{ lines: ["The panel covers asset man-", "agement firms only."] }]);
    const document = await addPaper(core, bytes, "Panel.pdf");

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: 1, text: "covers asset man-\nagement firms", linesBefore: 0, linesAfter: 0 }],
    });

    expect(cited).toMatchObject({ check: "found", quote: "covers asset management firms" });
  });

  test("words on no known Unit are cited where the Document has them, if it has them in one place only", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);

    const once = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: null, text: "Smaller chains recovered less" }],
    });
    const twice = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: null, text: REPEATED }],
    });

    expect(once).toMatchObject({ check: "found", pageFrom: 4, pageTo: 4 });
    expect(twice).toMatchObject({ check: "not-found", pageFrom: null, pageTo: null });
  });

  describe("where the view doesn't know the Unit, the words around the selection place it", () => {
    test("in a Word file with no headings, the paragraph of the second of two same sentences", async () => {
      const core = startCore(await createTempDataFolder());
      const said = "The Supplier shall keep the goods insured.";
      const document = await addPaper(
        core,
        docxOf([
          { text: `Clause 1. ${said}` },
          { text: "Clause 2. Payment is due within thirty days." },
          { text: `Clause 3. ${said}` },
        ]),
        "Supply terms.docx",
      );

      const second = await core.citeSelection({
        documentId: document.id,
        parts: [{ unit: null, text: said, before: "within thirty days.\nClause 3. ", after: "" }],
      });
      const first = await core.citeSelection({
        documentId: document.id,
        parts: [{ unit: null, text: said, before: "Clause 1. ", after: "\nClause 2. Payment" }],
      });

      expect(second).toMatchObject({ check: "found", quote: said });
      expect(second.location).toMatchObject({ kind: "section", paragraphs: { from: 3, to: 3 } });
      expect(first.location).toMatchObject({ kind: "section", paragraphs: { from: 1, to: 1 } });
    });

    test("in a text file, the lines of the second of two same lines, its Unit known", async () => {
      const core = startCore(await createTempDataFolder());
      const lines = [
        "Tides rise twice a day.",
        "Spring tides are larger.",
        "Tides rise twice a day.",
      ];
      const document = await addPaper(core, Buffer.from(lines.join("\n")), "Tides.txt");

      const cited = await core.citeSelection({
        documentId: document.id,
        parts: [{ unit: 1, text: "Tides rise twice a day.", before: "Spring tides are larger.\n" }],
      });

      expect(cited).toMatchObject({ check: "found", pageFrom: 1 });
      expect(cited.location).toEqual({ kind: "lines", from: 3, to: 3 });
    });

    // The words around a selection as the text view sends them: the file's own characters.
    const aroundLine = (lines: readonly string[], line: number) => {
      const source = lines.join("\n");
      const start = lines.slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
      const end = start + (lines[line - 1] ?? "").length;
      return {
        before: source.slice(Math.max(0, start - 80), start),
        after: source.slice(end, end + 80),
      };
    };

    // Matching passes over spacing: blank lines in the words before must not shift the selection
    // onto the same short line next to it.
    test("in a text file, a short line the next line repeats, blank lines before it", async () => {
      const core = startCore(await createTempDataFolder());
      const lines = ["", "", "Checked", "Checked", "Yes", "Done", "No", "Done", "OK", "OK", ""];
      const document = await addPaper(core, Buffer.from(lines.join("\n")), "Checks.txt");

      const cited = await core.citeSelection({
        documentId: document.id,
        parts: [{ unit: 1, text: "OK", ...aroundLine(lines, 9) }],
      });

      expect(cited).toMatchObject({ check: "found" });
      expect(cited.location).toEqual({ kind: "lines", from: 9, to: 9 });
    });

    test.each([
      [["", "", "", "OK", "", "OK", "Done", "", "No", "", ""]],
      [["", "", "", "OK", "OK", "No", "OK", "", "No", "OK", "Yes"]],
      [["", "", "Yes", "Yes", "OK", "", "Yes", "OK", "OK", "Yes", ""]],
      [["", "", "OK", "Yes", "", "Done", "", "OK", "Done", "OK", "OK"]],
    ])(
      "in a text file of short repeated words, every line cites its own line: %j",
      async (lines) => {
        const core = startCore(await createTempDataFolder());
        const document = await addPaper(core, Buffer.from(lines.join("\n")), "Answers.txt");

        for (const [index, text] of lines.entries()) {
          if (text === "") continue;
          const cited = await core.citeSelection({
            documentId: document.id,
            parts: [{ unit: 1, text, ...aroundLine(lines, index + 1) }],
          });
          expect.soft(cited.location, `line ${index + 1}`).toEqual({
            kind: "lines",
            from: index + 1,
            to: index + 1,
          });
        }
      },
    );

    // A text file's Units are blocks of 50 lines: at a block's edge, the words around the selection
    // are in the next block, and a place inside the block with the same nearer words must not win.
    test.each([50, 51, 100, 101])(
      "in a text file, the line at a block's edge (line %i), though the same lines are elsewhere in its block",
      async (line) => {
        const core = startCore(await createTempDataFolder());
        const decoy = line <= 50 ? 25 : line <= 100 ? (line === 51 ? 80 : 75) : 130;
        const lines = Array.from({ length: 150 }, (_, index) => `Shelf ${index + 1} checked.`);
        for (const at of [line, decoy]) {
          lines[at - 2] = "Packed by Ana";
          lines[at - 1] = "Total: 5 boxes";
          lines[at] = "Signed by Ben";
        }
        const document = await addPaper(core, Buffer.from(lines.join("\n")), "Deliveries.txt");

        const cited = await core.citeSelection({
          documentId: document.id,
          parts: [
            {
              unit: Math.ceil(line / 50),
              text: "Total: 5 boxes",
              before: `${lines.slice(line - 5, line - 1).join("\n")}\n`,
              after: `\n${lines.slice(line, line + 4).join("\n")}`,
            },
          ],
        });

        expect(cited).toMatchObject({ check: "found" });
        expect(cited.location).toEqual({ kind: "lines", from: line, to: line });
      },
    );

    test("words a long file has in many places aren't cited", async () => {
      const core = startCore(await createTempDataFolder());
      const lines = Array.from(
        { length: 3000 },
        (_, index) => `Reading ${index} rose at the gauge.`,
      );
      const document = await addPaper(core, Buffer.from(lines.join("\n")), "Gauge log.txt");

      const cited = await core.citeSelection({
        documentId: document.id,
        parts: [{ unit: null, text: "rose at the gauge." }],
      });

      expect(cited).toMatchObject({ check: "not-found", pageFrom: null });
    });

    test("in a text file, two same lines that nothing around tells apart aren't cited", async () => {
      const core = startCore(await createTempDataFolder());
      const lines = [
        "Tides rise twice a day.",
        "Spring tides are larger.",
        "Tides rise twice a day.",
      ];
      const document = await addPaper(core, Buffer.from(lines.join("\n")), "Tides.txt");

      const cited = await core.citeSelection({
        documentId: document.id,
        parts: [{ unit: 1, text: "Tides rise twice a day." }],
      });

      expect(cited).toMatchObject({
        check: "not-found",
        checkReason: "in-several-places",
        pageFrom: 1,
        pageTo: 1,
      });
    });

    test("words around it that tell no place leave words in two places uncited", async () => {
      const core = startCore(await createTempDataFolder());
      const document = await addPaper(core);

      const cited = await core.citeSelection({
        documentId: document.id,
        parts: [
          { unit: null, text: REPEATED, before: "Words no page has. ", after: " Nor these." },
        ],
      });

      expect(cited).toMatchObject({ check: "not-found", pageFrom: null });
    });

    test("on a page that has the words twice, either place is the page", async () => {
      const core = startCore(await createTempDataFolder());
      const twice = ["Margins recover.", "Prices rise.", "Margins recover."];
      const document = await addPaper(core, paper([twice, ...BODIES.slice(1)]));

      const cited = await core.citeSelection({
        documentId: document.id,
        parts: [{ unit: 1, text: "Margins recover.", linesBefore: 2, linesAfter: 2 }],
      });

      expect(cited).toMatchObject({ check: "found", pageFrom: 1, pageTo: 1 });
    });
  });

  test("words a long text file has on every line are refused at once, with no Location", async () => {
    const core = startCore(await createTempDataFolder());
    const lines = Array.from(
      { length: 30_000 },
      (_, index) => `${index} The gauge was read again.`,
    );
    const document = await addPaper(core, Buffer.from(lines.join("\n")), "Gauge log.txt");

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: null, text: "The gauge was read again." }],
    });

    expect(cited).toMatchObject({ check: "not-found", pageFrom: null, location: null });
  });

  test("parts given out of order still cite their pages in order", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [
        { unit: 4, text: "Smaller chains recovered less," },
        { unit: 3, text: "at floating rates, as Table 3 shows." },
      ],
    });

    expect(cited).toMatchObject({ pageFrom: 3, pageTo: 4 });
  });

  test("a selection that names its Unit for some parts and not others isn't looked for elsewhere", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [
        { unit: 4, text: "Pooling the cuts," },
        { unit: null, text: "the recovery peaks in the second quarter." },
      ],
    });

    expect(cited).toMatchObject({ check: "not-found", pageFrom: 4, pageTo: 4 });
  });

  test("a Unit that isn't one, or nothing but spaces, is refused", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);
    const cite = (parts: unknown[]) =>
      core.citeSelection({ documentId: document.id, parts } as Parameters<
        typeof core.citeSelection
      >[0]);

    await expect(cite([{ unit: 0, text: REPEATED }])).rejects.toThrow("No text is selected.");
    await expect(cite([{ unit: 1.5, text: REPEATED }])).rejects.toThrow("No text is selected.");
    await expect(cite([{ unit: 2, text: " \n " }])).rejects.toThrow("No text is selected.");
    await expect(cite([])).rejects.toThrow("No text is selected.");
  });

  test("a deleted Document can't be checked", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addPaper(core);
    await core.deleteDocuments([document.id]);

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: 1, text: REPEATED }],
    });

    expect(cited).toMatchObject({ check: "cant-check", checkReason: "document-removed" });
  });
});
