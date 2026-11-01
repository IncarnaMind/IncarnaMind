/**
 * `npm run eval:excel` (#2347): a what-if IncarnaMind works out from a
 * workbook's own formulas gives what LibreOffice gives recalculating the same
 * change. Each test model (a DCF, an LBO, three linked statements and one of
 * over 10,000 formulas) is read as IncarnaMind stores it, one input is
 * changed in memory and the figure worked out again; LibreOffice headless
 * opens a copy of the file with that input's cell changed, recalculates every
 * formula and saves it, and the figure's saved value there is compared. The
 * file IncarnaMind read stays byte for byte as it was. CI runs it in the job
 * that installs LibreOffice; without LibreOffice it only works the what-ifs
 * out, unless INCARNAMIND_EXCEL_REQUIRE_LIBREOFFICE=1 makes that a failure.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import { extractXlsx } from "../../src/core/documents/formats/xlsx";
import { openPackage, writeZip, type ZipWriteEntry } from "../../src/core/documents/formats/zip";
import { cellIndex, workbookModel } from "../../src/core/workbooks/model";
import { placeKey, WorkbookEngine } from "../../src/core/workbooks/recalculate";
import { whatIf } from "../../src/core/workbooks/trace";
import {
  dcfWorkbook,
  largeWorkbook,
  lboWorkbook,
  refParts,
  threeStatementWorkbook,
  type WorkbookBuilder,
} from "../../tests/helpers/financeWorkbooks";
import { convertFile, findLibreOffice } from "../word/libreoffice";

const REQUIRED = process.env.INCARNAMIND_EXCEL_REQUIRE_LIBREOFFICE === "1";

interface Case {
  name: string;
  book: () => WorkbookBuilder;
  figure: string;
  input: string;
  value: number;
}

const CASES: Case[] = [
  {
    name: "DCF: 2027 EBITDA, growth 3%",
    book: dcfWorkbook,
    figure: "DCF!E5",
    input: "Assumptions!B4",
    value: 0.03,
  },
  {
    name: "DCF: value per share, WACC 10%",
    book: dcfWorkbook,
    figure: "DCF!B21",
    input: "Assumptions!B10",
    value: 0.1,
  },
  {
    name: "DCF: NPV of free cash flow, margin 25%",
    book: dcfWorkbook,
    figure: "DCF!B22",
    input: "Assumptions!B5",
    value: 0.25,
  },
  {
    name: "LBO: IRR, exit at 9.5x",
    book: lboWorkbook,
    figure: "LBO!B32",
    input: "LBO!B8",
    value: 9.5,
  },
  {
    name: "LBO: XIRR, EBITDA growth 4%",
    book: lboWorkbook,
    figure: "LBO!B33",
    input: "LBO!B7",
    value: 0.04,
  },
  {
    name: "LBO: term loan payment, rate 7%",
    book: lboWorkbook,
    figure: "LBO!B34",
    input: "LBO!B6",
    value: 0.07,
  },
  {
    name: "Three statements: 2027 cash, 2026 growth 10%",
    book: threeStatementWorkbook,
    figure: "BS!E3",
    input: "Inputs!C2",
    value: 0.1,
  },
  {
    name: "Three statements: 2027 net income, tax 25%",
    book: threeStatementWorkbook,
    figure: "IS!E13",
    input: "Inputs!B8",
    value: 0.25,
  },
  {
    name: "Three statements: balance check, capex 90",
    book: threeStatementWorkbook,
    figure: "BS!E10",
    input: "Inputs!B10",
    value: 90,
  },
  {
    name: "12,120 formulas: last month's total, product 1 growth 0.2%",
    book: () => largeWorkbook(),
    figure: "Model!DQ102",
    input: "Drivers!B2",
    value: 0.002,
  },
];

function place(written: string): { sheet: string; row: number; column: number } {
  const [sheet, ref] = written.split("!") as [string, string];
  const { row, column } = refParts(ref);
  return { sheet, row, column };
}

/**
 * A copy of the workbook with one cell's value changed and every formula's saved result taken
 * out, so LibreOffice works each one out itself whatever its recalculation setting.
 */
