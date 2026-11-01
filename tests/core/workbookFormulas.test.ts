import { describe, expect, test } from "vitest";
import { extractXlsx } from "../../src/core/documents/formats/xlsx";
import { type WorkbookModel, workbookModel } from "../../src/core/workbooks/model";
import { moveFormula, parseFormula } from "../../src/core/workbooks/parse";
import { placeKey, recalculate, WorkbookEngine } from "../../src/core/workbooks/recalculate";
import { traceChain, whatIf } from "../../src/core/workbooks/trace";
import {
  dcfWorkbook,
  iterativeWorkbook,
  largeWorkbook,
  lboWorkbook,
  threeStatementWorkbook,
  unsupportedWorkbook,
  type WorkbookBuilder,
} from "../helpers/financeWorkbooks";

async function modelOf(
  book: WorkbookBuilder,
  options: Parameters<WorkbookBuilder["xlsx"]>[0] = {},
  readHidden = false,
) {
  const { units } = await extractXlsx(new Uint8Array(book.xlsx(options)), readHidden);
  const model = workbookModel("document", "version", units);
  if (!model) throw new Error("The workbook kept no formulas.");
  return { model, engine: new WorkbookEngine(model) };
}

const at = (model: WorkbookModel, sheet: string, row: number, column: number) => {
  const found = model.byName.get(sheet.toUpperCase());
  if (!found) throw new Error(`No sheet ${sheet}`);
  return placeKey(found, row, column);
};

function formulaKeys(model: WorkbookModel): number[] {
  return model.sheets.flatMap((sheet) =>
    [...sheet.cells.values()]
      .filter((cell) => cell.formula !== null)
      .map((cell) => placeKey(sheet, cell.row, cell.column)),
  );
}

