/**
 * The .xlsx writer (src/core/exports/xlsx.ts) and an Answer as a figure cell
 * (src/core/exports/figureCells.ts), read back with the app's own workbook
 * reader, which shows each cell as Excel would.
 */
import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { cellIndex } from "../../src/core/documents/formats/sheetLayout";
import { readWorkbook } from "../../src/core/documents/formats/xlsx";
import { figureCell } from "../../src/core/exports/figureCells";
import type { Sheet, SheetBook } from "../../src/core/exports/sheets";
import { dateSerial, MAX_CELL_TEXT, writeXlsx } from "../../src/core/exports/xlsx";
import { checkWellFormed, part, unzip } from "../helpers/docx";

const OPTIONS = { author: "IncarnaMind", created: "2026-10-19T09:30:00.000Z" };
const write = (book: SheetBook) => writeXlsx(book, deflateRawSync, OPTIONS);

const shown = async (data: Uint8Array) => {
  const { sheets } = await readWorkbook(data, undefined, {});
  return sheets.map((sheet) => ({
    name: sheet.name,
    cells: Object.fromEntries(
      sheet.cells.map((cell) => [`${String.fromCharCode(65 + cell.column)}${cell.row}`, cell]),
    ),
    notes: sheet.layout?.notes,
    frozen: sheet.layout?.frozen,
    /** As Excel shows a cell, by its reference: the layout says so where it differs from the indexed text. */
    shown: (ref: string) => {
      const column = ref.charCodeAt(0) - 65;
      const row = Number(ref.slice(1));
      const cell = sheet.cells.find((each) => each.row === row && each.column === column);
      return sheet.layout?.shown.get(cellIndex(row, column))?.text ?? cell?.value;
    },
  }));
};

describe("An Answer as a cell", () => {
  // protects=the issue's figures land as numbers or days a formula can use, shown as written, a bracketed amount negative; fails_when=one stays text, loses its sign or scale, or shows another way; no_claim=Excel's own rendering (a person checks).
  test.each([
    ["$1.2m", 1_200_000, '"$"#,##0.0,,"m"'],
    ["(3,400)", -3_400, "#,##0;(#,##0)"],
    ["12.5%", 0.125, "0.0%"],
    ["1,2 Mio. €", 1_200_000, '#,##0.0,," Mio. €"'],
    ["(£12.3m)", -12_300_000, '"£"#,##0.0,,"m";("£"#,##0.0,,"m")'],
    ["1.2亿元", 120_000_000, '#,##0"元"'],
    ["12500", 12_500, "0"],
    ["12,500.50", 12_500.5, "#,##0.00"],
    ["1’234", 1_234, "#,##0"],
    ["CHF 1’234.50", 1_234.5, '"CHF "#,##0.00'],
    ["$(3,400)", -3_400, '"$"#,##0;"$"(#,##0)'],
    ["1,2 Mio.", 1_200_000, '#,##0.0,," Mio."'],
    ["$1.2m.", 1_200_000, '"$"#,##0.0,,"m"'],
    ["0.5", 0.5, "#,##0.0"],
    ["£1.5bn", 1_500_000_000, '"£"#,##0.0,,,"bn"'],
    ["£1,583m", 1_583_000_000, '"£"#,##0,,"m"'],
    ["1.5亿元", 150_000_000, '#,##0"元"'],
  ])("%s is the number %d", (answer, number, format) => {
    expect(figureCell(answer, "en")).toEqual({ value: { kind: "number", number }, format });
  });

  // protects=a day written as people write one lands as a date cell in that style; fails_when=it stays text or the day and month swap; no_claim=dates with times.
  test.each([
    ["31 March 2026", "2026-03-31", "d mmmm yyyy"],
    ["March 31, 2026", "2026-03-31", "mmmm d, yyyy"],
    ["2026-03-31", "2026-03-31", "yyyy-mm-dd"],
    ["2026年3月31日", "2026-03-31", 'yyyy"年"m"月"d"日"'],
    ["31/03/2026", "2026-03-31", "dd/mm/yyyy"],
  ])("%s is the day %s", (answer, date, format) => {
    expect(figureCell(answer, "en")).toEqual({ value: { kind: "date", date }, format });
  });

  // protects=an Answer that isn't one figure, or one the reader can't settle, stays text, as do codes with a leading zero and figures past Excel's 15 digits; fails_when=a sentence, a range, an estimate, a duration, an ambiguous day, a code or a long figure becomes a number; no_claim=none beyond protects.
  test.each([
    "Revenue was $1.2m",
    "about $5m",
    "2–3%",
    "30 days",
    "03/04/2026",
    "30 February 2026",
    "Not reported",
    "Smith & Partners, appointed in 2019",
    "00445790",
    "02139",
    "007",
    "12345678901234567890",
  ])("%s stays text", (answer) => {
    expect(figureCell(answer, "en")).toBeNull();
  });

  // protects=a grouping the text alone can't settle is settled by the Mind's language; fails_when="3,400" is read as 3.4; no_claim=none beyond protects.
  test("the Mind's language settles a separator", () => {
    expect(figureCell("3,400", "en")?.value).toEqual({ kind: "number", number: 3400 });
  });

  // protects=Excel's date serials count from 30 December 1899; fails_when=a day is off by one; no_claim=the 1904 date system.
  test("a day is Excel's date serial", () => {
    expect(dateSerial("2026-03-31")).toBe(46112);
    expect(dateSerial("1900-03-01")).toBe(61);
  });
});

