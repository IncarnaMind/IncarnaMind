/**
 * Works a workbook's formulas out again (#2347), in memory, never in the
 * User's file: the cells a figure depends on, precedents first, in slices
 * that give way between them, so a workbook of tens of thousands of formulas
 * never holds anything else up.
 *
 * Every result is checked against the value Excel saved. A formula that
 * can't be worked out here (see `CellProblem`), and one whose result differs
 * from the saved one, keeps the saved value, and every cell that reads it is
 * marked as depending on it: a what-if never mixes a recalculated value with
 * a saved one that should have changed with it (see ./whatIf).
 */
import { type Arg, type Evaluation, intersect, operand, type PlacedValue } from "./context";
import { FINDS_ITS_CELLS, VOLATILE, workbookFunction } from "./functions";
import {
  cellIndex,
  definedName,
  firstAtOrAfter,
  nameFormula,
  type WorkbookCell,
  type WorkbookModel,
  type WorkbookSheet,
} from "./model";
import {
  type CellRange,
  type FormulaNode,
  functionName,
  parseFormula,
  type UnsupportedPart,
} from "./parse";
import {
  at,
  compare,
  DIV0,
  each,
  elementwise,
  error,
  finite,
  isError,
  isMatrix,
  isReference,
  type Matrix,
  matrix,
  NAME,
  REF,
  type Reference,
  type Scalar,
  toNumber,
  toText,
  VALUE,
  type Value,
} from "./values";

/** Why a cell keeps the value Excel saved rather than one worked out here. */
export type CellProblem =
  | { kind: "volatile"; name: string }
  | { kind: "finds-cells"; name: string }
  | { kind: "function"; name: string }
  | { kind: "add-in"; name: string }
  | { kind: "data-table" }
  | { kind: "formula"; part: UnsupportedPart }
  | { kind: "circular" }
  | { kind: "iterative" }
  | { kind: "not-read"; sheet: string }
  | { kind: "array" }
  | { kind: "no-saved-value" }
  | { kind: "differs"; saved: Scalar; worked: Scalar }
  | { kind: "too-large" };

/** A cell a result depends on that keeps its saved value, and why. */
export interface Dependence {
  sheet: string;
  /** Its A1 reference; null for a whole sheet that wasn't read. */
  row: number | null;
  column: number | null;
  problem: CellProblem;
}

/** A formula cell as worked out. */
export interface CellResult {
  /** What cells that read it get: the worked-out value, or the saved one when it has a problem. */
  value: Scalar;
  /** The value worked out here; undefined when it wasn't (a problem of the formula itself). */
  worked: Scalar | undefined;
  problem: CellProblem | null;
  /** The cells with problems it depends on, itself included, the first few. */
  dependsOn: Dependence[];
}

/** Places as one number: the sheet's place in the workbook, then `cellIndex`. */
const SHEET_SPAN = 2 ** 34;
export const placeKey = (sheet: WorkbookSheet, row: number, column: number): number =>
  sheet.index * SHEET_SPAN + cellIndex(row, column);

export function placeOf(
  model: WorkbookModel,
  key: number,
): { sheet: WorkbookSheet; row: number; column: number } {
  const sheet = model.sheets[Math.floor(key / SHEET_SPAN)] as WorkbookSheet;
  const within = key % SHEET_SPAN;
  return { sheet, row: Math.floor(within / 16_384), column: within % 16_384 };
}

const MAX_DEPENDENCES = 8;
/** The most cells one block a formula reads may have, past the cells its sheet has. */
const MAX_BLOCK_CELLS = 4_000_000;
/** How long a slice of work runs before it gives way, and how long a whole run may take. */
const SLICE_MS = 8;
export const MAX_RUN_MS = 60_000;

interface Analysis {
  node: FormulaNode;
  array: boolean;
  problem: CellProblem | null;
  reads: { sheet: string; range: CellRange }[];
}

/** A block a formula reads, by its sheet as written and its cells. */
type Read = Analysis["reads"][number];

