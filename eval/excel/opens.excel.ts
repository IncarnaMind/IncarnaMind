/**
 * `npm run eval:excel` (#132): comparison tables exported to Excel, opened in
 * LibreOffice headless. The workbook opens; its single figures are numbers
 * that SUM and AVERAGE, added below the table, work out; and a table of 1,000
 * rows exports in seconds and opens too. CI runs it in a job that installs
 * LibreOffice; without LibreOffice it only exports, unless
 * INCARNAMIND_EXCEL_REQUIRE_LIBREOFFICE=1 makes that a failure.
 * INCARNAMIND_EXCEL_OUT keeps the workbooks and LibreOffice's PDFs for a person.
 */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import { openPackage, writeZip, type ZipWriteEntry } from "../../src/core/documents/formats/zip";
import { compareReports, copyRows } from "../../tests/helpers/comparisons";
import { convertFile, convertToPdf, findLibreOffice } from "../word/libreoffice";

const OUT = process.env.INCARNAMIND_EXCEL_OUT;
const REQUIRED = process.env.INCARNAMIND_EXCEL_REQUIRE_LIBREOFFICE === "1";
/** Its numbers as stored, without their formats; LibreOffice still writes a percentage as "12.5%". */
const RAW_CSV = "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false";

/** The workbook with a row of formulas under the table, as a person adds one in Excel. */
async function withTotals(path: string, formulas: string): Promise<string> {
  const zip = openPackage(new Uint8Array(await readFile(path)));
  const changed = new Map<string, string>([
    [
      "xl/worksheets/sheet1.xml",
      ((await zip.readText("xl/worksheets/sheet1.xml")) ?? "").replace(
        "</sheetData>",
        `${formulas}</sheetData>`,
      ),
    ],
    [
      "xl/workbook.xml",
      ((await zip.readText("xl/workbook.xml")) ?? "").replace(
        "</workbook>",
        '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
      ),
    ],
  ]);
  const entries: ZipWriteEntry[] = zip.names().flatMap((name): ZipWriteEntry[] => {
    const data = changed.get(name);
    const raw = zip.raw(name);
    if (data !== undefined) return [{ name, data }];
    return raw ? [{ name, raw }] : [];
  });
  const copy = join(await mkdtemp(join(tmpdir(), "incarnamind-excel-")), "with totals.xlsx");
  await writeFile(copy, writeZip(entries, deflateRawSync));
  return copy;
}

const rowsOf = (csv: string) =>
  csv
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));

test("a comparison table exported to Excel opens in LibreOffice, its figures numbers that formulas use", async () => {
  const soffice = findLibreOffice();
  if (!soffice && REQUIRED) throw new Error("LibreOffice isn't installed (INCARNAMIND_SOFFICE).");
  if (OUT) await mkdir(OUT, { recursive: true });
  const { core, mind, tableId, client } = await compareReports();

  const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
  if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
  if (OUT) await copyFile(saved.file.path, join(OUT, "comparison.xlsx"));

  if (soffice) {
    const opened = await convertToPdf(
      soffice,
      saved.file.path,
      OUT ? join(OUT, "comparison.pdf") : undefined,
    );
    expect(opened, opened.problem).toMatchObject({ opened: true });

    // Revenue, operating result and gross margin: B, C and D.
    const totals = await withTotals(
      saved.file.path,
      '<row r="4"><c r="B4"><f>SUM(B2:B3)</f></c><c r="C4"><f>SUM(C2:C3)</f></c><c r="D4"><f>AVERAGE(D2:D3)</f></c></row>',
    );
    const csv = await convertFile(soffice, totals, RAW_CSV, ".csv");
    expect(csv.opened, csv.problem).toBe(true);
    const rows = rowsOf(csv.data?.toString("utf8") ?? "");
    console.log(rows.map((row) => row.join(" | ")).join("\n"));
    expect(rows[1]?.slice(1, 4)).toEqual(["1200000", "-3400", "12.5%"]);
    expect(rows[3]?.slice(1, 4)).toEqual(["2400000", "-4650", "10.75%"]);
  }

  // A table of 1,000 rows.
  await copyRows(client, tableId, 1_000);
  const started = performance.now();
  const large = await core.saveComparisonExport({ mindId: mind.id, tableId });
  const seconds = (performance.now() - started) / 1000;
  console.log(`1,000 rows exported in ${seconds.toFixed(2)} s`);
  if (large.status !== "saved") throw new Error(`Not saved: ${large.status}`);
  expect(seconds).toBeLessThan(10);
  if (OUT) await copyFile(large.file.path, join(OUT, "comparison 1000 rows.xlsx"));
  if (soffice) {
    const csv = await convertFile(soffice, large.file.path, RAW_CSV, ".csv");
    expect(csv.opened, csv.problem).toBe(true);
    expect(rowsOf(csv.data?.toString("utf8") ?? "")).toHaveLength(1_001);
  }
});
