/**
 * Reading Word, PowerPoint, Excel and CSV files, and Markdown and plain text,
 * into Units (ADR-0011).
 *
 * The files in tests/fixtures/formats/ were written once by the generator of
 * the office-formats spike (branch prototype/office-formats,
 * prototype/office-formats/scripts/generate.ts, with docx 9.9.0, pptxgenjs
 * 4.0.1 and exceljs 4.4.0), with a footnote added to the .docx, and a merged
 * group heading and an empty third sheet added to the .xlsx. They are
 * committed, so nothing here depends on those libraries. Files the cases need
 * beyond them (huge sheets, broken files) are built here (tests/helpers/office.ts).
 */
import { readFileSync } from "node:fs";
import { truncate } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { createIgnore } from "../../src/core/documents/files";
import { extractUnits } from "../../src/core/documents/formats";
import { extractCsv, parseCsv } from "../../src/core/documents/formats/csv";
import { extractDocx, MAX_SECTION_CHARS } from "../../src/core/documents/formats/docx";
import { ExtractionError } from "../../src/core/documents/formats/errors";
import { BLOCK_CHARACTERS, MAX_ROWS } from "../../src/core/documents/formats/grid";
import { formatNumber } from "../../src/core/documents/formats/numbers";
import { extractPptx, imageDataUrl } from "../../src/core/documents/formats/pptx";
import { lineUnits, markdownUnits } from "../../src/core/documents/formats/text";
import { extractXlsx, readWorkbook } from "../../src/core/documents/formats/xlsx";
import {
  crc32,
  MAX_PACKAGE_BYTES,
  type RawEntry,
  writeZip,
} from "../../src/core/documents/formats/zip";
import { anchorsOf, type TextUnit } from "../../src/shared/units";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { docxOf, encryptedOfficeFile, legacyOfficeFile, xlsxOf } from "../helpers/office";
import { buildZip } from "../helpers/zip";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/formats/${name}`, import.meta.url)));

const DOCX = fixture("Coastal Flood Risk Review.docx");
const PPTX = fixture("Quarterly Research Update.pptx");
const XLSX = fixture("Regional Revenue.xlsx");
const CSV = fixture("Orders.csv");

const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

describe("Word", () => {
  test("is read by section, each labelled with its heading path, the title before the first heading", async () => {
    const { units, headings } = await extractDocx(DOCX);

    expect(units.map((unit) => unit.label)).toEqual([
      { path: [], beforeHeading: true },
      { path: ["1 Introduction"] },
      { path: ["1 Introduction", "1.1 Scope"] },
      { path: ["2 Results"] },
      { path: ["2 Results", "2.1 Sensitivity"] },
      { path: ["3 Discussion"] },
      { path: ["3 Discussion", "3.1 Limitations"] },
      { path: [], notes: true },
    ]);
    expect(units.map((unit) => unit.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(units.every((unit) => unit.kind === "section")).toBe(true);
    expect(units[0]?.text).toBe("Coastal Flood Risk Review");
    expect(headings.map((heading) => [heading.level, heading.text, heading.unit])).toEqual([
      [1, "1 Introduction", 2],
      [2, "1.1 Scope", 3],
      [1, "2 Results", 4],
      [2, "2.1 Sensitivity", 5],
      [1, "3 Discussion", 6],
      [2, "3.1 Limitations", 7],
    ]);
  });

  test("keeps a section's heading, its runs, list items and table rows, and puts footnotes last", async () => {
    const { units } = await extractDocx(DOCX);
    const [, introduction, scope, results, sensitivity, , , notes] = units;

    expect(introduction?.text.split("\n")[1]).toBe(
      "This review asks how much sea-level rise the estuary defences can absorb before the 1-in-200-year flood line moves inland.",
    );
    expect(scope?.text).toContain("Twelve tide gauges, 2004 to 2025.\nThree estuaries");
    expect(results?.text).toContain(
      "Estuary\tSites\tMedian rise (mm/yr)\tRisk\nNorthern\t5\t4.1\tHigh",
    );
    // The footnote's reference leaves no mark in the sentence; its text is the notes Unit.
    expect(sensitivity?.text).toContain(
      "halves the expected annual damage in the northern estuary. The central and southern",
    );
    expect(notes?.text).toBe("Damage figures are in 2025 pounds, discounted at 3.5 per cent.");
    // Each paragraph is anchored, for the viewer.
    expect(anchorsOf(sensitivity as never).map((anchor) => anchor.target)).toEqual([
      "p19",
      "p20",
      "p21",
      "p22",
      "p23",
    ]);
  });

  test("splits a section longer than about 6,000 characters into parts, at paragraph ends", async () => {
    const paragraph = "The barrier was raised. ".repeat(40).trim();
    const long = docxOf([
      { text: "Methods", heading: 1 },
      ...Array.from({ length: 20 }, () => ({ text: paragraph })),
      { text: "Results", heading: 1 },
      { text: "It worked." },
    ]);

    const units = await extractUnits("docx", long);

    // About 960 characters a paragraph: six fit in a part.
    expect(units.map((unit) => unit.label)).toEqual([
      { path: ["Methods"] },
      { path: ["Methods"], part: 2 },
      { path: ["Methods"], part: 3 },
      { path: ["Methods"], part: 4 },
      { path: ["Results"] },
    ]);
    expect(units.every((unit) => unit.text.length <= MAX_SECTION_CHARS)).toBe(true);
    expect(units[1]?.text.startsWith(paragraph)).toBe(true);
  });

  test("reads each comment into the section its mark is in, after the section's text, anchored and named with its author (#76)", async () => {
    const units = await extractUnits(
      "docx",
      docxOf([
        { text: "Methods", heading: 1 },
        {
          text: "Gauges were read at high water.",
          comment: { text: "Confirm the datum first.", author: "J. Moreau" },
        },
        { text: "Each gauge was calibrated." },
        { text: "Results", heading: 1 },
        { text: "The barrier held.", comment: { text: "Which year was this?" } },
        { text: "结论", heading: 1 },
        { text: "堤坝经受住了风暴。", comment: { text: "请补充2025年的数据。", author: "王丽华" } },
      ]),
    );

    expect(units.map((unit) => unit.text)).toEqual([
      "Methods\nGauges were read at high water.\nEach gauge was calibrated.\n\nConfirm the datum first.",
      "Results\nThe barrier held.\n\nWhich year was this?",
      "结论\n堤坝经受住了风暴。\n\n请补充2025年的数据。",
    ]);
    expect(units.map((unit) => unit.label)).toEqual([
      { path: ["Methods"], comments: [{ target: "comment0", author: "J. Moreau" }] },
      { path: ["Results"], comments: [{ target: "comment1", author: null }] },
      { path: ["结论"], comments: [{ target: "comment2", author: "王丽华" }] },
    ]);
    // The comment is anchored, for the viewer and the Citation's label; the paragraphs are as before.
    const [methods] = units as [TextUnit];
    expect(
      anchorsOf(methods).map((anchor) => [
        anchor.target,
        methods.text.slice(anchor.start, anchor.end),
      ]),
    ).toEqual([
      ["p1", "Methods"],
      ["p2", "Gauges were read at high water."],
      ["p3", "Each gauge was calibrated."],
      ["comment0", "Confirm the datum first."],
    ]);
  });

  test("reads a comment with only its range's start, or on a paragraph with no text, and leaves out one anchored nowhere it reads", async () => {
    const units = await extractUnits(
      "docx",
      docxOf([
        { text: "Methods", heading: 1 },
        { text: "Gauges were read.", comment: { text: "Started here.", mark: "start" } },
        { text: "", comment: { text: "On a picture.", author: "J. Moreau" } },
        { text: "Each gauge was calibrated." },
      ]),
    );

    expect(units.map((unit) => unit.text)).toEqual([
      "Methods\nGauges were read.\nEach gauge was calibrated.\n\nStarted here.\n\nOn a picture.",
    ]);
    expect(anchorsOf(units[0] as TextUnit).map((anchor) => anchor.target)).toEqual([
      "p1",
      "p2",
      "p3",
      "comment0",
      "comment1",
    ]);
  });

  test("reads the comment of a real Word file into its first section", async () => {
    const { units } = await extractDocx(fixture("Field Report.docx"));

    expect(units[0]?.label).toEqual({
      path: [],
      beforeHeading: true,
      comments: [{ target: "comment0", author: "J. Moreau" }],
    });
    expect(
      units[0]?.text.endsWith("open questions.\n\nConfirm with the hydrology team before release."),
    ).toBe(true);
    // Its other sections have none.
    expect(units.slice(1).some((unit) => unit.label?.comments)).toBe(false);
  });
});

describe("PowerPoint", () => {
  test("is read one Unit per slide, numbered as the slides are, with the speaker notes last", async () => {
    const { units, slides } = await extractPptx(PPTX);

    expect(units.map((unit) => [unit.page, unit.kind])).toEqual([
      [1, "slide"],
      [2, "slide"],
      [3, "slide"],
      [4, "slide"],
      [5, "slide"],
    ]);
    const third = units[2];
    expect(third?.text).toBe(
      "Regional growth\nThe western region grew fastest, at 18 per cent year on year.\n\nPoint at the red bar: that is the west.",
    );
    // The notes are marked: an anchor says where they start.
    const notes = third?.anchors?.find((anchor) => anchor.target === "notes");
    expect(third?.text.slice(notes?.start, notes?.end)).toBe(
      "Point at the red bar: that is the west.",
    );
    expect(slides[2]?.notes).toEqual(["Point at the red bar: that is the west."]);
  });

  test("reads tables row by row, and charts' series and categories from their caches", async () => {
    const { units, slides } = await extractPptx(PPTX);

    expect(units[3]?.text).toContain("Stage\tDeals\tValue (£k)\nQualified\t42\t1,260");
    expect(units[4]?.text).toContain(
      "Revenue (£m)\nQ4 25: 3.1, Q1 26: 3.4, Q2 26: 3.9, Q3 26: 4.4",
    );
    expect(slides[3]?.tables[0]?.[1]).toEqual(["Qualified", "42", "1,260"]);
  });

  test("gives the outline its images as data: URLs, which the viewer's policy allows", async () => {
    const { slides } = await extractPptx(PPTX);
    const image = slides[2]?.images[0];

    expect(image?.part).toMatch(/^ppt\/media\/.+\.png$/);
    expect(await imageDataUrl(PPTX, image?.part ?? "")).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(await imageDataUrl(PPTX, "ppt/media/missing.png")).toBeNull();
  });
});

describe("Excel", () => {
  test("reads each sheet in blocks of rows, as Excel shows the values: formats, formulas' results, dates", async () => {
    const units = await extractUnits("xlsx", XLSX);

    expect(
      units.map((unit) => [
        unit.page,
        unit.kind,
        unit.label?.sheet,
        unit.label?.from,
        unit.label?.to,
      ]),
    ).toEqual([
      [1, "rows", "Revenue", 1, 9],
      [2, "rows", "Notes", 1, 4],
    ]);
    const lines = units[0]?.text.split("\n") ?? [];
    expect(lines[6]).toBe("West\t£350,200\t£389,600\t£421,800\t£466,100\t£1,627,700");
    expect(lines[8]).toBe("Change on 2025\t-4.2%\t1.8%\t6.1%\t-1.3%");
    expect(units[1]?.text.split("\n")[2]).toBe(
      "2026-07-03\tJ. Moreau\tNorthern figures exclude the Leeds office, which reported late.",
    );
  });

  test("keeps merged headings once, in their first cell, and an empty sheet has no Units", async () => {
    const { workbook, units } = await extractXlsx(XLSX);
    const [revenue, notes, empty] = workbook.sheets;

    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Revenue", "Notes", "Empty"]);
    expect(revenue?.merges).toEqual(["A1:F1", "B2:E2"]);
    const lines = units[0]?.text.split("\n") ?? [];
    expect(lines[0]).toBe("Revenue by region, 2026 (GBP)");
    expect(lines[1]).toBe("\tQuarters");
    expect(notes?.cells.length).toBe(12);
    expect(empty?.cells).toEqual([]);
    expect(units.some((unit) => unit.label?.sheet === "Empty")).toBe(false);
    // Each cell's text is anchored by its reference.
    const cells = anchorsOf(units[0] as never).filter((anchor) => anchor.target.endsWith("7"));
    expect(cells.map((anchor) => anchor.target)).toEqual(["A7", "B7", "C7", "D7", "E7", "F7"]);
  });

  test("blocks hold about 400 tokens of rows, and each block after a sheet's first repeats its header", async () => {
    const rows = [
      ["Region", "Quarter", "Revenue"],
      ...Array.from({ length: 300 }, (_, index) => [`Region ${index + 1}`, "Q3", 1000 + index]),
    ];
    const units = await extractUnits("xlsx", xlsxOf([{ name: "Data", rows }]));

    expect(units.length).toBeGreaterThan(3);
    for (const [index, unit] of units.entries()) {
      expect(unit.text.length).toBeLessThanOrEqual(BLOCK_CHARACTERS + 40);
      if (index > 0) {
        expect(unit.text.split("\n")[0]).toBe("Region\tQuarter\tRevenue");
        expect(unit.label?.header).toBe(true);
        expect(unit.label?.rows?.[0]).toBe(1);
      }
    }
    // The blocks follow on: every data row is in exactly one.
    const covered = units.flatMap((unit) =>
      (unit.label?.rows ?? []).slice(unit.label?.header ? 1 : 0),
    );
    expect(covered).toEqual(Array.from({ length: 301 }, (_, index) => index + 1));
  });

  test("a huge sheet stays bounded: reading stops after the row limit, and says so", async () => {
    const rows = Array.from({ length: MAX_ROWS + 5000 }, (_, index) => [index + 1, "x", index * 2]);
    const bytes = xlsxOf([
      { name: "Big", rows },
      { name: "After", rows: [["never read"]] },
    ]);

    const { sheets, truncated } = await readWorkbook(bytes);

    expect(truncated).toBe(true);
    expect(sheets[0]?.rowCount).toBe(MAX_ROWS);
    expect(sheets[1]?.cells).toEqual([]);
    // The limits can be set lower, as they are counted over the whole workbook.
    const small = await readWorkbook(bytes, { rows: 10, cells: 1000 });
    expect(small.sheets[0]?.rowCount).toBe(10);
  });

  test("a hidden and a very hidden sheet, and the rows past the limit, are named as unread (#740)", async () => {
    const bytes = xlsxOf([
      { name: "Visible", rows: [["Region"]] },
      { name: "Q3 raw", state: "hidden", rows: [["Secret"], ["1"]] },
      { name: "Q4 raw", state: "veryHidden", rows: [["Secret"], ["2"]] },
      {
        name: "Big",
        rows: Array.from({ length: MAX_ROWS + 5 }, (_, index) => [`R${index + 1}`, index]),
      },
      { name: "After", rows: [["never read"]] },
    ]);

    const workbook = await readWorkbook(bytes);

    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Visible", "Big", "After"]);
    expect(workbook.hiddenSheets).toEqual(["Q3 raw", "Q4 raw"]);
    expect(workbook.rowsCut).toEqual([{ sheet: "Big", from: MAX_ROWS }]);
    expect(workbook.sheetsNotRead).toEqual(["After"]);
  });

  test("formats numbers as their format says, and shows formats it doesn't know as the plain number", () => {
    expect(formatNumber(350200, '"£"#,##0')).toBe("£350,200");
    expect(formatNumber(-1250, "#,##0 ;(#,##0)")).toBe("(1,250)");
    expect(formatNumber(0.042, "0.0%")).toBe("4.2%");
    expect(formatNumber(-0.0125, "0.0%")).toBe("-1.3%");
    expect(formatNumber(1234.5, "#,##0.00")).toBe("1,234.50");
    expect(formatNumber(1234.5, "General")).toBe("1234.5");
    expect(formatNumber(46114, "yyyy-mm-dd")).toBe("2026-04-02");
    expect(formatNumber(12345, "0.00E+00")).toBe("12345");
    expect(formatNumber(1_200_000, '"$"#,##0.0,,"m"')).toBe("$1.2m");
    expect(formatNumber(4_500, "#,##0,")).toBe("5");
  });
});

describe("CSV", () => {
  test("reads quoted fields, a comma inside one too, into blocks of rows with the header repeated", () => {
    const { units, workbook } = extractCsv(CSV);

    expect(
      units.map((unit) => [unit.kind, unit.label?.sheet, unit.label?.from, unit.label?.to]),
    ).toEqual([
      ["rows", undefined, 1, 37],
      ["rows", undefined, 38, 41],
    ]);
    expect(units[0]?.text.split("\n")[1]).toBe(
      "1001\t2026-09-02\tBrightside, Inc.\tCentral\t157.50",
    );
    expect(units[1]?.text.split("\n")[0]).toBe("order_id\tdate\tcustomer\tregion\tamount");
    expect(workbook.sheets[0]?.rowCount).toBe(41);
    expect(parseCsv('a;b\n"x;y";2\n').rows).toEqual([
      ["a", "b"],
      ["x;y", "2"],
    ]);
  });

  test("a huge file stays bounded too", () => {
    const text = `id,value\n${Array.from({ length: MAX_ROWS + 10 }, (_, index) => `${index},${index * 3}`).join("\n")}\n`;
    const { workbook } = extractCsv(new TextEncoder().encode(text));

    expect(workbook.truncated).toBe(true);
    expect(workbook.sheets[0]?.rowCount).toBe(MAX_ROWS);
  });
});

describe("Files that can't be read fail cleanly, with a reason", () => {
  test.each([
    ["docx", "password-protected", encryptedOfficeFile()],
    ["xlsx", "password-protected", encryptedOfficeFile()],
    ["pptx", "password-protected", encryptedOfficeFile()],
    ["docx", "unreadable", legacyOfficeFile()],
    ["docx", "unreadable", Buffer.from(DOCX.subarray(0, DOCX.length / 2))],
    ["xlsx", "unreadable", Buffer.from(XLSX.subarray(0, XLSX.length - 100))],
    ["pptx", "unreadable", Buffer.from("not a zip file at all")],
    ["pptx", "unreadable", XLSX],
  ] as const)("%s: %s", async (kind, reason, bytes) => {
    const failure = await extractUnits(kind, bytes).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ExtractionError);
    expect((failure as ExtractionError).reason).toBe(reason);
  });

  test("a part with a DOCTYPE is refused, so no entity is expanded", async () => {
    const withDoctype = buildZip([
      {
        name: "word/document.xml",
        data: '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaa">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body></w:document>',
      },
    ]);

    const failure = await extractUnits("docx", withDoctype).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtractionError);
    expect((failure as Error).message).toMatch(/DOCTYPE/);
  });

  test("a Word, PowerPoint or Excel file over 500 MB is refused before it is read, with the limit", async () => {
    // Zeros, never touched: the size alone refuses it.
    const huge = new Uint8Array(MAX_PACKAGE_BYTES + 1);

    for (const kind of ["docx", "pptx", "xlsx"] as const) {
      const failure = await extractUnits(kind, huge).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ExtractionError);
      expect(failure).toMatchObject({
        reason: "too-large",
        message: "Too large to open (limit 500 MB).",
      });
    }
    // At the limit it is opened (and these zeros aren't a package).
    const atLimit = await extractUnits("docx", huge.subarray(1)).catch((error: unknown) => error);
    expect(atLimit).toMatchObject({ reason: "unreadable" });
  });

  test("a package whose parts inflate past 1 GB together is refused, though each part is within its own limit", {
    timeout: 60_000,
  }, async () => {
    // Twenty slides of 60 MB each, mostly a comment: one compressed body, so the file is small.
    const slides = 20;
    const slide = Buffer.concat([
      Buffer.from(
        `<?xml version="1.0"?><p:sld xmlns:p="${PRESENTATION_NS}"><p:cSld><p:spTree/></p:cSld><!--`,
      ),
      Buffer.alloc(60 * 1024 * 1024, "x"),
      Buffer.from("--></p:sld>"),
    ]);
    const body: RawEntry = {
      method: 8,
      crc32: crc32(slide),
      size: slide.length,
      data: deflateRawSync(slide),
    };
    const ids = Array.from({ length: slides }, (_, index) => index + 1);
    const deck = writeZip(
      [
        {
          name: "ppt/presentation.xml",
          data: `<?xml version="1.0"?><p:presentation xmlns:p="${PRESENTATION_NS}" xmlns:r="${RELATIONSHIPS_NS}"><p:sldIdLst>${ids.map((id) => `<p:sldId id="${255 + id}" r:id="rId${id}"/>`).join("")}</p:sldIdLst></p:presentation>`,
        },
        {
          name: "ppt/_rels/presentation.xml.rels",
          data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ids.map((id) => `<Relationship Id="rId${id}" Type="${RELATIONSHIPS_NS}/slide" Target="slides/slide${id}.xml"/>`).join("")}</Relationships>`,
        },
        ...ids.map((id) => ({ name: `ppt/slides/slide${id}.xml`, raw: body })),
      ],
      deflateRawSync,
    );
    expect(deck.length).toBeLessThan(5 * 1024 * 1024);

    const failure = await extractUnits("pptx", deck).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtractionError);
    expect(failure).toMatchObject({
      reason: "too-large",
      message: "Too large to open (limit 1 GB).",
    });
    // A deck of a few such slides is within the limit, and opens.
    const few = writeZip(
      [
        {
          name: "ppt/presentation.xml",
          data: `<?xml version="1.0"?><p:presentation xmlns:p="${PRESENTATION_NS}" xmlns:r="${RELATIONSHIPS_NS}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
        },
        {
          name: "ppt/_rels/presentation.xml.rels",
          data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIPS_NS}/slide" Target="slides/slide1.xml"/></Relationships>`,
        },
        { name: "ppt/slides/slide1.xml", raw: body },
      ],
      deflateRawSync,
    );
    expect((await extractUnits("pptx", few)).map((unit) => unit.page)).toEqual([1]);
  });

  test("an entry that inflates past its limit is refused, so a zip bomb fails", async () => {
    const bomb = buildZip([
      { name: "xl/workbook.xml", data: `<workbook>${" ".repeat(70 * 1024 * 1024)}</workbook>` },
    ]);

    const failure = await extractUnits("xlsx", bomb).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtractionError);
    expect((failure as Error).message).toMatch(/too large/);
  });
});