const isConstant = (node: FormulaNode): boolean =>
  node.kind === "number" ||
  node.kind === "text" ||
  node.kind === "boolean" ||
  node.kind === "missing" ||
  (node.kind === "unary" && node.operator === "-" && node.operand.kind === "number");

/** OFFSET and INDIRECT read cells known before they run only when their arguments are written in the formula. */
function fixedArguments(name: string, args: readonly FormulaNode[]): boolean {
  if (name === "OFFSET") return args[0]?.kind === "reference" && args.slice(1).every(isConstant);
  return args.every(isConstant);
}

export class WorkbookEngine {
  private readonly analyses = new Map<number, Analysis>();
  private readonly formulasIn = new Map<string, number[]>();

  constructor(readonly model: WorkbookModel) {}

  sheetNamed(name: string): WorkbookSheet | null {
    return this.model.byName.get(name.toUpperCase()) ?? null;
  }

  cellAt(key: number): WorkbookCell | null {
    const { sheet, row, column } = placeOf(this.model, key);
    return sheet.cells.get(cellIndex(row, column)) ?? null;
  }

  /** What a formula cell's formula is, needs and reads, worked out once. */
  analysis(key: number): Analysis {
    const known = this.analyses.get(key);
    if (known) return known;
    const { sheet, row, column } = placeOf(this.model, key);
    const cell = sheet.cells.get(cellIndex(row, column));
    const written = cell?.formula ?? "";
    const array = written.startsWith("{") && written.endsWith("}");
    const node = parseFormula(array ? written.slice(1, -1) : written);
    const reads: Read[] = [];
    let problem: CellProblem | null = null;
    const note = (found: CellProblem) => {
      problem ??= found;
    };
    const visit = (each: FormulaNode, sheetName: string, names: number) => {
      switch (each.kind) {
        case "unsupported":
          note({ kind: "formula", part: each.part });
          return;
        case "reference":
          reads.push({ sheet: each.sheet ?? sheetName, range: each.range });
          return;
        case "name": {
          const named = definedName(this.model, sheetName, each.name, each.sheet);
          if (named && names < 20) visit(nameFormula(named), named.sheet ?? sheetName, names + 1);
          return;
        }
        case "unary":
          visit(each.operand, sheetName, names);
          return;
        case "binary":
          visit(each.left, sheetName, names);
          visit(each.right, sheetName, names);
          return;
        case "array":
          return;
        case "call": {
          const name = functionName(each.name);
          if (/^_xll\./i.test(each.name)) note({ kind: "add-in", name: each.name.slice(5) });
          else if (name === "TABLE") note({ kind: "data-table" });
          else if (VOLATILE.has(name)) note({ kind: "volatile", name });
          else if (FINDS_ITS_CELLS.has(name) && !fixedArguments(name, each.args))
            note({ kind: "finds-cells", name });
          else {
            const found = workbookFunction(name);
            if (!found || each.args.length < found.min || each.args.length > found.max)
              note({ kind: "function", name });
          }
          if (FINDS_ITS_CELLS.has(name) && fixedArguments(name, each.args)) {
            const target = this.literalTarget(name, each.args, sheetName, row, column);
            if (target) reads.push(target);
          }
          for (const arg of each.args) visit(arg, sheetName, names);
          return;
        }
        default:
          return;
      }
    };
    visit(node, sheet.name, 0);
    const analysis: Analysis = { node, array, problem, reads };
    this.analyses.set(key, analysis);
    return analysis;
  }

  /** The block OFFSET or INDIRECT reads when every argument is written in the formula. */
  private literalTarget(
    name: string,
    args: readonly FormulaNode[],
    sheetName: string,
    row: number,
    column: number,
  ): Read | null {
    const evaluation = this.evaluation(sheetName, row, column, false, () => null);
    const value = workbookFunction(name)?.call(
      args.map((node) => argument(node, evaluation)),
      evaluation,
    );
    return value && isReference(value) ? { sheet: value.sheet, range: value.range } : null;
  }

