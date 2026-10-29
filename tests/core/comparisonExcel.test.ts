/**
 * A comparison table exported to Excel (#132), through the core as the
 * expanded table's "Export to Excel" asks for it, and read back with the
 * app's own workbook reader, which shows each cell as Excel would.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import type { CitedWork } from "../../src/core/api";
import { cellIndex } from "../../src/core/documents/formats/sheetLayout";
import { readWorkbook } from "../../src/core/documents/formats/xlsx";
import { comparisonBook } from "../../src/core/exports/comparisonSheet";
import { type ComparisonReading, type Footnote, NO_MARKS } from "../../src/core/mindText";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import {
  compareCedar,
  compareReports,
  copyRows,
  REPORT_QUESTIONS as QUESTIONS,
  rescalingModel,
} from "../helpers/comparisons";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess } from "../helpers/documents";
import { part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";

/** The workbook as Excel shows it: each sheet's cells by reference, with their notes. */
async function shownWorkbook(path: string) {
  const data = new Uint8Array(await readFile(path));
  const { sheets } = await readWorkbook(data, undefined, {});
  return {
    files: unzip(data),
    sheets: sheets.map((sheet) => {
      const at = (ref: string) => {
        const column = ref.charCodeAt(0) - 65;
        const row = Number(ref.slice(1));
        const cell = sheet.cells.find((each) => each.row === row && each.column === column);
        return {
          text: sheet.layout?.shown.get(cellIndex(row, column))?.text ?? cell?.value,
          numeric: cell?.numeric ?? false,
          raw: cell?.raw,
          note: sheet.layout?.notes.get(cellIndex(row, column)),
        };
      };
      const width = (column: number) =>
        sheet.layout?.columns.get(column)?.width ?? sheet.layout?.defaultColumnWidth ?? 0;
      return { name: sheet.name, rowCount: sheet.rowCount, at, width };
    }),
  };
}