async function changedCopy(bytes: Uint8Array, book: WorkbookBuilder, input: string, value: number) {
  const { sheet } = place(input);
  const part = `xl/worksheets/sheet${book.sheets.findIndex((each) => each.name === sheet) + 1}.xml`;
  const zip = openPackage(bytes);
  const ref = input.split("!")[1] as string;
  const cell = new RegExp(`<c r="${ref}"([^>]*)><v>[^<]*</v></c>`);
  const changed = new Map<string, string>();
  for (const name of zip.names()) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    let xml = (await zip.readText(name)) ?? "";
    if (name === part) {
      if (!cell.test(xml)) throw new Error(`No value in ${input}.`);
      xml = xml.replace(cell, `<c r="${ref}"$1><v>${value}</v></c>`);
    }
    changed.set(name, xml.replace(/(<f[^>]*\/>|<f[^>]*>[^<]*<\/f>)<v>[^<]*<\/v>/g, "$1"));
  }
  changed.set(
    "xl/workbook.xml",
    ((await zip.readText("xl/workbook.xml")) ?? "").replace(
      "<calcPr ",
      '<calcPr fullCalcOnLoad="1" ',
    ),
  );
  const entries: ZipWriteEntry[] = zip.names().flatMap((name): ZipWriteEntry[] => {
    const data = changed.get(name);
    const raw = zip.raw(name);
    if (data !== undefined) return [{ name, data }];
    return raw ? [{ name, raw }] : [];
  });
  const copy = join(await mkdtemp(join(tmpdir(), "incarnamind-what-if-")), "changed.xlsx");
  await writeFile(copy, writeZip(entries, deflateRawSync));
  return copy;
}

/** The value a workbook saved in a cell, as IncarnaMind reads it. */
async function savedValue(bytes: Uint8Array, written: string): Promise<unknown> {
  const { units } = await extractXlsx(bytes);
  const model = workbookModel("libreoffice", "copy", units);
  const { sheet, row, column } = place(written);
  return model?.byName.get(sheet.toUpperCase())?.cells.get(cellIndex(row, column))?.saved;
}

const close = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);

test.each(CASES)(
  "$name: IncarnaMind's what-if equals LibreOffice recalculating it",
  async (each) => {
    const soffice = findLibreOffice();
    if (!soffice && REQUIRED) throw new Error("LibreOffice isn't installed (INCARNAMIND_SOFFICE).");
    const book = each.book();
    const bytes = new Uint8Array(book.xlsx());
    const file = join(await mkdtemp(join(tmpdir(), "incarnamind-model-")), "model.xlsx");
    await writeFile(file, bytes);
    const before = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");

    const { units } = await extractXlsx(new Uint8Array(await readFile(file)));
    const model = workbookModel("model", "version", units);
    if (!model) throw new Error("No formulas were kept.");
    const engine = new WorkbookEngine(model);
    const key = (written: string) => {
      const { sheet, row, column } = place(written);
      const found = model.byName.get(sheet.toUpperCase());
      if (!found) throw new Error(`No sheet ${sheet}`);
      return placeKey(found, row, column);
    };
    let longest = 0;
    let last = performance.now();
    const lag = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 1);
    const outcome = await whatIf(engine, key(each.figure), key(each.input), each.value);
    clearInterval(lag);
    if (!outcome.ok) throw new Error(`Refused: ${JSON.stringify(outcome.why)}`);
    console.log(
      `${each.name}: ${outcome.before} → ${outcome.after}; ${outcome.formulaCells} formulas in ${outcome.ms.toFixed(1)} ms, the longest stretch without giving way ${longest.toFixed(1)} ms`,
    );
    expect(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    ).toBe(before);

    if (!soffice) return;
    const recalculated = await convertFile(
      soffice,
      await changedCopy(bytes, book, each.input, each.value),
      "xlsx",
      ".xlsx",
    );
    expect(recalculated.opened, recalculated.problem).toBe(true);
    const libreOffice = await savedValue(
      new Uint8Array(recalculated.data ?? Buffer.alloc(0)),
      each.figure,
    );
    console.log(`  LibreOffice: ${String(libreOffice)}`);
    expect(typeof libreOffice).toBe("number");
    expect(close(outcome.after, libreOffice as number)).toBe(true);
    // Unchanged, LibreOffice works the figure out to what IncarnaMind worked it out to.
    const { sheet } = place(each.input);
    const saved = book.get(sheet).n(each.input.split("!")[1] as string);
    const unchanged = await convertFile(
      soffice,
      await changedCopy(bytes, book, each.input, saved),
      "xlsx",
      ".xlsx",
    );
    expect(unchanged.opened, unchanged.problem).toBe(true);
    const base = await savedValue(new Uint8Array(unchanged.data ?? Buffer.alloc(0)), each.figure);
    console.log(`  LibreOffice unchanged: ${String(base)}`);
    expect(close(outcome.before, base as number)).toBe(true);
  },
);