  /** The formula cells in a block a formula reads. */
  formulaCellsIn(read: Read): number[] {
    const id = `${read.sheet.toUpperCase()}!${read.range.top},${read.range.left},${read.range.bottom},${read.range.right}`;
    const known = this.formulasIn.get(id);
    if (known) return known;
    const sheet = this.sheetNamed(read.sheet);
    const found: number[] = [];
    if (sheet) {
      for (const cell of cellsIn(sheet, read.range)) {
        if (cell.formula !== null) found.push(placeKey(sheet, cell.row, cell.column));
      }
    }
    this.formulasIn.set(id, found);
    return found;
  }

  /** An evaluation of the formula in a cell, reading other cells through `read`. */
  evaluation(
    sheetName: string,
    row: number,
    column: number,
    array: boolean,
    read: (sheet: string, row: number, column: number) => Scalar | null,
    blocks?: BlockReader,
  ): Evaluation {
    const sheet = this.sheetNamed(sheetName);
    const context: Evaluation = {
      sheet: sheet?.name ?? sheetName,
      row,
      column,
      array,
      date1904: this.model.date1904,
      cell: (name, r, c) => read(name, r, c),
      values: (reference) =>
        blocks ? blocks.values(reference) : denseValues(this, reference, read),
      filled: (reference) =>
        blocks ? blocks.filled(reference) : filledValues(this, reference, read),
      sheetNamed: (name) => this.sheetNamed(name)?.name ?? name,
      name: (written, name) => {
        const named = definedName(this.model, context.sheet, name, written);
        return named ? nameFormula(named) : null;
      },
      evaluate: (node, inArray) => evaluate(node, context, inArray),
    };
    return context;
  }
}

/** A block's cells that hold something, row by row. */
function cellsIn(sheet: WorkbookSheet, range: CellRange): WorkbookCell[] {
  const width = range.right - range.left + 1;
  const height = range.bottom - range.top + 1;
  const found: WorkbookCell[] = [];
  if (width <= height) {
    const from = firstAtOrAfter(sheet.columns, range.left);
    for (let index = from; index < sheet.columns.length; index++) {
      const column = sheet.columns[index] as number;
      if (column > range.right) break;
      const rows = sheet.columnRows.get(column) ?? [];
      for (let r = firstAtOrAfter(rows, range.top); r < rows.length; r++) {
        const row = rows[r] as number;
        if (row > range.bottom) break;
        const cell = sheet.cells.get(cellIndex(row, column));
        if (cell) found.push(cell);
      }
    }
    if (width > 1) found.sort((a, b) => a.row - b.row || a.column - b.column);
    return found;
  }
  for (let index = firstAtOrAfter(sheet.rows, range.top); index < sheet.rows.length; index++) {
    const row = sheet.rows[index] as number;
    if (row > range.bottom) break;
    for (const cell of sheet.rowCells.get(row) ?? []) {
      if (cell.column >= range.left && cell.column <= range.right) found.push(cell);
    }
  }
  return found;
}

function filledValues(
  engine: WorkbookEngine,
  reference: Reference,
  read: (sheet: string, row: number, column: number) => Scalar | null,
): PlacedValue[] {
  const sheet = engine.sheetNamed(reference.sheet);
  if (!sheet) {
    read(reference.sheet, reference.range.top, reference.range.left);
    return [];
  }
  if (sheet.cutFrom !== null && reference.range.bottom >= sheet.cutFrom)
    read(sheet.name, sheet.cutFrom, reference.range.left);
  return cellsIn(sheet, reference.range).map((cell) => ({
    row: cell.row,
    column: cell.column,
    value: read(sheet.name, cell.row, cell.column),
  }));
}

