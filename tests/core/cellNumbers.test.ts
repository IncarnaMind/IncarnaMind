/**
 * A workbook's cells keep their number beside how they show (ADR-0011, #435):
 * a rows Unit's label lists the number of each cell whose shown text isn't
 * that number written plainly, so a calculation uses 0.04213 where the sheet
 * shows "4.2%". A CSV's cells are their text; the Citation check reads the
 * shown text, as before.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE, type Document } from "../../src/core";
import { extractCsv } from "../../src/core/documents/formats/csv";
import { extractXlsx } from "../../src/core/documents/formats/xlsx";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { openDatabase } from "../../src/core/storage";
import { cellNumber } from "../../src/shared/units";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { xlsxPackage } from "../helpers/office";

const STYLES = [
  `<numFmts count="3"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="&quot;£&quot;#,##0"/><numFmt numFmtId="166" formatCode="0.00"/></numFmts>`,
  `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`,
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`,
  `<borders count="1"><border><left/><right/><top/><bottom/></border></borders>`,
  `<cellXfs count="5">`,
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`,
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0"/>`,
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0"/>`,
  `<xf numFmtId="14" fontId="0" fillId="0" borderId="0"/>`,
  `<xf numFmtId="166" fontId="0" fillId="0" borderId="0"/>`,
  `</cellXfs>`,
].join("");

const text = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const number = (ref: string, style: number, value: number) =>
  `<c r="${ref}" s="${style}"><v>${value}</v></c>`;

/** Styles: 1 percent, 2 currency, 3 date, 4 two decimals. 46114 is 2026-04-02. */
const workbook = (rows: string) =>
  xlsxPackage({
    sheets: [{ name: "Revenue", xml: `<sheetData>${rows}</sheetData>` }],
    styles: STYLES,
  });

const SMALL = workbook(
  `<row r="1">${text("A1", "Item")}${text("B1", "Amount")}${text("C1", "Share")}${text("D1", "Date")}${text("E1", "Count")}${text("F1", "Ratio")}</row>` +
    `<row r="2">${text("A2", "West")}${number("B2", 2, 350200.4)}${number("C2", 1, 0.04213)}${number("D2", 3, 46114)}${number("E2", 0, 12)}${number("F2", 4, 1.5)}</row>` +
    `<row r="3">${text("A3", "East")}${number("B3", 0, 100)}${number("C3", 0, 0.5)}${number("D3", 0, 7)}${number("E3", 1, 0.25)}${number("F3", 4, 2.125)}</row>`,
);

describe("a workbook's cells keep their number beside how they show", () => {
  test("percent and currency cells keep the stored number; plain numbers, dates and text keep none", async () => {
    const { units } = await extractXlsx(new Uint8Array(SMALL));

    expect(units).toHaveLength(1);
    expect(units[0]?.text.split("\n")[1]).toBe("West\t£350,200\t4.2%\t2026-04-02\t12\t1.50");
    // Sparse: the percent, the currency, the extra decimal place; not B3, C3, D2, D3, E2, the words.
    expect(units[0]?.label?.values).toEqual({
      B2: 350200.4,
      C2: 0.04213,
      E3: 0.25,
      F2: 1.5,
      F3: 2.125,
    });
    const label = units[0]?.label;
    expect(cellNumber(label, "C2")).toBe(0.04213);
    expect(cellNumber(label, "c2")).toBe(0.04213);
    expect(cellNumber(label, "B3")).toBeNull(); // shows its number plainly
    expect(cellNumber(label, "D2")).toBeNull(); // a date stays ISO text
    expect(cellNumber(label, "A2")).toBeNull();
    expect(cellNumber(label, "Z99")).toBeNull();
    expect(cellNumber(label, "not a cell")).toBeNull();
    expect(cellNumber(null, "C2")).toBeNull();
  });

  test("a sheet of plain numbers has no values at all", async () => {
    const bytes = workbook(
      `<row r="1">${text("A1", "Item")}${text("B1", "Units")}</row><row r="2">${text("A2", "West")}${number("B2", 0, 42)}</row>`,
    );
    const { units } = await extractXlsx(new Uint8Array(bytes));
    expect(units[0]?.label).not.toHaveProperty("values");
  });

  test("a CSV keeps no numbers: its cells are their text", () => {
    const { units } = extractCsv(
      new TextEncoder().encode("Item,Share\nWest,4.2%\nEast,£350,200\n"),
    );
    expect(units[0]?.text).toContain("4.2%");
    expect(units.every((unit) => !unit.label || !("values" in unit.label))).toBe(true);
  });

  test("each block keeps the numbers of its own rows, by their place in the sheet", async () => {
    const rows = Array.from(
      { length: 250 },
      (_, index) =>
        `<row r="${index + 2}">${text(`A${index + 2}`, `Row ${index}`)}${number(`B${index + 2}`, 1, (index + 1) / 1000)}</row>`,
    );
    const header = `<row r="1">${text("A1", "Item")}${text("B1", "Share")}</row>`;
    const { units } = await extractXlsx(new Uint8Array(workbook(header + rows.join(""))));

    expect(units.length).toBeGreaterThan(1);
    for (const unit of units) {
      const own = (unit.label?.rows ?? []).slice(unit.label?.header ? 1 : 0);
      expect(Object.keys(unit.label?.values ?? {})).toEqual(
        own.filter((row) => row > 1).map((row) => `B${row}`),
      );
    }
    expect(cellNumber(units[2]?.label, `B${units[2]?.label?.from}`)).toBe(
      ((units[2]?.label?.from ?? 0) - 1) / 1000,
    );
  });

  test("the size the numbers take on the 1,200-row test workbook", async () => {
    // Monthly sales by region and product: units and dates plain or ISO, price and revenue in
    // currency, margin in percent, as the design's example workbook.
    const body = Array.from({ length: 1200 }, (_, index) => {
      const row = index + 2;
      return (
        `<row r="${row}">${number(`A${row}`, 3, 46000 + index)}${text(`B${row}`, ["North", "South", "East", "West"][index % 4] as string)}` +
        `${text(`C${row}`, `Product ${index % 12}`)}${number(`D${row}`, 0, 10 + (index % 90))}` +
        `${number(`E${row}`, 4, 12.5 + (index % 7) * 0.25)}${number(`F${row}`, 2, 125.4 + index * 3.37)}` +
        `${number(`G${row}`, 1, 0.1 + (index % 50) / 1000)}</row>`
      );
    });
    const header = `<row r="1">${["Date", "Region", "Product", "Units", "Price", "Revenue", "Margin"].map((name, column) => text(`${"ABCDEFG"[column]}1`, name)).join("")}</row>`;
    const { units } = await extractXlsx(new Uint8Array(workbook(header + body.join(""))));

    const sized = units.map((unit) => ({
      values: JSON.stringify(unit.label?.values ?? {}).length,
      text: unit.text.length,
    }));
    const total = (key: "values" | "text") => sized.reduce((sum, unit) => sum + unit[key], 0);
    // 38 rows Units, 59.6 kB of text and 52.7 kB of numbers when measured for #435 (the pull request states it).
    expect(units.length).toBeGreaterThan(1);
    // Revenue and margin in every row, price in most (12.75 shows as it is): never the dates or units.
    const kept = units.reduce((sum, unit) => sum + Object.keys(unit.label?.values ?? {}).length, 0);
    expect(kept).toBeGreaterThanOrEqual(1200 * 2);
    expect(kept).toBeLessThanOrEqual(1200 * 3);
    // The numbers take less than the rows' text does, though three cells in seven have one.
    expect(total("values")).toBeLessThan(total("text"));
  });
});

