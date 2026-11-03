import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { extractXlsx } from "../../src/core/documents/formats/xlsx";
import { rangeParts, type SheetRange } from "../../src/renderer/src/viewer/sheetSelection";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { xlsxOf } from "../helpers/office";

/** The cells of the workbook the viewer's range selection reads (#118). */
const REVENUE = xlsxOf([
  {
    name: "Revenue",
    rows: [
      ["Revenue by segment"],
      ["£m, unaudited"],
      [],
      ["", "Q1", "Q2", "Q3", "9 months"],
      ["2025"],
      [],
      ["Stores", 1412, 1438, 1446, 4296],
      ["Online", 318, 326, 341, 985],
      ["Wholesale", 96, 98, 101, 295],
      [],
      ["2026"],
      ["Stores", 1431, 1452, 1470, 4353],
      ["Online", 352, 361, 329, 1042],
      ["Wholesale", 99, 97, 92, 288],
    ],
  },
]);

async function addWorkbook(core: Core): Promise<Document> {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createSourceFolder(), "Revenue.xlsx", REVENUE),
  ]);
  return document as Document;
}

describe("a range of cells cited from a sheet (#118)", () => {
  test("is found on its rows, at rows 12–14", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addWorkbook(core);

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [
        {
          unit: 1,
          text: "Stores\t1431\t1452\t1470\t4353\nOnline\t352\t361\t329\t1042\nWholesale\t99\t97\t92\t288",
        },
      ],
    });

    expect(cited).toMatchObject({ check: "found", quote: expect.stringContaining("1431") });
    expect(cited.location).toEqual({ kind: "rows", sheet: "Revenue", from: 12, to: 14 });
  });

  test("is found with its header row when one is selected too", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addWorkbook(core);

    const cited = await core.citeSelection({
      documentId: document.id,
      parts: [
        {
          unit: 1,
          text: "\tQ1\tQ2\tQ3\t9 months\n2025\nStores\t1412\t1438\t1446\t4296\nOnline\t318\t326\t341\t985\nWholesale\t96\t98\t101\t295\n2026\nStores\t1431\t1452\t1470\t4353\nOnline\t352\t361\t329\t1042\nWholesale\t99\t97\t92\t288",
        },
      ],
    });

    expect(cited).toMatchObject({ check: "found" });
    expect(cited.location).toEqual({ kind: "rows", sheet: "Revenue", from: 4, to: 14 });
  });
});

/** 220 rows in one sheet: the header, then figures. */
const longSheet = (columns: number) => {
  const header = ["Segment", ...Array.from({ length: columns - 1 }, (_, at) => `Q${at + 1}`)];
  const rows = Array.from({ length: 220 }, (_, at) => [
    `Row ${at + 1}`,
    ...Array.from({ length: columns - 1 }, (_, column) => `${1234567890 + at * 100 + column}`),
  ]);
  return xlsxOf([{ name: "Data", rows: [header, ...rows] }]);
};

const rangeOf = (fromRow: number, toRow: number, toColumn: number): SheetRange => ({
  sheet: "Data",
  fromRow,
  toRow,
  fromColumn: 0,
  toColumn,
  headerRow: 1,
});

async function citeRows(columns: number, fromRow: number, toRow: number): Promise<unknown> {
  const bytes = longSheet(columns);
  const core = startCore(await createTempDataFolder());
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createSourceFolder(), "Data.xlsx", bytes),
  ]);
  if (!document) throw new Error("The workbook wasn't added.");
  const { units } = await extractXlsx(new Uint8Array(bytes));
  const parts = rangeParts(rangeOf(fromRow, toRow, columns - 1), units);
  const cited = await core.citeSelection({ documentId: document.id, parts });
  return cited;
}

describe("a range cited from real sheet Units, across a block edge (#118)", () => {
  test("one row in a later block is found", async () => {
    const cited = (await citeRows(2, 151, 151)) as { check: string; location: unknown };
    expect(cited.check).toBe("found");
    expect(cited.location).toEqual({ kind: "rows", sheet: "Data", from: 151, to: 151 });
  });

  test("two rows in a later block are found", async () => {
    const cited = (await citeRows(2, 150, 151)) as { check: string; location: unknown };
    expect(cited.check).toBe("found");
    expect(cited.location).toEqual({ kind: "rows", sheet: "Data", from: 150, to: 151 });
  });

  test("a range that takes the header row is found", async () => {
    for (const [from, to] of [
      [1, 1],
      [1, 5],
      [1, 100],
      [1, 150],
    ] as const) {
      const cited = (await citeRows(2, from, to)) as { check: string; location: unknown };
      expect(cited.check, `rows ${from}–${to}`).toBe("found");
      expect(cited.location).toEqual({ kind: "rows", sheet: "Data", from, to });
    }
  });

  test("rows 2–221 over three blocks are refused for covering more than two", async () => {
    const cited = (await citeRows(2, 2, 221)) as { check: string; checkReason: string };
    expect(cited.check).toBe("not-found");
    expect(cited.checkReason).toBe("too-many-pages");
  });

  test("150 rows over two blocks are found", async () => {
    const cited = (await citeRows(2, 2, 151)) as { check: string; location: unknown };
    expect(cited.check).toBe("found");
    expect(cited.location).toEqual({ kind: "rows", sheet: "Data", from: 2, to: 151 });
  });

  test("rows 2–20 of a wide sheet, over a block edge, are found", async () => {
    const cited = (await citeRows(9, 2, 20)) as { check: string; location: unknown };
    expect(cited.check).toBe("found");
    expect(cited.location).toEqual({ kind: "rows", sheet: "Data", from: 2, to: 20 });
  });

  test("rows 19–21 of a wide sheet, another block edge, are found", async () => {
    const cited = (await citeRows(9, 19, 21)) as { check: string; location: unknown };
    expect(cited.check).toBe("found");
    expect(cited.location).toEqual({ kind: "rows", sheet: "Data", from: 19, to: 21 });
  });
});