function denseValues(
  engine: WorkbookEngine,
  reference: Reference,
  read: (sheet: string, row: number, column: number) => Scalar | null,
): Matrix {
  const sheet = engine.sheetNamed(reference.sheet);
  const { range } = reference;
  const bottom = Math.min(range.bottom, sheet?.lastRow ?? 0);
  const right = Math.min(range.right, sheet?.lastColumn ?? -1);
  const rows = Math.max(0, bottom - range.top + 1);
  const columns = Math.max(0, right - range.left + 1);
  if (rows * columns > MAX_BLOCK_CELLS) {
    read(reference.sheet, -1, -1);
    return matrix(0, 0, []);
  }
  const values: Scalar[] = new Array<Scalar>(rows * columns).fill(null);
  for (const placed of filledValues(engine, reference, read)) {
    const r = placed.row - range.top;
    const c = placed.column - range.left;
    if (r < rows && c < columns) values[r * columns + c] = placed.value;
  }
  return matrix(rows, columns, values);
}

/** Reads blocks once per run: a block's formula cells are worked out before any formula that reads it. */
interface BlockReader {
  values(reference: Reference): Matrix;
  filled(reference: Reference): PlacedValue[];
}

function argument(node: FormulaNode, context: Evaluation): Arg {
  let value: Value | undefined;
  let array: Scalar | Matrix | undefined;
  return {
    node,
    missing: node.kind === "missing",
    value: () => {
      value ??= node.kind === "missing" ? null : context.evaluate(node, context.array);
      return value;
    },
    array: () => {
      array ??= operand(context.evaluate(node, true), context, true);
      return array;
    },
  };
}

function arithmetic(operator: string, a: Scalar, b: Scalar): Scalar {
  if (operator === "&") {
    const left = toText(a);
    const right = toText(b);
    if (isError(left)) return left;
    if (isError(right)) return right;
    return left + right;
  }
  if (["=", "<>", "<", ">", "<=", ">="].includes(operator)) {
    if (isError(a)) return a;
    if (isError(b)) return b;
    const order = compare(a, b);
    switch (operator) {
      case "=":
        return order === 0;
      case "<>":
        return order !== 0;
      case "<":
        return order < 0;
      case ">":
        return order > 0;
      case "<=":
        return order <= 0;
      default:
        return order >= 0;
    }
  }
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;
  switch (operator) {
    case "+":
      return finite(x + y);
    case "-":
      return finite(x - y);
    case "*":
      return finite(x * y);
    case "/":
      return y === 0 ? DIV0 : finite(x / y);
    default:
      if (x === 0 && y === 0) return error("#NUM!");
      if (x === 0 && y < 0) return DIV0;
      return finite(x ** y);
  }
}

export function evaluate(node: FormulaNode, context: Evaluation, array: boolean): Value {
  switch (node.kind) {
    case "number":
      return node.value;
    case "text":
      return node.value;
    case "boolean":
      return node.value;
    case "error":
      return error(node.code);
    case "missing":
      return null;
    case "unsupported":
      return VALUE;
    case "reference":
      return {
        kind: "reference",
        sheet: node.sheet === null ? context.sheet : (context.sheetNamed(node.sheet) ?? node.sheet),
        range: node.range,
      };
    case "name": {
      const formula = context.name(node.sheet, node.name);
      return formula ? evaluate(formula, context, array) : NAME;
    }
    case "unary": {
      const value = operand(evaluate(node.operand, context, array), context, array);
      return each(value, (x) => {
        if (node.operator === "+") return x;
        const number = toNumber(x);
        if (isError(number)) return number;
        return node.operator === "-" ? -number : number / 100;
      });
    }
    case "binary": {
      const left = operand(evaluate(node.left, context, array), context, array);
      const right = operand(evaluate(node.right, context, array), context, array);
      return elementwise(left, right, (a, b) => arithmetic(node.operator, a, b));
    }
    case "array":
      return matrix(
        node.rows.length,
        node.rows[0]?.length ?? 0,
        node.rows.flatMap((row) =>
          row.map((cell) => {
            const value = evaluate(cell, context, false);
            return isMatrix(value) || isReference(value) ? VALUE : value;
          }),
        ),
      );
    case "call": {
      const found = workbookFunction(functionName(node.name));
      if (!found) return NAME;
      return found.call(
        node.args.map((each) => argument(each, context)),
        context,
      );
    }
  }
}

