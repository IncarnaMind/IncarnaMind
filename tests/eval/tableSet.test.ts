/**
 * The table set (eval/tables/labels.json, #1368): every labelled table is read from its PDF with
 * its headings and every cell where the page has it, and the pages labelled as holding none,
 * though their text sits in columns, give none. A reading that drifts shows here.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type PagePart, pdfTablePages } from "../../src/core/documents/extract";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface Labels {
  tables: { file: string; page: number; headings: string[]; rows: string[][] }[];
  none: { file: string; pages: number[] }[];
}

const labels = JSON.parse(await readFile(join(ROOT, "eval/tables/labels.json"), "utf8")) as Labels;

// Some PDFs print CJK characters with Kangxi radicals' code points ("⽬" for "目"), and pdf.js reads
// them so: the set compares what a person reads.
const asRead = (text: string) =>
  text.replace(/[\u2f00-\u2fdf]/gu, (radical) => radical.normalize("NFKC"));

const read = new Map<string, Promise<Map<number, PagePart[]>>>();
const tablesOn = async (file: string, page: number) => {
  if (!read.has(file)) {
    read.set(
      file,
      readFile(join(ROOT, file)).then((bytes) => pdfTablePages(new Uint8Array(bytes))),
    );
  }
  const parts = (await read.get(file))?.get(page) ?? [];
  return parts.flatMap((part) =>
    part.kind === "table"
      ? [
          {
            headings: part.grid.headings.map(asRead),
            rows: part.grid.rows.map((row) => row.cells.map(asRead)),
          },
        ]
      : [],
  );
};

describe("the table set", { timeout: 60_000 }, () => {
  test("every labelled table is read as labelled", async () => {
    const pages = [...new Set(labels.tables.map(({ file, page }) => `${file}#${page}`))];
    for (const key of pages) {
      const [file = "", page = "0"] = key.split("#");
      const expected = labels.tables
        .filter((table) => table.file === file && table.page === Number(page))
        .map(({ headings, rows }) => ({
          headings: headings.map(asRead),
          rows: rows.map((cells) => cells.map(asRead)),
        }));
      expect(await tablesOn(file, Number(page)), key).toEqual(expected);
    }
  });

  test("pages whose text only sits in columns hold no table", async () => {
    for (const { file, pages } of labels.none) {
      for (const page of pages) expect(await tablesOn(file, page), `${file}#${page}`).toEqual([]);
    }
  });
});