describe("A comparison table exported to Excel", () => {
  // protects=a Document a row and a Question a column; an Answer that is one figure lands as a number or day a formula can use, shown as written, brackets as a minus, its words in its note; others stay text; fails_when=a figure is stored as text, loses its sign or scale, or a row or column moves; no_claim=Excel's own rendering (LibreOffice in CI, a person in Excel).
  test("puts each Answer in its cell, single figures as numbers and days, with the Citations in the cell's note", async () => {
    const { core, mind, tableId } = await compareReports();
    const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    expect(saved).toMatchObject({ unverifiedCitations: 0 });
    expect(saved.file.name).toBe("Comparison table.xlsx");

    const { sheets } = await shownWorkbook(saved.file.path);
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Comparison table", "Sources"]);
    const [table] = sheets;
    if (!table) throw new Error("No table sheet.");
    expect(["A1", "B1", "C1", "D1", "E1", "F1"].map((ref) => table.at(ref).text)).toEqual([
      "Document",
      ...QUESTIONS,
    ]);
    expect([table.at("A2").text, table.at("A3").text]).toEqual(["Acme", "Brandt"]);

    expect(table.at("B2")).toMatchObject({ text: "$1.2m", numeric: true, raw: 1_200_000 });
    expect(table.at("C2")).toMatchObject({ text: "(3,400)", numeric: true, raw: -3_400 });
    expect(table.at("D2")).toMatchObject({ text: "12.5%", numeric: true, raw: 0.125 });
    expect(table.at("E2")).toMatchObject({ text: "31 March 2026", numeric: true });
    expect(table.at("F2")).toMatchObject({
      text: "Smith & Partners, appointed in 2019",
      numeric: false,
    });
    expect(table.at("B3")).toMatchObject({ numeric: true, raw: 1_200_000 });
    expect(table.at("C3")).toMatchObject({ numeric: true, raw: -1_250 });
    expect(table.at("E3")).toMatchObject({ text: "31 December 2025", numeric: true });

    expect(table.at("B2").note).toContain("As written: $1.2m");
    expect(table.at("B2").note).toContain("Acme");
    expect(table.at("B2").note).toContain("“Revenue: $1.2m.”");
    expect(table.at("F2").note).not.toContain("As written");
    expect(table.at("F2").note).toContain("“Auditor: Smith & Partners, appointed in 2019.”");
  });

  // protects=a named table names the workbook and its table sheet; fails_when=the file or sheet keeps the Mind's name or the default "Comparison table"; no_claim=Excel's own rendering of sheet names.
  test("names the file and the sheet after the table's own name", async () => {
    const { core, client, mind, tableId } = await compareReports();
    client.doc.transact(() => {
      const table = client.doc
        .getXmlFragment(MIND_CONTENT_FIELD)
        .toArray()
        .find(
          (block): block is Y.XmlElement =>
            block instanceof Y.XmlElement && block.getAttribute("id") === tableId,
        );
      table?.setAttribute("title", "Refinancing offers");
    });
    await client.settled();
    const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    expect(saved.file.name).toBe("Refinancing offers.xlsx");
    const { sheets } = await shownWorkbook(saved.file.path);
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Refinancing offers", "Sources"]);
  });

  // protects=the Sources sheet lists each Citation, a row each, with its Document, Location, quote and check, and opens the cell that cites it; fails_when=a Citation is missing, or its row links elsewhere; no_claim=none beyond protects.
  test("lists every Citation on a Sources sheet that links back to its cell", async () => {
    const { core, mind, tableId } = await compareReports();
    const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const { sheets, files } = await shownWorkbook(saved.file.path);
    const sources = sheets[1];
    if (!sources) throw new Error("No Sources sheet.");
    expect(sources.rowCount).toBe(11);
    expect(["A1", "B1", "C1", "D1", "E1"].map((ref) => sources.at(ref).text)).toEqual([
      "Cell",
      "Document",
      "Location",
      "Quote",
      "Result",
    ]);
    expect(["A2", "B2", "D2", "E2"].map((ref) => sources.at(ref).text)).toEqual([
      "Acme · Revenue",
      "Acme",
      "Revenue: $1.2m.",
      "Quote found",
    ]);
    expect(part(files, "xl/worksheets/sheet2.xml")).toContain(
      `<hyperlink ref="A2" location="'Comparison table'!B2" display="B2"/>`,
    );
  });

  // protects=a cell whose amount changed scale exports as what its Document gives, with no Citation on the Sources sheet, so the sheets agree (#1798); fails_when=the wrong amount, or a Source for it, reaches the workbook; no_claim=none beyond protects.
  test("writes a cell whose amount changed scale as what its Document gives, with no Source for it", async () => {
    const { core, mind, tableId } = await compareCedar(rescalingModel(() => false));
    const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const [table, sources] = (await shownWorkbook(saved.file.path)).sheets;
    if (!table || !sources) throw new Error("A sheet is missing.");
    expect(table.at("B2")).toMatchObject({
      text: "scale differs from the Document, which gives 310000 GBP thousands",
      numeric: false,
    });
    expect(table.at("B3")).toMatchObject({ text: "GBP 340 million", numeric: true, raw: 340e6 });
    expect(sources.rowCount).toBe(2);
    expect(sources.at("A2").text).toBe(
      "Cedar Q3 2026 draft · Net debt at Q3 2026, in GBP millions",
    );
  });

  // protects=the workbook is IncarnaMind's own file, so checks leave it out of their evidence wherever it is saved (#80); fails_when=its fingerprint isn't recorded; no_claim=none beyond protects.
  test("is recorded as IncarnaMind's own file", async () => {
    const { core, mind, tableId } = await compareReports();
    const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const [added] = await addAndProcess(core, [saved.file.path]);
    expect(added?.ownFile).toEqual({ kind: "export", counted: false });
  });

  // protects=the workbook's own words follow the interface language; fails_when=a Chinese User gets English sheet names and headings; no_claim=the Answers, which are the model's.
  test("names its sheets and headings in the interface language", async () => {
    const { core, mind, tableId } = await compareReports();
    await core.updateSettings({ user: { language: "zh-CN" } });
    const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const { sheets } = await shownWorkbook(saved.file.path);
    expect(sheets.map((sheet) => sheet.name)).toEqual(["对比表", "来源"]);
    expect(sheets[0]?.at("A1").text).toBe("文档");
    expect(sheets[0]?.at("B2").note).toContain("原文：$1.2m");
    expect(sheets[1]?.at("E2").text).toBe("找到引文");
  });

  // protects=a table of 1,000 rows exports whole; fails_when=rows are dropped or the export fails on size; no_claim=how long it takes, which the CI run reports.
  test("exports a table of 1,000 rows", async () => {
    const { core, client, mind, tableId } = await compareReports();
    await copyRows(client, tableId, 1_000);
    const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const { sheets } = await shownWorkbook(saved.file.path);
    expect(sheets[0]?.rowCount).toBe(1_001);
    expect(sheets[1]?.rowCount).toBe(5_001);
    expect(sheets[0]?.at("B1001")).toMatchObject({ text: "$1.2m", raw: 1_200_000 });
  });

  // protects=a table that isn't in the Mind is said plainly; fails_when=an empty workbook is saved; no_claim=none beyond protects.
  test("says so when the table isn't in the Mind", async () => {
    const { core, mind } = await compareReports();
    await expect(
      core.saveComparisonExport({ mindId: mind.id, tableId: "no-such-table" }),
    ).rejects.toThrow(translate("en", "error.comparison.notFound"));
  });

  // protects=a column's label is its heading and names its Citations, and a column without one keeps its whole Question, as an older table did, however long; fails_when=a heading shows the Question instead of the label, a Question is cut to a heading's length, or a label is needed for an older table; no_claim=Excel's own rendering.
  test("a column's label is its heading in the table and in Sources", () => {
    const t = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
    const caption: Footnote = { source: "Corvane, p. 1", unverified: false };
    const work: CitedWork = { documentId: "doc", documentName: "Corvane", location: null };
    const question = "What notice, in days, must either party give to end the agreement, and when?";
    const reading = (label?: string): ComparisonReading => ({
      questions: [{ id: "q1", text: question, ...(label && { label }) }],
      rows: [
        {
          documentId: "doc",
          name: "Corvane",
          cells: [
            {
              kind: "answer",
              content: [
                {
                  kind: "paragraph",
                  content: [
                    { kind: "text", text: "90 days", marks: NO_MARKS },
                    { kind: "citation", footnote: caption, work },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const bookOf = (label?: string) =>
      comparisonBook({
        reading: reading(label),
        title: "Comparison table",
        textLanguage: "en",
        t,
        facts: () => ({
          document: "Corvane",
          location: "p. 1",
          quote: "90 days",
          check: "found",
        }),
      }).book;
    const headings = (book: ReturnType<typeof bookOf>) =>
      book.sheets[0]?.rows[0]?.cells.map((cell) =>
        cell.value.kind === "text" ? cell.value.text : "",
      );

    expect(headings(bookOf("Notice"))).toEqual(["Document", "Notice"]);
    expect(headings(bookOf())).toEqual(["Document", question]);
    expect(question.length).toBeGreaterThan(40);
    const source = bookOf("Notice").sheets[1]?.rows[1]?.cells[0]?.value;
    expect(source?.kind === "text" ? source.text : "").toBe("Corvane · Notice");
    const unnamed = bookOf().sheets[1]?.rows[1]?.cells[0]?.value;
    expect(unnamed?.kind === "text" ? unnamed.text : "").toBe(`Corvane · ${question}`);
  });

  // protects=a hidden column is left out of the workbook with no line, the app is told the count, and a column the User sized is wider in the file; fails_when=the hidden column's heading or Answers appear, the file mentions a hidden column, or the set width does not reach Excel; no_claim=Excel's own rendering.
  test("leaves a hidden column out with no line, and keeps the User's column widths", async () => {
    const core = startCore(await createTempDataFolder());
    onTestFinished(() => core.close());
    const mind = await core.createMind({ title: "Suppliers" });
    const client = await connectToMind(core, mind.id);
    const paragraph = (text: string): NodeJSON => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    });
    const sheet: NodeJSON = {
      type: "comparisonTable",
      attrs: {
        id: "table-1",
        questions: [
          { id: "q1", text: "Termination notice", label: "Notice", width: 420 },
          { id: "q2", text: "Operating result", label: "Result", hidden: true },
        ],
      },
      content: [
        {
          type: "comparisonRow",
          attrs: { documentId: "acme", documentName: "Acme" },
          content: [
            {
              type: "comparisonCell",
              attrs: { questionId: "q1", status: "done" },
              content: [paragraph("90 days")],
            },
            {
              type: "comparisonCell",
              attrs: { questionId: "q2", status: "done" },
              content: [paragraph("12 months")],
            },
          ],
        },
      ],
    };
    client.doc.transact(() =>
      client.doc.getXmlFragment(MIND_CONTENT_FIELD).push([createElement(sheet)]),
    );
    await client.settled();

    const saved = await core.saveComparisonExport({ mindId: mind.id, tableId: "table-1" });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const { sheets } = await shownWorkbook(saved.file.path);
    const [table] = sheets;
    if (!table) throw new Error("No table sheet.");
    expect(["A1", "B1", "C1"].map((ref) => table.at(ref).text)).toEqual([
      "Document",
      "Notice",
      undefined,
    ]);
    expect(table.at("B2").text).toBe("90 days");
    // The file leaves the column out and says nothing about it; the app is told the count.
    expect(table.at("C2").text).toBeUndefined();
    expect(saved.hiddenColumns).toBe(1);
    expect(table.width(1)).toBeGreaterThan(table.width(0));
  });
});