describe("Processing", { timeout: 30_000 }, () => {
  test("indexes each kind, stores its Units, and builds Passages that stay within one sheet", async () => {
    const sources = await createSourceFolder();
    const core = startCore(await createTempDataFolder());
    const names = [
      "Coastal Flood Risk Review.docx",
      "Quarterly Research Update.pptx",
      "Regional Revenue.xlsx",
      "Orders.csv",
    ];
    const paths = await Promise.all(
      names.map((name) => writeSourceFile(sources, name, fixture(name))),
    );

    const documents = await addAndProcess(core, paths);

    expect(documents.map((document) => [document.kind, document.status])).toEqual([
      ["docx", "ready"],
      ["pptx", "ready"],
      ["xlsx", "ready"],
      ["csv", "ready"],
    ]);
    const workbook = await core.readDocumentText(documents[2]?.id as string);
    expect(workbook.pages.map((unit) => [unit.page, unit.kind, unit.label?.sheet])).toEqual([
      [1, "rows", "Revenue"],
      [2, "rows", "Notes"],
    ]);
    // A Passage of a workbook never runs from one sheet into the next.
    const passages = await core.searchPassages("Leeds Revenue Notes West", {
      mode: "keyword",
      documentIds: [documents[2]?.id as string],
    });
    expect(passages.length).toBeGreaterThan(0);
    for (const passage of passages) expect(passage.pageFrom).toBe(passage.pageTo);
    // Office's lock files beside an open file aren't Documents.
    expect(createIgnore()("Sub/~$Regional Revenue.xlsx")).toBe(true);
    core.close();
  });

  test("a Word file over 500 MB fails as too large to open, with the limit; one beside it is indexed as before", async () => {
    const sources = await createSourceFolder();
    const core = startCore(await createTempDataFolder());
    // Sparse: 500 MB and a byte on disk, with nothing written.
    const huge = await writeSourceFile(sources, "Huge.docx", "");
    await truncate(huge, MAX_PACKAGE_BYTES + 1);
    const normal = await writeSourceFile(sources, "Review.docx", DOCX);

    const [refused, indexed] = await addAndProcess(core, [huge, normal]);

    expect(refused).toMatchObject({
      status: "failed",
      failure: { reason: "too-large", message: "Too large to open (limit 500 MB)." },
      size: MAX_PACKAGE_BYTES + 1,
      pageCount: null,
    });
    expect(indexed).toMatchObject({ status: "ready", failure: null });
    core.close();
  });
});