/** A formula's result as its cell holds it; "array" when it gives a block a single cell can't hold. */
function cellValue(value: Value, context: Evaluation): Scalar | "array" {
  if (isReference(value)) {
    const { range } = value;
    if (range.top === range.bottom && range.left === range.right)
      return context.cell(value.sheet, range.top, range.left) ?? 0;
    if (context.array) return "array";
    return intersect(value, context) ?? 0;
  }
  if (isMatrix(value)) {
    if (value.rows === 1 && value.columns === 1) return at(value, 0, 0) ?? 0;
    if (value.rows === 0 || value.columns === 0) return REF;
    return context.array ? "array" : (at(value, 0, 0) ?? 0);
  }
  return value ?? 0;
}

/** Whether a value worked out here is the one Excel saved: numbers to nine significant digits. */
export function sameValue(worked: Scalar, saved: Scalar): boolean {
  if (typeof worked === "number" && typeof saved === "number")
    return Math.abs(worked - saved) <= 1e-9 * Math.max(Math.abs(worked), Math.abs(saved), 1);
  if (saved === null) return worked === "" || worked === 0;
  if (isError(worked) || isError(saved))
    return isError(worked) && isError(saved) && worked.code === saved.code;
  if (typeof worked === "string" && typeof saved === "string")
    return worked.replace(/[\t\n\r]+/g, " ").trim() === saved;
  return worked === saved;
}

/** One run over the cells a target depends on: their order, and each one's result. */
export interface Run {
  results: Map<number, CellResult>;
  /** Formula cells worked out, precedents first. */
  order: number[];
  /** The run stopped at `MAX_RUN_MS` before it was done. */
  stopped: boolean;
  ms: number;
}

const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function abortError(): Error {
  const stop = new Error("The recalculation was stopped.");
  stop.name = "AbortError";
  return stop;
}

/**
 * The formula cells `targets` depend on, precedents first, and those in a
 * circular reference. Iterative (Tarjan's), so a column of 20,000 formulas
 * each reading the one above doesn't run out of stack.
 */
async function closure(
  engine: WorkbookEngine,
  targets: readonly number[],
  pace: Pace,
): Promise<{ order: number[]; circular: Set<number> }> {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const order: number[] = [];
  const circular = new Set<number>();
  let counter = 0;
  const precedents = (key: number): number[] => {
    const analysis = engine.analysis(key);
    const found: number[] = [];
    for (const read of analysis.reads) found.push(...engine.formulaCellsIn(read));
    return found;
  };
  for (const target of targets) {
    if (index.has(target) || engine.cellAt(target)?.formula == null) continue;
    const frames: { key: number; next: number[]; at: number }[] = [];
    const open = (key: number) => {
      index.set(key, counter);
      low.set(key, counter);
      counter++;
      stack.push(key);
      onStack.add(key);
      frames.push({ key, next: precedents(key), at: 0 });
    };
    open(target);
    while (frames.length > 0) {
      await pace.step();
      const frame = frames[frames.length - 1] as (typeof frames)[number];
      if (frame.at < frame.next.length) {
        const next = frame.next[frame.at++] as number;
        if (next === frame.key) circular.add(next);
        if (!index.has(next)) open(next);
        else if (onStack.has(next))
          low.set(frame.key, Math.min(low.get(frame.key) ?? 0, index.get(next) ?? 0));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.key, Math.min(low.get(parent.key) ?? 0, low.get(frame.key) ?? 0));
      if (low.get(frame.key) === index.get(frame.key)) {
        const component: number[] = [];
        let member: number | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.key);
        if (component.length > 1) for (const each of component) circular.add(each);
        order.push(...component.reverse());
      }
    }
  }
  return { order, circular };
}