describe("The .xlsx writer", () => {
  const book: SheetBook = {
    sheets: [
      {
        id: "t",
        name: "Table: Q3 [draft]",
        columns: [{ id: "name", width: 30 }, { id: "revenue" }],
        frozen: { rows: 1, columns: 1 },
        rows: [
          {
            id: "head",
            header: true,
            cells: [
              { column: "revenue", value: { kind: "text", text: "Revenue" } },
              { column: "name", value: { kind: "text", text: "Document" } },
            ],
          },
          {
            id: "acme",
            cells: [
              { column: "name", value: { kind: "text", text: "Acme & Co <draft>" } },
              {
                column: "revenue",
                value: { kind: "number", number: 1_200_000 },
                format: '"$"#,##0.0,,"m"',
                note: "As written: $1.2m",
              },
            ],
          },
          {
            id: "brandt",
            cells: [
              { column: "name", value: { kind: "text", text: "x".repeat(MAX_CELL_TEXT + 10) } },
              {
                column: "revenue",
                value: { kind: "date", date: "2026-03-31" },
                format: "d mmmm yyyy",
              },
            ],
          },
          {
            id: "total",
            cells: [
              {
                column: "revenue",
                value: { kind: "empty" },
                formula: [
                  "SUM(",
                  {
                    from: { sheet: "t", row: "acme", column: "revenue" },
                    to: { sheet: "t", row: "acme", column: "revenue" },
                  },
                  ")",
                ],
              },
            ],
          },
        ],
      },
      {
        id: "s",
        name: "Sources",
        columns: [{ id: "cell" }],
        rows: [
          {
            id: "first",
            cells: [
              {
                column: "cell",
                value: { kind: "text", text: "Acme · Revenue" },
                link: { sheet: "t", row: "acme", column: "revenue" },
              },
            ],
          },
        ],
      },
    ],
  };

  // protects=every part is well-formed and what Excel needs to open the book is there: content types, relationships, styles, shared strings, notes with their drawing; fails_when=a part is missing or broken, so Excel offers to repair the file; no_claim=Excel itself (LibreOffice in CI, a person in Excel).
  test("writes a package every part of which is well-formed", () => {
    const files = unzip(write(book));
    for (const [name] of files) {
      if (/\.(xml|rels|vml)$/.test(name)) checkWellFormed(part(files, name));
    }
    expect([...files.keys()].sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "docProps/core.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/comments1.xml",
      "xl/drawings/vmlDrawing1.vml",
      "xl/sharedStrings.xml",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/_rels/sheet1.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);
    const sheet = part(files, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("<f>SUM(B2:B2)</f>");
    expect(sheet).toContain('<legacyDrawing r:id="rId1"/>');
    expect(part(files, "xl/workbook.xml")).toContain('fullCalcOnLoad="1"');
    expect(part(files, "xl/worksheets/sheet2.xml")).toContain(
      `<hyperlink ref="A1" location="'Table  Q3  draft'!B2" display="B2"/>`,
    );
  });

  // protects=a sheet with more notes than a block of 1,024 shape ids lists every block its notes use, and the next sheet's notes start after them; fails_when=two drawings share a shape id or one falls outside its drawing's blocks, which Excel repairs by dropping notes; no_claim=Excel itself (a person, with the 1,000-row table).
  test("gives each sheet's notes shape ids of their own, however many there are", () => {
    const noted = (id: string, count: number): Sheet => ({
      id,
      name: id,
      columns: [{ id: "a" }],
      rows: Array.from({ length: count }, (_, at) => ({
        id: `row-${at}`,
        cells: [{ column: "a", value: { kind: "number", number: at }, note: `Note ${at}` }],
      })),
    });
    const files = unzip(write({ sheets: [noted("many", 1_500), noted("few", 2)] }));
    const shapes = (name: string) =>
      [...part(files, name).matchAll(/id="_x0000_s(\d+)"/g)].map((match) => Number(match[1]));
    const many = shapes("xl/drawings/vmlDrawing1.vml");
    expect(part(files, "xl/drawings/vmlDrawing1.vml")).toContain(
      '<o:idmap v:ext="edit" data="1,2"/>',
    );
    expect([many.length, many[0], many.at(-1)]).toEqual([1_500, 1_025, 2_524]);
    expect(part(files, "xl/drawings/vmlDrawing2.vml")).toContain(
      '<o:idmap v:ext="edit" data="3"/>',
    );
    expect(shapes("xl/drawings/vmlDrawing2.vml")).toEqual([3_073, 3_074]);
  });

  // protects=a link naming a cell the book doesn't have fails, as a formula's does, rather than pointing at A1; fails_when=the book is written with a link to the wrong cell; no_claim=none beyond protects.
  test("refuses a link to a cell the book doesn't have", () => {
    const linked: SheetBook = {
      sheets: [
        {
          id: "s",
          name: "S",
          columns: [{ id: "a" }],
          rows: [
            {
              id: "r",
              cells: [
                {
                  column: "a",
                  value: { kind: "text", text: "See" },
                  link: { sheet: "s", row: "missing", column: "a" },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => write(linked)).toThrow("No cell s/missing/a in the book.");
  });

  // protects=the cells read back as Excel shows them, by row and column id whatever order they were given in, with their notes and frozen headings; fails_when=a number is stored as text, a format or note is lost, or a cell lands in another column; no_claim=row heights.
  test("reads back as the book said, numbers as numbers and each note on its cell", async () => {
    const [table, sources] = await shown(write(book));
    expect(table?.name).toBe("Table  Q3  draft");
    expect(table?.cells.A1?.value).toBe("Document");
    expect(table?.cells.B1?.value).toBe("Revenue");
    expect(table?.cells.A2?.value).toBe("Acme & Co <draft>");
    expect(table?.cells.B2).toMatchObject({ value: "$1.2m", numeric: true, raw: 1_200_000 });
    expect(table?.shown("B2")).toBe("$1.2m");
    expect(table?.cells.B3).toMatchObject({ value: "2026-03-31", numeric: true });
    expect(table?.shown("B3")).toBe("31 March 2026");
    expect(table?.cells.A3?.value).toHaveLength(MAX_CELL_TEXT);
    // The reader names a note's author first, as Excel shows one.
    expect([...(table?.notes?.values() ?? [])]).toEqual(["IncarnaMind:\nAs written: $1.2m"]);
    expect(table?.frozen).toEqual({ rows: 1, columns: 1 });
    expect(sources?.cells.A1?.value).toBe("Acme · Revenue");
  });
});
