/**
 * A figure of a workbook as the model it comes from (#2347): the formulas
 * between it and the inputs that drive it (the cells that hold numbers, not
 * formulas), each named by its row and column headings; and what-if, the
 * figure worked out again with one input changed, in memory.
 */
import { MAX_INPUTS_PER_FIGURE } from "../../shared/calculatedFigures";
import {
  cellIndex,
  definedName,
  nameFormula,
  type WorkbookCell,
  type WorkbookModel,
  type WorkbookSheet,
} from "./model";
import { cellName } from "./parse";
import {
  type CellProblem,
  cellsIn,
  type Dependence,
  MAX_FORMULA_CELLS,
  placeKey,
  placeOf,
  type Run,
  recalculate,
  untrustedOf,
  type WorkbookEngine,
} from "./recalculate";
import { isError, type Scalar } from "./values";

/** The most formula steps a chain lists, nearest the figure first. */
export const MAX_CHAIN_STEPS = 40;
/** The most cells a chain looks through. */
const MAX_CHAIN_CELLS = 50_000;

export interface ChainCell {
  sheet: string;
  row: number;
  column: number;
  /** "C5". */
  ref: string;
  /** Its row's heading and its column's: "Revenue 2027"; its reference when it has neither. */
  label: string;
  /** The defined names that are this cell alone: "Growth". */
  names: string[];
  /** As the workbook writes it, without "="; null for an input. */
  formula: string | null;
  /** As worked out (the saved value when it has a problem). */
  value: Scalar;
  saved: Scalar;
  shown: string;
  problem: CellProblem | null;
  /** How many formulas away from the figure: 0 is the figure. */
  depth: number;
  cell: WorkbookCell;
}

export interface Chain {
  target: ChainCell;
  /** The formulas it is worked out through, nearest first, the figure's own excluded. */
  steps: ChainCell[];
  /** The cells holding numbers that drive it, nearest first. */
  inputs: ChainCell[];
  /** How many steps and inputs past those listed. */
  moreSteps: number;
  moreInputs: number;
  /** The cells with problems the figure depends on; empty when every formula was worked out here. */
  dependsOn: Dependence[];
  formulaCells: number;
  ms: number;
}

const YEAR = /^(?:FY\s?)?(?:19|20)\d\d(?:\s?[AEFBP])?$/i;
const yearLike = (value: Scalar) =>
  (typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= 2100) ||
  (typeof value === "string" && YEAR.test(value.trim()));
const isText = (value: Scalar): value is string =>
  typeof value === "string" && value.trim() !== "" && !/^[-+]?[\d.,%$€£¥()]+$/.test(value.trim());

/** Whether a row reads as headings: two cells or more, mostly words or years. */
function headingRow(sheet: WorkbookSheet, row: number): boolean {
  const cells = sheet.rowCells.get(row) ?? [];
  if (cells.length < 2) return false;
  const headings = cells.filter((cell) => isText(cell.saved) || yearLike(cell.saved)).length;
  return headings * 5 >= cells.length * 3;
}

function shownHeading(cell: WorkbookCell): string {
  return (cell.shown || String(cell.saved ?? "")).trim();
}

/** A cell's name as a reader of the sheet would give it: its row's heading, then its column's. */
export function cellLabel(sheet: WorkbookSheet, row: number, column: number): string {
  const cells = sheet.rowCells.get(row) ?? [];
  const rowHeading = [...cells]
    .reverse()
    .find((cell) => cell.column < column && isText(cell.saved));
  let columnHeading: string | null = null;
  const rows = sheet.columnRows.get(column) ?? [];
  for (let index = rows.length - 1; index >= 0; index--) {
    const above = rows[index] as number;
    if (above >= row) continue;
    const cell = sheet.cells.get(cellIndex(above, column));
    if (!cell) continue;
    if (yearLike(cell.saved) && headingRow(sheet, above)) {
      columnHeading = shownHeading(cell);
      break;
    }
    if (isText(cell.saved)) {
      const series = cells.filter(
        (each) => each.column !== column && typeof each.saved === "number",
      );
      if (!rowHeading || series.length >= 1) columnHeading = shownHeading(cell);
      break;
    }
  }
  const parts = [rowHeading ? shownHeading(rowHeading) : null, columnHeading].filter(
    (part): part is string => part !== null && part !== "",
  );
  return parts.length > 0 ? parts.join(" ") : cellName(row, column);
}