/** Gives way to everything else every few milliseconds, and stops when asked or out of time. */
class Pace {
  private sliceStart = performance.now();
  private readonly started = performance.now();
  private count = 0;
  stopped = false;

  constructor(private readonly signal: AbortSignal | undefined) {}

  async step(): Promise<void> {
    if ((++this.count & 63) !== 0) return;
    const now = performance.now();
    if (now - this.sliceStart < SLICE_MS) return;
    await yieldNow();
    if (this.signal?.aborted) throw abortError();
    if (performance.now() - this.started > MAX_RUN_MS) this.stopped = true;
    this.sliceStart = performance.now();
  }

  get ms(): number {
    return performance.now() - this.started;
  }
}

function addDependence(into: Dependence[], seen: Set<string>, dependence: Dependence): void {
  const id = `${dependence.sheet.toUpperCase()}!${dependence.row},${dependence.column}`;
  if (seen.has(id)) return;
  seen.add(id);
  if (into.length < MAX_DEPENDENCES) into.push(dependence);
}

export interface RunOptions {
  /** Constant cells given new values, by `placeKey`: a what-if's changed input. */
  changes?: ReadonlyMap<number, Scalar>;
  /** Cells a first run found differing from their saved values: their saved values stand. */
  untrusted?: ReadonlyMap<number, CellProblem>;
  signal?: AbortSignal;
}

/**
 * Works out every formula cell `targets` depend on. Without `changes`, each
 * result is compared with the value Excel saved; a cell whose result
 * differs keeps the saved value and is marked, as is every cell that reads it.
 */