describe("Markdown", () => {
  test("is read by section: the text under each heading, its heading path as its label", () => {
    const source = [
      "Before any heading.",
      "",
      "# Methods",
      "",
      "Gauges were read hourly.",
      "",
      "```",
      "# not a heading: code",
      "```",
      "",
      "## Calibration",
      "",
      "Against the **national** datum.",
      "",
      "# Results",
      "Tides rose.",
    ].join("\n");

    const units = markdownUnits(source);

    expect(units.map((unit) => unit.label)).toEqual([
      { path: [], beforeHeading: true },
      { path: ["Methods"] },
      { path: ["Methods", "Calibration"] },
      { path: ["Results"] },
    ]);
    // Each Unit's text is its slice of the file, so the viewer finds it again.
    for (const unit of units) expect(source.slice(unit.start, unit.end)).toBe(unit.text);
    expect(units[1]?.text).toContain("# not a heading: code");
  });

  test("splits a long section into parts at blank lines", () => {
    const paragraph = "Tide gauges were read every fifteen minutes. ".repeat(20);
    const source = `# Long\n\n${Array.from({ length: 12 }, () => paragraph).join("\n\n")}\n`;

    const units = markdownUnits(source);

    expect(units.length).toBeGreaterThan(1);
    expect(units.map((unit) => unit.label?.part ?? 1)).toEqual(units.map((_, index) => index + 1));
    expect(units.every((unit) => unit.text.length <= MAX_SECTION_CHARS)).toBe(true);
  });
});

describe("Plain text", () => {
  test("is read in blocks of up to 50 lines, each labelled with its first and last line", () => {
    const source = Array.from({ length: 120 }, (_, index) => `Line ${index + 1}.`).join("\n");

    const units = lineUnits(source);

    expect(units.map((unit) => [unit.page, unit.label?.from, unit.label?.to])).toEqual([
      [1, 1, 50],
      [2, 51, 100],
      [3, 101, 120],
    ]);
    expect(units[1]?.text.split("\n")[0]).toBe("Line 51.");
  });

  test("blank lines between blocks are left out, and a very long line is a block of its own", () => {
    const long = "word ".repeat(1200).trim();
    const source = ["", "First line.", "", "", long, "Last line."].join("\n");

    const units = lineUnits(source);

    expect(units.map((unit) => [unit.label?.from, unit.label?.to])).toEqual([
      [2, 2],
      [5, 5],
      [6, 6],
    ]);
  });
});