/** The defined names that are exactly this cell. */
export function namesOfCell(
  model: WorkbookModel,
  sheet: WorkbookSheet,
  row: number,
  column: number,
): string[] {
  return model.names.flatMap((name) => {
    const node = nameFormula(name);
    if (node.kind !== "reference") return [];
    const { range } = node;
    const named = (node.sheet ?? name.sheet ?? "").toUpperCase();
    return named === sheet.name.toUpperCase() &&
      range.top === row &&
      range.bottom === row &&
      range.left === column &&
      range.right === column
      ? [name.name]
      : [];
  });
}

function chainCell(engine: WorkbookEngine, run: Run, key: number, depth: number): ChainCell | null {
  const { model } = engine;
  const { sheet, row, column } = placeOf(model, key);
  const cell = sheet.cells.get(cellIndex(row, column));
  if (!cell) return null;
  const result = run.results.get(key);
  return {
    sheet: sheet.name,
    row,
    column,
    ref: cellName(row, column),
    label: cellLabel(sheet, row, column),
    names: namesOfCell(model, sheet, row, column),
    formula: cell.formula,
    value: result ? result.value : cell.saved,
    saved: cell.saved,
    shown: cell.shown,
    problem: result?.problem ?? null,
    depth,
    cell,
  };
}

/** A cell as a chain lists it, with its saved value: an input a what-if changes, say. */
export function cellOfChain(engine: WorkbookEngine, key: number): ChainCell | null {
  return chainCell(
    engine,
    { results: new Map(), order: [], stopped: false, tooMany: false, ms: 0 },
    key,
    0,
  );
}

/** The cells a formula cell reads directly. */
function precedentsOf(engine: WorkbookEngine, key: number): number[] {
  const found: number[] = [];
  for (const read of engine.analysis(key).reads) {
    const sheet = engine.sheetNamed(read.sheet);
    if (!sheet) continue;
    for (const cell of cellsIn(sheet, read.range))
      found.push(placeKey(sheet, cell.row, cell.column));
  }
  return found;
}

/**
 * A figure's chain to its inputs, worked out again and checked against the
 * values Excel saved.
 */
export async function traceChain(
  engine: WorkbookEngine,
  target: number,
  signal?: AbortSignal,
): Promise<Chain> {
  const run = await recalculate(engine, [target], signal ? { signal } : {});
  const first = chainCell(engine, run, target, 0);
  if (!first) throw new Error("The figure's cell isn't in the workbook.");
  const steps: ChainCell[] = [];
  const inputs: ChainCell[] = [];
  let moreSteps = 0;
  let moreInputs = 0;
  const seen = new Set<number>([target]);
  let frontier = [target];
  let depth = 0;
  while (frontier.length > 0 && seen.size < MAX_CHAIN_CELLS) {
    depth++;
    const next: number[] = [];
    for (const key of frontier) {
      if (engine.cellAt(key)?.formula == null) continue;
      for (const precedent of precedentsOf(engine, key)) {
        if (seen.has(precedent)) continue;
        seen.add(precedent);
        const cell = engine.cellAt(precedent);
        if (!cell) continue;
        if (cell.formula !== null) {
          next.push(precedent);
          if (steps.length < MAX_CHAIN_STEPS) {
            const step = chainCell(engine, run, precedent, depth);
            if (step) steps.push(step);
          } else moreSteps++;
        } else if (typeof cell.saved === "number") {
          if (inputs.length < MAX_INPUTS_PER_FIGURE) {
            const input = chainCell(engine, run, precedent, depth);
            if (input) inputs.push(input);
          } else moreInputs++;
        }
      }
    }
    frontier = next;
  }
  const result = run.results.get(target);
  // A run stopped at its time or formula limit before it reached the figure worked nothing out for it.
  const unfinished: Dependence[] =
    !result && first.formula !== null
      ? [
          {
            sheet: first.sheet,
            row: first.row,
            column: first.column,
            problem: run.tooMany
              ? { kind: "too-many", limit: MAX_FORMULA_CELLS }
              : { kind: "too-large" },
          },
        ]
      : [];
  return {
    target: first,
    steps,
    inputs,
    moreSteps,
    moreInputs,
    dependsOn: result?.dependsOn ?? unfinished,
    formulaCells: run.order.length,
    ms: run.ms,
  };
}

