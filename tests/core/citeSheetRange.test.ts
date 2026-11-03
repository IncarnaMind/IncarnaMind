import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
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