export async function recalculate(
  engine: WorkbookEngine,
  targets: readonly number[],
  options: RunOptions = {},
): Promise<Run> {
  const { model } = engine;
  const pace = new Pace(options.signal);
  const { order, circular } = await closure(engine, targets, pace);
  const results = new Map<number, CellResult>();
  let current: { dependsOn: Dependence[]; seen: Set<string>; unread?: CellProblem } = {
    dependsOn: [],
    seen: new Set(),
  };
  const readNothing = (dependence: Dependence) => {
    current.unread ??= dependence.problem;
    addDependence(current.dependsOn, current.seen, dependence);
  };
  const blockCache = new Map<
    string,
    { matrix?: Matrix; filled?: PlacedValue[]; dependsOn: Dependence[]; unread?: CellProblem }
  >();

  const read = (sheetName: string, row: number, column: number): Scalar | null => {
    const sheet = engine.sheetNamed(sheetName);
    if (!sheet) {
      readNothing({
        sheet: sheetName,
        row: null,
        column: null,
        problem: { kind: "not-read", sheet: sheetName },
      });
      return null;
    }
    if (row < 0) {
      readNothing({ sheet: sheet.name, row: null, column: null, problem: { kind: "too-large" } });
      return null;
    }
    if (sheet.cutFrom !== null && row >= sheet.cutFrom) {
      readNothing({
        sheet: sheet.name,
        row: sheet.cutFrom,
        column: null,
        problem: { kind: "not-read", sheet: sheet.name },
      });
      return null;
    }
    const key = placeKey(sheet, row, column);
    const changed = options.changes?.get(key);
    if (changed !== undefined) return changed;
    const cell = sheet.cells.get(cellIndex(row, column));
    if (!cell) return null;
    if (cell.formula === null) return cell.saved;
    const result = results.get(key);
    if (!result) {
      addDependence(current.dependsOn, current.seen, {
        sheet: sheet.name,
        row,
        column,
        problem: { kind: "circular" },
      });
      return cell.saved;
    }
    for (const dependence of result.dependsOn)
      addDependence(current.dependsOn, current.seen, dependence);
    return result.value;
  };

  const cached = (reference: Reference, dense: boolean) => {
    const { range } = reference;
    const id = `${reference.sheet.toUpperCase()}!${range.top},${range.left},${range.bottom},${range.right}`;
    let entry = blockCache.get(id);
    if (!entry) {
      entry = { dependsOn: [] };
      blockCache.set(id, entry);
    }
    if ((dense && !entry.matrix) || (!dense && !entry.filled)) {
      const outer = current;
      current = { dependsOn: [], seen: new Set() };
      if (dense) entry.matrix = denseValues(engine, reference, read);
      else entry.filled = filledValues(engine, reference, read);
      for (const dependence of current.dependsOn) {
        if (!entry.dependsOn.some((each) => each === dependence)) entry.dependsOn.push(dependence);
      }
      current = outer;
    }
    for (const dependence of entry.dependsOn)
      addDependence(current.dependsOn, current.seen, dependence);
    return entry;
  };
  const blocks: BlockReader = {
    values: (reference) => cached(reference, true).matrix ?? matrix(0, 0, []),
    filled: (reference) => cached(reference, false).filled ?? [],
  };

  const done: number[] = [];
  for (const key of order) {
    await pace.step();
    if (pace.stopped) break;
    const { sheet, row, column } = placeOf(model, key);
    const cell = sheet.cells.get(cellIndex(row, column)) as WorkbookCell;
    const analysis = engine.analysis(key);
    current = { dependsOn: [], seen: new Set() };
    const own = (problem: CellProblem): CellResult => {
      addDependence(current.dependsOn, current.seen, { sheet: sheet.name, row, column, problem });
      return { value: cell.saved, worked: undefined, problem, dependsOn: current.dependsOn };
    };
    const staticProblem: CellProblem | null =
      analysis.problem ??
      (circular.has(key) ? (model.iterate ? { kind: "iterative" } : { kind: "circular" }) : null);
    if (staticProblem) {
      results.set(key, own(staticProblem));
      done.push(key);
      continue;
    }
    const context = engine.evaluation(sheet.name, row, column, analysis.array, read, blocks);
    let worked: Scalar | "array";
    try {
      worked = cellValue(evaluate(analysis.node, context, analysis.array), context);
    } catch (thrown) {
      if (thrown instanceof RangeError) worked = "array";
      else throw thrown;
    }
    if (worked === "array") {
      results.set(key, own({ kind: "array" }));
      done.push(key);
      continue;
    }
    // A formula that read cells that weren't read from the file worked out nothing to compare.
    if (current.unread) {
      results.set(key, own(current.unread));
      done.push(key);
      continue;
    }
    const untrusted = options.untrusted?.get(key);
    if (untrusted) {
      addDependence(current.dependsOn, current.seen, {
        sheet: sheet.name,
        row,
        column,
        problem: untrusted,
      });
      results.set(key, {
        value: cell.saved,
        worked,
        problem: untrusted,
        dependsOn: current.dependsOn,
      });
    } else if (!options.changes && cell.unsaved) {
      addDependence(current.dependsOn, current.seen, {
        sheet: sheet.name,
        row,
        column,
        problem: { kind: "no-saved-value" },
      });
      results.set(key, {
        value: worked,
        worked,
        problem: { kind: "no-saved-value" },
        dependsOn: current.dependsOn,
      });
    } else if (!options.changes && !sameValue(worked, cell.saved)) {
      const problem: CellProblem = { kind: "differs", saved: cell.saved, worked };
      addDependence(current.dependsOn, current.seen, { sheet: sheet.name, row, column, problem });
      results.set(key, { value: cell.saved, worked, problem, dependsOn: current.dependsOn });
    } else {
      results.set(key, { value: worked, worked, problem: null, dependsOn: current.dependsOn });
    }
    done.push(key);
  }
  return { results, order: done, stopped: pace.stopped, ms: pace.ms };
}

/** A problem's cells that a later run must keep at their saved values: those whose result differed. */
export function untrustedOf(run: Run): Map<number, CellProblem> {
  const found = new Map<number, CellProblem>();
  for (const [key, result] of run.results) {
    if (
      result.problem &&
      (result.problem.kind === "differs" || result.problem.kind === "no-saved-value")
    )
      found.set(key, result.problem);
  }
  return found;
}