describe("a workbook's formulas, worked out again", () => {
  test.each([
    ["a DCF", dcfWorkbook, 70],
    ["an LBO", lboWorkbook, 64],
    ["three linked statements", threeStatementWorkbook, 93],
  ])("%s: every formula gives the value Excel saved", async (_name, build, formulas) => {
    const { model, engine } = await modelOf(build());
    expect(model.formulaCount).toBe(formulas);
    const run = await recalculate(engine, formulaKeys(model));
    const problems = [...run.results.values()].filter((result) => result.problem !== null);
    expect(problems).toEqual([]);
    expect(run.results.size).toBe(formulas);
  });

  test("a shared formula reads as each of its cells, its $ references fixed", () => {
    expect(moveFormula("B4*(1+Growth)", 0, 1)).toBe("C4*(1+Growth)");
    expect(moveFormula("C4*Assumptions!$B$7", 0, 3)).toBe("F4*Assumptions!$B$7");
    expect(moveFormula("SUM(B2:B101)", 0, 2)).toBe("SUM(D2:D101)");
    expect(moveFormula("'Q3 Plan'!A1+$A2", 2, 0)).toBe("'Q3 Plan'!A3+$A4");
    expect(moveFormula("A1", -1, 0)).toBe("#REF!");
  });

  test("what can't be worked out parses as such, named; a plain formula parses", () => {
    expect(parseFormula("[1]Prices!A1*B6")).toMatchObject({
      kind: "unsupported",
      part: "external",
    });
    expect(parseFormula("SUM(Table1[Revenue])")).toMatchObject({
      kind: "unsupported",
      part: "table",
    });
    expect(parseFormula("SUM(Jan:Dec!B2)")).toMatchObject({ kind: "unsupported", part: "three-d" });
    expect(parseFormula("A1:B2 B1:C2")).toMatchObject({
      kind: "unsupported",
      part: "intersection",
    });
    expect(parseFormula("SUM(A:A)+'Q3 Plan'!$B$2^-2")).toMatchObject({
      kind: "binary",
      operator: "+",
    });
  });

  test("2027 EBITDA's chain runs through its formulas to the assumptions that drive it", async () => {
    const { model, engine } = await modelOf(dcfWorkbook());
    const chain = await traceChain(engine, at(model, "DCF", 5, 4));
    expect(chain.target).toMatchObject({
      label: "EBITDA 2027",
      formula: "E4*Margin",
      value: 254.6775,
    });
    expect(chain.dependsOn).toEqual([]);
    expect(
      chain.steps.map((step) => `${step.sheet}!${step.ref} ${step.label} = ${step.formula}`),
    ).toEqual([
      "DCF!E4 Revenue 2027 = D4*(1+Growth)",
      "DCF!D4 Revenue 2026 = C4*(1+Growth)",
      "DCF!C4 Revenue 2025 = B4*(1+Growth)",
      "DCF!B4 Revenue 2024 = Assumptions!B3",
    ]);
    expect(
      chain.inputs.map((input) => [
        `${input.sheet}!${input.ref}`,
        input.label,
        input.names,
        input.shown,
      ]),
    ).toEqual([
      ["Assumptions!B5", "EBITDA margin", ["Margin"], "22.0%"],
      ["Assumptions!B4", "Revenue growth", ["Growth"], "5.0%"],
      ["Assumptions!B3", "Revenue 2024", [], "1,000.0"],
    ]);
  });

  test("a what-if on growth works the figure out again, in memory, and leaves the model as it was", async () => {
    const { model, engine } = await modelOf(dcfWorkbook());
    const growth = at(model, "Assumptions", 4, 1);
    const outcome = await whatIf(engine, at(model, "DCF", 5, 4), growth, 0.03);
    expect(outcome).toMatchObject({ ok: true, before: 254.6775 });
    if (!outcome.ok) throw new Error("refused");
    expect(outcome.after).toBeCloseTo(240.39994, 9);
    const perShare = await whatIf(engine, at(model, "DCF", 21, 1), growth, 0.03);
    expect(perShare).toMatchObject({ ok: true, before: 18.93, after: 17.38 });
    // The model still holds the saved inputs: a second run starts from them.
    const again = await whatIf(engine, at(model, "DCF", 5, 4), growth, 0.05);
    expect(again).toMatchObject({ ok: true, before: 254.6775, after: 254.6775 });
  });

  test("an input the figure doesn't depend on, and one worked out by a formula, are refused, named", async () => {
    const { model, engine } = await modelOf(dcfWorkbook());
    const ebitda = at(model, "DCF", 5, 4);
    expect(await whatIf(engine, ebitda, at(model, "Assumptions", 12, 1), 400)).toMatchObject({
      ok: false,
      why: { kind: "unrelated" },
    });
    const viaFormula = await whatIf(engine, ebitda, at(model, "DCF", 4, 3), 1200);
    expect(viaFormula).toMatchObject({ ok: false, why: { kind: "input-is-formula" } });
    expect(await whatIf(engine, ebitda, at(model, "Assumptions", 5, 1), 0.2)).toMatchObject({
      ok: true,
    });
  });

  test.each([
    [2, { kind: "volatile", name: "RAND" }],
    [3, { kind: "volatile", name: "TODAY" }],
    [4, { kind: "finds-cells", name: "OFFSET" }],
    [5, { kind: "finds-cells", name: "INDIRECT" }],
    [6, { kind: "formula", part: "external" }],
    [7, { kind: "function", name: "FORECASTGROWTH" }],
    [8, { kind: "circular" }],
    [9, { kind: "no-saved-value" }],
    [10, { kind: "differs", saved: 21, worked: 24 }],
    [11, { kind: "not-read", sheet: "Calc" }],
  ])(
    "row %s of the unsupported cases keeps its saved value, named, and its what-if is refused",
    async (row, problem) => {
      const { model, engine } = await modelOf(unsupportedWorkbook());
      const figure = at(model, "Cases", row, 3);
      const chain = await traceChain(engine, figure);
      expect(chain.dependsOn.map((each) => each.problem)).toContainEqual(problem);
      expect(await whatIf(engine, figure, at(model, "Cases", row, 1), 99)).toMatchObject({
        ok: false,
        why: { kind: "depends" },
      });
      // In the same workbook, a figure with nothing to keep is worked out.
      expect(
        await whatIf(engine, at(model, "Cases", 13, 3), at(model, "Cases", 13, 1), 7),
      ).toMatchObject({
        ok: true,
        before: 18,
        after: 21,
      });
    },
  );

  test("OFFSET with every argument written in the formula is worked out", async () => {
    const { model, engine } = await modelOf(unsupportedWorkbook());
    expect(
      await whatIf(engine, at(model, "Cases", 12, 3), at(model, "Cases", 12, 1), 5),
    ).toMatchObject({
      ok: true,
      before: 9,
      after: 11,
    });
  });

  test("a hidden sheet read with the workbook is worked out; left out, it is named", async () => {
    const hidden = await modelOf(unsupportedWorkbook(), {}, true);
    expect(
      await whatIf(
        hidden.engine,
        at(hidden.model, "Cases", 11, 3),
        at(hidden.model, "Cases", 11, 1),
        3,
      ),
    ).toMatchObject({
      ok: true,
      before: 21,
      after: 31,
    });
    const left = await modelOf(unsupportedWorkbook());
    expect(left.model.unread.has("CALC")).toBe(true);
  });

  test("circular references Excel iterates are named as such", async () => {
    const { model, engine } = await modelOf(iterativeWorkbook());
    const chain = await traceChain(engine, at(model, "Interest", 3, 1));
    expect(chain.dependsOn.map((each) => each.problem.kind)).toContain("iterative");
  });

  test("a workbook saved with no results is refused; the same one with them works", async () => {
    const bare = await modelOf(dcfWorkbook(), { withoutResults: true });
    const growth = at(bare.model, "Assumptions", 4, 1);
    expect(await whatIf(bare.engine, at(bare.model, "DCF", 5, 4), growth, 0.03)).toMatchObject({
      ok: false,
      why: {
        kind: "depends",
        on: expect.arrayContaining([
          expect.objectContaining({ problem: { kind: "no-saved-value" } }),
        ]),
      },
    });
    const saved = await modelOf(dcfWorkbook());
    expect(
      await whatIf(
        saved.engine,
        at(saved.model, "DCF", 5, 4),
        at(saved.model, "Assumptions", 4, 1),
        0.03,
      ),
    ).toMatchObject({ ok: true });
  });

  test("a model of 12,120 formulas is worked out in slices that give way to other work", async () => {
    const { model, engine } = await modelOf(largeWorkbook());
    expect(model.formulaCount).toBe(12_120);
    let tickedDuring = false;
    let running = true;
    setTimeout(() => {
      tickedDuring = running;
    }, 0);
    const total = at(model, "Model", 102, 120);
    const outcome = await whatIf(engine, total, at(model, "Drivers", 2, 1), 0.002);
    running = false;
    expect(tickedDuring).toBe(true);
    expect(outcome).toMatchObject({ ok: true, formulaCells: 12_001 });
    const run = await recalculate(engine, formulaKeys(model));
    expect([...run.results.values()].filter((result) => result.problem !== null)).toEqual([]);
  });
});