describe("through the core", { timeout: 30_000 }, () => {
  test("a workbook's numbers are kept and asked for by sheet and cell; a CSV has none", async () => {
    const sources = await createSourceFolder();
    const core = startCore(await createTempDataFolder());
    const [book, csv] = (await addAndProcess(core, [
      await writeSourceFile(sources, "Revenue.xlsx", SMALL),
      await writeSourceFile(sources, "Revenue.csv", "Item,Share\nWest,4.2%\n"),
    ])) as [Document, Document];

    expect(core.readCellNumber(book.id, "Revenue", "C2")).toBe(0.04213);
    expect(core.readCellNumber(book.id, "Revenue", "B3")).toBeNull();
    expect(core.readCellNumber(book.id, "Other", "C2")).toBeNull();
    expect(core.readCellNumber(csv.id, null, "B2")).toBeNull();
    expect(() => core.readCellNumber("gone", "Revenue", "C2")).toThrow();
    const kept = await core.readDocumentText(book.id);
    expect(kept.pages[0]?.text).toContain("4.2%");
    core.close();
  });

  test("a workbook added before this change is processed again and gains its numbers; its Citations still check", async () => {
    const sources = await createSourceFolder();
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const [book, csv] = (await addAndProcess(first, [
      await writeSourceFile(sources, "Revenue.xlsx", SMALL),
      await writeSourceFile(sources, "Revenue.csv", "Item,Share\nWest,4.2%\n"),
    ])) as [Document, Document];
    const quote = { documentId: book.id, quote: "West £350,200 4.2%", pageFrom: 1, pageTo: 1 };
    const checked = await first.recheckCitation(quote);
    expect(checked.check).toBe("found");
    first.close();

    // As version 7 left it: the labels without their numbers.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.transaction(() => {
        db.run("UPDATE documents SET processing_version = 7");
        // The CSV isn't the subject: it stays as this version built it, so only the workbook is read again.
        db.run("UPDATE documents SET processing_version = ? WHERE id = ?", [
          BigInt(PROCESSING_VERSION),
          csv.id,
        ]);
        for (const { id, label } of db.all<{ id: string; label: string }>(
          "SELECT id, label FROM document_pages WHERE label IS NOT NULL",
        )) {
          const { values: _values, ...rest } = JSON.parse(label) as Record<string, unknown>;
          db.run("UPDATE document_pages SET label = ? WHERE id = ?", [JSON.stringify(rest), id]);
        }
      });
    } finally {
      db.close();
    }
    const stored = () =>
      queryDatabase<{ label: string }>(
        dataDir,
        "SELECT label FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
        [book.id],
      );
    expect(stored().every((row) => !row.label.includes("values"))).toBe(true);

    const second = startCore(dataDir);
    const statuses = Object.fromEntries(
      (await second.listDocuments()).map((document) => [document.id, document.status]),
    );
    // Only the workbook is queued.
    expect(statuses).toEqual({ [book.id]: "queued", [csv.id]: "ready" });
    await waitForProcessing(second, [book.id]);

    expect(second.readCellNumber(book.id, "Revenue", "C2")).toBe(0.04213);
    // The Passages are built again, so the Citation's Passage is a new one.
    expect(await second.recheckCitation(quote)).toEqual({
      ...checked,
      passageId: expect.any(String),
    });
    second.close();
  });
});