export type WhatIfOutcome =
  | {
      ok: true;
      /** The figure as the workbook has it, worked out again here. */
      before: number;
      /** With the input changed. */
      after: number;
      formulaCells: number;
      ms: number;
    }
  | { ok: false; why: WhatIfRefusal };

export type WhatIfRefusal =
  | { kind: "input-is-formula"; inputs: ChainCell[] }
  | { kind: "input-not-number" }
  | { kind: "target-not-formula" }
  | { kind: "not-a-number" }
  | { kind: "unrelated" }
  | { kind: "depends"; on: Dependence[] }
  | { kind: "too-many" }
  | { kind: "stopped" };

/**
 * Works `target` out again with the constant cell `input` set to `value`, on
 * a copy in memory. It refuses rather than give a figure part worked out and
 * part saved: when the figure depends on a cell that can't be worked out
 * here, or whose result differs from the one Excel saved.
 */
export async function whatIf(
  engine: WorkbookEngine,
  target: number,
  input: number,
  value: number,
  signal?: AbortSignal,
): Promise<WhatIfOutcome> {
  const changed = engine.cellAt(input);
  const figure = engine.cellAt(target);
  if (!figure?.formula) return { ok: false, why: { kind: "target-not-formula" } };
  const options = signal ? { signal } : {};
  if (changed?.formula) {
    const chain = await traceChain(engine, input, signal);
    return { ok: false, why: { kind: "input-is-formula", inputs: chain.inputs } };
  }
  if (changed && typeof changed.saved !== "number")
    return { ok: false, why: { kind: "input-not-number" } };
  const base = await recalculate(engine, [target], options);
  if (base.tooMany) return { ok: false, why: { kind: "too-many" } };
  if (base.stopped) return { ok: false, why: { kind: "stopped" } };
  const before = base.results.get(target);
  if (!before || before.dependsOn.length > 0)
    return { ok: false, why: { kind: "depends", on: before?.dependsOn ?? [] } };
  if (typeof before.value !== "number") return { ok: false, why: { kind: "not-a-number" } };
  const { sheet, row, column } = placeOf(engine.model, input);
  const reads = base.order.some((key) =>
    engine
      .analysis(key)
      .reads.some(
        (read) =>
          engine.sheetNamed(read.sheet) === sheet &&
          row >= read.range.top &&
          row <= read.range.bottom &&
          column >= read.range.left &&
          column <= read.range.right,
      ),
  );
  if (!reads) return { ok: false, why: { kind: "unrelated" } };
  const after = await recalculate(engine, [target], {
    ...options,
    changes: new Map([[input, value]]),
    untrusted: untrustedOf(base),
  });
  if (after.stopped) return { ok: false, why: { kind: "stopped" } };
  const result = after.results.get(target);
  if (!result || result.dependsOn.length > 0)
    return { ok: false, why: { kind: "depends", on: result?.dependsOn ?? [] } };
  if (typeof result.value !== "number" || isError(result.value))
    return { ok: false, why: { kind: "not-a-number" } };
  return {
    ok: true,
    before: before.value,
    after: result.value,
    formulaCells: after.order.length,
    ms: base.ms + after.ms,
  };
}

/** A constant cell a defined name is, for a what-if: "Growth" → Assumptions!C5. */
export function namedCell(
  model: WorkbookModel,
  name: string,
): { sheet: WorkbookSheet; row: number; column: number } | null {
  const named =
    definedName(model, null, name) ??
    model.names.find((each) => each.name.toUpperCase() === name.toUpperCase()) ??
    null;
  if (!named) return null;
  const node = nameFormula(named);
  if (node.kind !== "reference") return null;
  const sheet = model.byName.get((node.sheet ?? named.sheet ?? "").toUpperCase());
  const { range } = node;
  if (!sheet || range.top !== range.bottom || range.left !== range.right) return null;
  return { sheet, row: range.top, column: range.left };
}
