/**
 * The sheets read_table gives `run_code`'s Python (ADR-0025): a workbook's visible sheets, and
 * its hidden ones only when the User had the Library read them, as the index then cites them.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { CitationSource } from "../../src/core/documents";
import { readTables, TABLE_LIMITS } from "../../src/main/runCode/runner";
import { xlsxOf } from "../helpers/office";

const SOURCE: CitationSource = {
  passageId: "passage-book",
  text: "Region",
  pageFrom: null,
  pageTo: null,
  documentId: "doc-book",
  documentName: "book",
  documentKind: "xlsx",
  contentHash: "a".repeat(64),
  documentDeleted: false,
  notCited: false,
};

test("a hidden sheet is given only where the User had the Library read hidden sheets", async () => {
  const folder = await mkdtemp(join(tmpdir(), "incarnamind-tables-"));
  const file = join(folder, "book.xlsx");
  await writeFile(
    file,
    xlsxOf([
      { name: "Visible", rows: [["Region"], ["North"]] },
      { name: "Q3 raw", state: "hidden", rows: [["Secret"], ["1"]] },
    ]),
  );
  const names = async (readHidden: boolean) =>
    (await readTables(file, "book.xlsx", SOURCE, readHidden)).map((table) => table.job.name);
  expect(await names(false)).toEqual(["book.xlsx!Visible"]);
  expect(await names(true)).toEqual(["book.xlsx!Visible", "book.xlsx!Q3 raw"]);
});

test("a CSV of 199,999 rows below its heading is read whole, as far as read_table's limit", async () => {
  const folder = await mkdtemp(join(tmpdir(), "incarnamind-tables-"));
  const file = join(folder, "orders.csv");
  const rows = Array.from({ length: 199_999 }, (_, at) => `${at + 1},${(at % 997) + 0.5}`);
  await writeFile(file, ["id,amount", ...rows, ""].join("\n"));
  const [table] = await readTables(file, "orders.csv", { ...SOURCE, documentKind: "csv" }, false);
  expect(TABLE_LIMITS.rows).toBe(200_000);
  expect(table?.job.rows).toHaveLength(199_999);
  expect(table?.job.rows.at(-1)).toEqual([199_999, 598.5]);
});
