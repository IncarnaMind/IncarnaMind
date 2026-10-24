/**
 * A comparison table's cell that gives an amount at another scale than its Citation's Document
 * (#1798), through the core as Compare Documents fills a table, with a scripted model.
 */
import { describe, expect, test } from "vitest";
import { comparisonCellOf } from "../../src/shared/comparisons";
import { compareCedar, fillEnded, rescalingModel } from "../helpers/comparisons";
import type { MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";

/** Each row's net debt cell, as the editor reads it. */
function netDebtCells(client: MindClient) {
  const cells: { status: string; problem: string | null; message: string | null; text: string }[] =
    [];
  readMind(client).forEach((block) => {
    if (block.type.name !== "comparisonTable") return;
    block.forEach((row) => {
      row.forEach((cell) => {
        const { status, problem, message } = comparisonCellOf(cell.attrs);
        cells.push({ status, problem, message, text: cell.textContent.trim() });
      });
    });
  });
  return cells;
}

describe("A cell's amount keeps the scale its Document gives it", () => {
  // protects=GBP thousands written as GBP millions is told to the model once, and a cell that still writes it shows what the Document gives instead of the amount; fails_when=the wrong amount is kept as an Answer; no_claim=the Excel file (comparisonExcel.test.ts).
  test("is asked about once, and a cell that keeps the changed scale says what the Document gives", async () => {
    const model = rescalingModel(() => false);
    const { client } = await compareCedar(model);
    const told = model.doStreamCalls.filter((call) =>
      JSON.stringify(call.prompt).includes("Your cell writes 310,000 GBP million"),
    );
    expect(told).toHaveLength(1);
    expect(JSON.stringify(told[0]?.prompt)).toContain("the Document gives 310000 GBP thousands");
    expect(netDebtCells(client)).toEqual([
      { status: "failed", problem: "scale-changed", message: "310000 GBP thousands", text: "" },
      { status: "done", problem: null, message: null, text: "GBP 340 million" },
    ]);
  });

  // protects=a model told of the changed scale writes the cell again, and the right amount stands as its Answer; fails_when=the corrected cell is still flagged; no_claim=none beyond protects.
  test("stands once the model writes the amount at its Document's scale", async () => {
    const { client } = await compareCedar(rescalingModel(() => true));
    expect(netDebtCells(client).map((cell) => [cell.status, cell.text])).toEqual([
      ["done", "GBP 310 million"],
      ["done", "GBP 340 million"],
    ]);
  });

  // protects=a flagged cell is filled again like any failed cell, by "Fill 1 cell"; fails_when=it is left out of the fill or keeps its problem once right; no_claim=the button itself (e2e/comparisons.spec.ts).
  test("is filled again, and a right amount then takes its place", async () => {
    let fixes = false;
    const { core, client, mind, tableId } = await compareCedar(rescalingModel(() => fixes));
    expect(netDebtCells(client)[0]?.problem).toBe("scale-changed");
    fixes = true;
    const ended = fillEnded(core, tableId);
    await core.fillComparisonTable({ mindId: mind.id, tableId });
    await ended;
    await client.settled();
    expect(netDebtCells(client)[0]).toMatchObject({ status: "done", text: "GBP 310 million" });
  });
});
