/**
 * The functions a workbook's formulas can use here (#2347), as Excel works
 * them out: the ones finance models are built from (sums and counts with
 * conditions, lookups, logic, dates, NPV, IRR, XNPV, XIRR, PMT and the rest
 * of the time value of money), and text. A function that isn't here, a
 * volatile one (NOW, RAND) and one that finds its cells as it runs (OFFSET,
 * INDIRECT, unless every argument is written in the formula) are never
 * worked out: the cell keeps the value Excel saved, marked as such.
 */
import { displayNumber, displayText } from "../documents/formats/numberDisplay";
import { isDateFormat } from "../documents/formats/numbers";
import {
  type Arg,
  arrayOf,
  type Evaluation,
  first,
  firstError,
  flatten,
  intersect,
  operand,
  scalarOf,
} from "./context";
import { ERROR_CODES, LAST_COLUMN, LAST_ROW, parseFormula } from "./parse";
import {
  at,
  type CellError,
  compare,
  DIV0,
  equal,
  finite,
  isError,
  isMatrix,
  isReference,
  type Matrix,
  matrix,
  NA,
  NUM,
  REF,
  type Reference,
  Refusal,
  type Scalar,
  sameNumber,
  textNumber,
  toBoolean,
  toNumber,
  toText,
  VALUE,
  type Value,
} from "./values";

export interface WorkbookFunction {
  min: number;
  max: number;
  call(args: Arg[], context: Evaluation): Value;
}

/** Worked out afresh each time, so the value Excel saved is the only one there is. */
export const VOLATILE: ReadonlySet<string> = new Set([
  "NOW",
  "TODAY",
  "RAND",
  "RANDBETWEEN",
  "RANDARRAY",
  "CELL",
  "INFO",
]);

/** Find their cells as they run; worked out here only when every argument is written in the formula. */
export const FINDS_ITS_CELLS: ReadonlySet<string> = new Set(["OFFSET", "INDIRECT"]);

const MANY = 255;

/** Each argument read as one value, or as arrays in an array formula, where the function is repeated over them. */
function lifted(
  min: number,
  max: number,
  apply: (values: Scalar[], given: boolean[]) => Scalar,
): WorkbookFunction {
  return {
    min,
    max,
    call(args, context) {
      const given = args.map((arg) => !arg.missing);
      const values = args.map((arg) =>
        arg.missing ? null : operand(arg.value(), context, context.array),
      );
      const arrays = values.filter(isMatrix);
      if (arrays.length === 0) return apply(values as Scalar[], given);
      const rows = Math.max(...arrays.map((each) => each.rows));
      const columns = Math.max(...arrays.map((each) => each.columns));
      const out: Scalar[] = [];
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          out.push(
            apply(
              values.map((value) => {
                if (!isMatrix(value)) return value;
                const r = value.rows === 1 ? 0 : row;
                const c = value.columns === 1 ? 0 : column;
                return r < value.rows && c < value.columns ? at(value, r, c) : NA;
              }),
              given,
            ),
          );
        }
      }
      return matrix(rows, columns, out);
    },
  };
}

/** Like `lifted`, each argument a number. */
function numeric(
  min: number,
  max: number,
  apply: (numbers: number[], given: boolean[]) => number | CellError,
): WorkbookFunction {
  return lifted(min, max, (values, given) => {
    const numbers: number[] = [];
    for (const value of values) {
      const number = toNumber(value);
      if (isError(number)) return number;
      numbers.push(number);
    }
    const result = apply(numbers, given);
    return isError(result) ? result : finite(result);
  });
}

/**
 * The numbers SUM adds up: in a reference or array, its numbers alone (text,
 * TRUE and FALSE and empty cells are left out); given directly, any value
 * that reads as one. The first error stops it.
 */
function numbersIn(args: readonly Arg[], context: Evaluation): number[] | CellError {
  const numbers: number[] = [];
  for (const arg of args) {
    if (arg.missing) {
      numbers.push(0);
      continue;
    }
    const value = arg.value();
    if (isReference(value) || isMatrix(value)) {
      for (const each of flatten(value, context)) {
        if (typeof each === "number") numbers.push(each);
        else if (isError(each)) return each;
      }
      continue;
    }
    const number = toNumber(value);
    if (isError(number)) return number;
    numbers.push(number);
  }
  return numbers;
}

function aggregate(
  min: number,
  apply: (numbers: number[]) => number | CellError,
): WorkbookFunction {
  return {
    min,
    max: MANY,
    call(args, context) {
      const numbers = numbersIn(args, context);
      if (isError(numbers)) return numbers;
      const result = apply(numbers);
      return isError(result) ? result : finite(result);
    },
  };
}

// A loop, not Math.max(...numbers): spreading more than about 120,000 numbers overflows the stack.
const largest = (numbers: readonly number[]) =>
  numbers.reduce((most, each) => (each > most ? each : most), Number.NEGATIVE_INFINITY);
const smallest = (numbers: readonly number[]) =>
  numbers.reduce((least, each) => (each < least ? each : least), Number.POSITIVE_INFINITY);

const sum = (numbers: readonly number[]) => {
  let total = 0;
  for (const number of numbers) total += number;
  return total;
};

function variance(numbers: readonly number[], sample: boolean): number | CellError {
  const n = numbers.length;
  if (n - (sample ? 1 : 0) <= 0) return DIV0;
  const mean = sum(numbers) / n;
  let squares = 0;
  for (const number of numbers) squares += (number - mean) ** 2;
  return squares / (n - (sample ? 1 : 0));
}

const sqrtOf = (value: number | CellError) => (isError(value) ? value : Math.sqrt(value));

/** Rounds as Excel does: half away from zero, on the decimal digits a person sees. */
export function roundTo(value: number, digits: number, mode: "half" | "up" | "down"): number {
  const places = Math.trunc(digits);
  const factor = 10 ** Math.abs(places);
  const scaled = places >= 0 ? Math.abs(value) * factor : Math.abs(value) / factor;
  // A number this large has no digits after the point to round.
  if (!Number.isFinite(scaled)) return value;
  const cleaned = Number(scaled.toPrecision(15));
  const whole =
    mode === "half"
      ? Math.floor(cleaned + 0.5)
      : mode === "up"
        ? Math.ceil(cleaned)
        : Math.floor(cleaned);
  const result = places >= 0 ? whole / factor : whole * factor;
  return value < 0 ? -result : result;
}

function wildcard(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index] ?? "";
    if (character === "~" && index + 1 < pattern.length) {
      source += (pattern[++index] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (character === "*") source += "[\\s\\S]*";
    else if (character === "?") source += "[\\s\\S]";
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

type Matcher = (value: Scalar) => boolean;

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASHED_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/** What Excel would read as a date or time in a condition, in a form not read here. */
const DATE_LIKE =
  /:|\d[/.-]\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|[年月日]/i;

/**
 * A date a condition writes ("2025-01-31", "1/31/2025"), as its serial;
 * null when it writes none. One that could be either day first or month
 * first ("1/2/2025"), or a form Excel reads by the computer's settings, is
 * refused rather than guessed.
 */
function criterionDate(text: string, date1904: boolean): number | null {
  const iso = ISO_DATE.exec(text);
  const slashed = SLASHED_DATE.exec(text);
  let parts: [number, number, number] | null = null;
  if (iso) parts = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (slashed) {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    const year = Number(slashed[3]);
    if (first === second || second > 12) parts = [year, first, second];
    else if (first > 12) parts = [year, second, first];
    else throw new Refusal("criterion");
  } else if (DATE_LIKE.test(text)) throw new Refusal("criterion");
  if (!parts) return null;
  const [year, month, day] = parts;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1))
    throw new Refusal("criterion");
  return serialOf(year, month - 1, day, date1904);
}

const sameAs = (number: number) => (value: Scalar) =>
  (typeof value === "number" && sameNumber(value, number)) ||
  (typeof value === "string" && textNumber(value) === number);

export function criterion(given: Scalar, date1904: boolean): Matcher {
  if (isError(given)) return (value) => value === given;
  if (typeof given === "number") return sameAs(given);
  if (typeof given === "boolean") return (value) => value === given;
  if (given === null) return () => false;
  const match = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(given);
  const operator = match?.[1] ?? "";
  const operandText = match?.[2] ?? "";
  if (operandText === "") {
    if (operator === "<>") return (value) => value !== null && value !== "";
    if (operator === "" || operator === "=") return (value) => value === null || value === "";
    return () => false;
  }
  const upper = operandText.trim().toUpperCase();
  const code = ERROR_CODES.find((each) => each === upper);
  if (code) {
    const isIt = (value: Scalar) => isError(value) && value.code === code;
    if (operator === "" || operator === "=") return isIt;
    if (operator === "<>") return (value) => !isIt(value);
    throw new Refusal("criterion");
  }
  const number = textNumber(operandText) ?? criterionDate(operandText.trim(), date1904);
  const flag = upper === "TRUE" ? true : upper === "FALSE" ? false : null;
  const test = (order: number) =>
    operator === "<"
      ? order < 0
      : operator === ">"
        ? order > 0
        : operator === "<="
          ? order <= 0
          : order >= 0;
  if (number !== null) {
    const same = sameAs(number);
    if (operator === "" || operator === "=") return same;
    if (operator === "<>") return (value) => !same(value);
    return (value) => typeof value === "number" && test(compare(value, number));
  }
  if (flag !== null) {
    if (operator === "" || operator === "=") return (value) => value === flag;
    if (operator === "<>") return (value) => value !== flag;
    return (value) => typeof value === "boolean" && test(Number(value) - Number(flag));
  }
  if (operator === "" || operator === "=" || operator === "<>") {
    const pattern = wildcard(operandText);
    const matches = (value: Scalar) => typeof value === "string" && pattern.test(value);
    return operator === "<>" ? (value) => !matches(value) : matches;
  }
  return (value) => typeof value === "string" && test(compare(value, operandText));
}

interface Block {
  reference: Reference | null;
  array: Matrix;
}

function blockOf(arg: Arg, context: Evaluation): Block {
  const value = arg.value();
  return isReference(value)
    ? { reference: value, array: context.values(value) }
    : { reference: null, array: arrayOf(value, context) };
}

const blockRows = (block: Block) =>
  block.reference ? block.reference.range.bottom - block.reference.range.top + 1 : block.array.rows;
const blockColumns = (block: Block) =>
  block.reference
    ? block.reference.range.right - block.reference.range.left + 1
    : block.array.columns;

function valueIn(block: Block, row: number, column: number, context: Evaluation): Scalar {
  if (block.reference) {
    const { sheet, range } = block.reference;
    return context.cell(sheet, range.top + row, range.left + column);
  }
  return row < block.array.rows && column < block.array.columns
    ? at(block.array, row, column)
    : null;
}

/** The places in a block of `rows` × `columns` that every condition holds at. */
function matching(
  conditions: { block: Block; test: Matcher }[],
  rows: number,
  columns: number,
  context: Evaluation,
  candidates: Block | null,
): { row: number; column: number }[] {
  const places: { row: number; column: number }[] = [];
  const holds = (row: number, column: number) =>
    conditions.every(({ block, test }) => test(valueIn(block, row, column, context)));
  const sparse = candidates?.reference && conditions.every(({ test }) => !test(null));
  if (sparse && candidates?.reference) {
    const { range } = candidates.reference;
    for (const placed of context.filled(candidates.reference)) {
      const row = placed.row - range.top;
      const column = placed.column - range.left;
      if (row < rows && column < columns && holds(row, column)) places.push({ row, column });
    }
    return places;
  }
  const clippedRows = Math.min(
    rows,
    Math.max(...conditions.map(({ block }) => block.array.rows), 0),
  );
  const clippedColumns = Math.min(
    columns,
    Math.max(...conditions.map(({ block }) => block.array.columns), 0),
  );
  for (let row = 0; row < clippedRows; row++)
    for (let column = 0; column < clippedColumns; column++)
      if (holds(row, column)) places.push({ row, column });
  return places;
}

/** The criteria pairs of SUMIFS and the like: each range and its condition, all the same size. */
function conditionsOf(
  args: readonly Arg[],
  from: number,
  context: Evaluation,
): { conditions: { block: Block; test: Matcher }[]; rows: number; columns: number } | CellError {
  const conditions: { block: Block; test: Matcher }[] = [];
  let rows = -1;
  let columns = -1;
  for (let index = from; index < args.length; index += 2) {
    const range = args[index];
    const given = args[index + 1];
    if (!range || !given) return VALUE;
    const block = blockOf(range, context);
    const size = [blockRows(block), blockColumns(block)];
    if (rows === -1) [rows, columns] = size as [number, number];
    else if (size[0] !== rows || size[1] !== columns) return VALUE;
    conditions.push({ block, test: criterion(scalarOf(given, context), context.date1904) });
  }
  return { conditions, rows, columns };
}

function valuesAt(
  block: Block,
  places: readonly { row: number; column: number }[],
  context: Evaluation,
): Scalar[] {
  return places.map(({ row, column }) => valueIn(block, row, column, context));
}

function conditional(
  pick: "sum" | "average" | "max" | "min",
  layout: "single" | "multiple",
): WorkbookFunction {
  return {
    min: layout === "single" ? 2 : 3,
    max: layout === "single" ? 3 : MANY,
    call(args, context) {
      let target: Block;
      let found: ReturnType<typeof conditionsOf>;
      if (layout === "single") {
        const [range, given, sumRange] = args as [Arg, Arg, Arg | undefined];
        const block = blockOf(range, context);
        found = {
          conditions: [{ block, test: criterion(scalarOf(given, context), context.date1904) }],
          rows: blockRows(block),
          columns: blockColumns(block),
        };
        if (sumRange && !sumRange.missing) {
          const value = sumRange.value();
          if (!isReference(value)) return VALUE;
          const { range: top } = value;
          target = {
            reference: {
              kind: "reference",
              sheet: value.sheet,
              range: {
                top: top.top,
                left: top.left,
                bottom: top.top + found.rows - 1,
                right: top.left + found.columns - 1,
              },
            },
            array: matrix(0, 0, []),
          };
          target.array = context.values(target.reference as Reference);
        } else target = block;
      } else {
        if (args.length % 2 === 0) return VALUE;
        target = blockOf(args[0] as Arg, context);
        found = conditionsOf(args, 1, context);
        if (isError(found)) return found;
        if (blockRows(target) !== found.rows || blockColumns(target) !== found.columns)
          return VALUE;
      }
      const places = matching(found.conditions, found.rows, found.columns, context, target);
      const numbers: number[] = [];
      for (const value of valuesAt(target, places, context)) {
        if (isError(value)) return value;
        if (typeof value === "number") numbers.push(value);
      }
      if (pick === "sum") return finite(sum(numbers));
      if (pick === "average")
        return numbers.length === 0 ? DIV0 : finite(sum(numbers) / numbers.length);
      if (numbers.length === 0) return 0;
      return pick === "max" ? largest(numbers) : smallest(numbers);
    },
  };
}

function counted(layout: "single" | "multiple"): WorkbookFunction {
  return {
    min: 2,
    max: layout === "single" ? 2 : MANY,
    call(args, context) {
      if (args.length % 2 !== 0) return VALUE;
      const found = conditionsOf(args, 0, context);
      if (isError(found)) return found;
      const first = found.conditions[0]?.block ?? null;
      const places = matching(found.conditions, found.rows, found.columns, context, first);
      let count = places.length;
      // Past the cells the sheet has, every cell is empty.
      if (found.conditions.every(({ test }) => test(null))) {
        const clipped =
          Math.min(found.rows, Math.max(...found.conditions.map(({ block }) => block.array.rows))) *
          Math.min(
            found.columns,
            Math.max(...found.conditions.map(({ block }) => block.array.columns)),
          );
        count += found.rows * found.columns - clipped;
      }
      return count;
    },
  };
}

/**
 * Excel finds an approximate match by halving a range it takes as sorted, so
 * over one that isn't sorted (or has blanks or other kinds of value among its
 * values) its answer can't be told: that is refused, not imitated.
 */
function assertSorted(values: readonly Scalar[], direction: 1 | -1): void {
  let previous: Exclude<Scalar, CellError | null> | undefined;
  let gap = false;
  for (const value of values) {
    if (value === null) {
      gap = true;
      continue;
    }
    if (isError(value) || gap) throw new Refusal("unsorted");
    if (previous !== undefined) {
      if (typeof previous !== typeof value) throw new Refusal("unsorted");
      const order = compare(previous, value);
      if (direction > 0 ? order >= 0 : order <= 0) throw new Refusal("unsorted");
    }
    previous = value;
  }
}

/** The position (from 0) MATCH finds `wanted` at in `values`, or -1. */
function position(values: readonly Scalar[], wanted: Scalar, type: number): number {
  if (isError(wanted)) return -1;
  const sameKind = (value: Scalar) =>
    value !== null &&
    !isError(value) &&
    typeof value === typeof (wanted ?? 0) &&
    !(typeof wanted === "string" && typeof value !== "string");
  if (type === 0) {
    const pattern = typeof wanted === "string" && /[*?~]/.test(wanted) ? wildcard(wanted) : null;
    return values.findIndex((value) =>
      pattern
        ? typeof value === "string" && pattern.test(value)
        : sameKind(value) &&
          equal(value as Exclude<Scalar, CellError>, wanted as Exclude<Scalar, CellError>),
    );
  }
  assertSorted(trailingBlanksOff(values), type > 0 ? 1 : -1);
  let found = -1;
  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? null;
    if (!sameKind(value)) continue;
    const order = compare(
      value as Exclude<Scalar, CellError>,
      (wanted ?? 0) as Exclude<Scalar, CellError>,
    );
    if (type > 0 ? order <= 0 : order >= 0) found = index;
    else break;
  }
  return found;
}

/** A range's values without the blanks after its last value: a block held whole keeps them. */
function trailingBlanksOff(values: readonly Scalar[]): readonly Scalar[] {
  let end = values.length;
  while (end > 0 && values[end - 1] === null) end--;
  return end === values.length ? values : values.slice(0, end);
}

function vector(block: Block): { values: Scalar[]; vertical: boolean } | CellError {
  const { array } = block;
  const rows = blockRows(block);
  const columns = blockColumns(block);
  if (rows !== 1 && columns !== 1) return NA;
  const vertical = columns === 1;
  return { values: array.values, vertical };
}

/** The cell `row`, `column` (from 0) of a block, as a reference when it is one. */
function cellOfBlock(block: Block, row: number, column: number): Value {
  if (block.reference) {
    const { sheet, range } = block.reference;
    const top = range.top + row;
    const left = range.left + column;
    if (top > range.bottom || left > range.right) return REF;
    return { kind: "reference", sheet, range: { top, left, bottom: top, right: left } };
  }
  if (row >= block.array.rows || column >= block.array.columns) return REF;
  return at(block.array, row, column);
}

function lookupTable(horizontal: boolean): WorkbookFunction {
  return {
    min: 3,
    max: 4,
    call(args, context) {
      const wanted = scalarOf(args[0], context);
      if (isError(wanted)) return wanted;
      const table = blockOf(args[1] as Arg, context);
      const index = toNumber(scalarOf(args[2], context));
      if (isError(index)) return index;
      const exact = args[3] && !args[3].missing ? toBoolean(scalarOf(args[3], context)) : true;
      if (isError(exact)) return exact;
      const along = Math.trunc(index) - 1;
      if (along < 0) return VALUE;
      if (along >= (horizontal ? blockRows(table) : blockColumns(table))) return REF;
      const searched: Scalar[] = [];
      const length = horizontal ? table.array.columns : table.array.rows;
      for (let each = 0; each < length; each++)
        searched.push(horizontal ? at(table.array, 0, each) : at(table.array, each, 0));
      const found = position(searched, wanted, exact === true ? 1 : 0);
      if (found < 0) return NA;
      return horizontal ? cellOfBlock(table, along, found) : cellOfBlock(table, found, along);
    },
  };
}

function lookupXl(args: Arg[], context: Evaluation): Value {
  const wanted = scalarOf(args[0], context);
  if (isError(wanted)) return wanted;
  const searched = blockOf(args[1] as Arg, context);
  const returned = blockOf(args[2] as Arg, context);
  const line = vector(searched);
  if (isError(line)) return VALUE;
  const mode = args[4] && !args[4].missing ? toNumber(scalarOf(args[4], context)) : 0;
  const direction = args[5] && !args[5].missing ? toNumber(scalarOf(args[5], context)) : 1;
  if (isError(mode)) return mode;
  if (isError(direction)) return direction;
  // A binary search (2 or -2) takes the range as sorted; a linear one finds the same on one that is.
  if (Math.abs(direction) === 2)
    assertSorted(trailingBlanksOff(line.values), direction > 0 ? 1 : -1);
  const order = line.values.map((_, index) => index);
  if (direction < 0) order.reverse();
  let found = -1;
  let nearest: Scalar = null;
  for (const index of order) {
    const value = line.values[index] ?? null;
    if (mode === 2) {
      if (typeof value === "string" && typeof wanted === "string" && wildcard(wanted).test(value)) {
        found = index;
        break;
      }
      continue;
    }
    if (value === null || isError(value) || typeof value !== typeof (wanted ?? 0)) continue;
    if (equal(value, wanted as Exclude<Scalar, CellError>)) {
      found = index;
      break;
    }
    if (mode !== -1 && mode !== 1) continue;
    const order = compare(value, wanted as Exclude<Scalar, CellError>);
    if (order === 0) {
      found = index;
      break;
    }
    const better =
      nearest === null ||
      (mode === -1 && order < 0 && compare(value, nearest as Exclude<Scalar, CellError>) > 0) ||
      (mode === 1 && order > 0 && compare(value, nearest as Exclude<Scalar, CellError>) < 0);
    if ((mode === -1 && order < 0) || (mode === 1 && order > 0)) {
      if (better) {
        nearest = value;
        found = index;
      }
    }
  }
  if (found < 0) {
    if (args[3] && !args[3].missing) return args[3].value();
    return NA;
  }
  const rows = blockRows(returned);
  const columns = blockColumns(returned);
  if (line.vertical) {
    if (columns !== 1) return VALUE;
    return cellOfBlock(returned, found, 0);
  }
  if (rows !== 1) return VALUE;
  return cellOfBlock(returned, 0, found);
}

function index(args: Arg[], context: Evaluation): Value {
  const block = blockOf(args[0] as Arg, context);
  const rowGiven = args[1] && !args[1].missing ? toNumber(scalarOf(args[1], context)) : 0;
  const columnGiven = args[2] && !args[2].missing ? toNumber(scalarOf(args[2], context)) : 0;
  if (isError(rowGiven)) return rowGiven;
  if (isError(columnGiven)) return columnGiven;
  let row = Math.trunc(rowGiven);
  let column = Math.trunc(columnGiven);
  const rows = blockRows(block);
  const columns = blockColumns(block);
  if (row < 0 || column < 0) return VALUE;
  if (args.length === 2 && rows === 1 && columns > 1) {
    column = row;
    row = 1;
  }
  if (row > rows || column > columns) return REF;
  if (block.reference) {
    const { sheet, range } = block.reference;
    return {
      kind: "reference",
      sheet,
      range: {
        top: row === 0 ? range.top : range.top + row - 1,
        bottom: row === 0 ? range.bottom : range.top + row - 1,
        left: column === 0 ? range.left : range.left + column - 1,
        right: column === 0 ? range.right : range.left + column - 1,
      },
    };
  }
  const { array } = block;
  if (row === 0 || column === 0) {
    const values: Scalar[] = [];
    for (let r = 0; r < array.rows; r++)
      for (let c = 0; c < array.columns; c++)
        if ((row === 0 || r === row - 1) && (column === 0 || c === column - 1))
          values.push(at(array, r, c));
    return matrix(row === 0 ? array.rows : 1, column === 0 ? array.columns : 1, values);
  }
  return at(array, row - 1, Math.max(column, 1) - 1);
}

function match(args: Arg[], context: Evaluation): Value {
  const wanted = scalarOf(args[0], context);
  if (isError(wanted)) return wanted;
  const line = vector(blockOf(args[1] as Arg, context));
  if (isError(line)) return line;
  const type = args[2] && !args[2].missing ? toNumber(scalarOf(args[2], context)) : 1;
  if (isError(type)) return type;
  const found = position(line.values, wanted, Math.sign(type));
  return found < 0 ? NA : found + 1;
}

function lookup(args: Arg[], context: Evaluation): Value {
  const wanted = scalarOf(args[0], context);
  if (isError(wanted)) return wanted;
  const searched = blockOf(args[1] as Arg, context);
  if (args.length === 2) {
    const rows = blockRows(searched);
    const columns = blockColumns(searched);
    const along = columns > rows;
    const values: Scalar[] = [];
    const length = along ? searched.array.columns : searched.array.rows;
    for (let each = 0; each < length; each++)
      values.push(along ? at(searched.array, 0, each) : at(searched.array, each, 0));
    const found = position(values, wanted, 1);
    if (found < 0) return NA;
    return along
      ? cellOfBlock(searched, rows - 1, found)
      : cellOfBlock(searched, found, columns - 1);
  }
  const line = vector(searched);
  if (isError(line)) return line;
  const found = position(line.values, wanted, 1);
  if (found < 0) return NA;
  const result = blockOf(args[2] as Arg, context);
  return blockRows(result) === 1 ? cellOfBlock(result, 0, found) : cellOfBlock(result, found, 0);
}

function offset(args: Arg[], context: Evaluation): Value {
  const base = args[0]?.value() ?? null;
  if (!isReference(base)) return VALUE;
  const numberAt = (index: number, fallback: number) => {
    const arg = args[index];
    if (!arg || arg.missing) return fallback;
    const value = toNumber(scalarOf(arg, context));
    return isError(value) ? value : Math.trunc(value);
  };
  const rows = numberAt(1, 0);
  const columns = numberAt(2, 0);
  const height = numberAt(3, base.range.bottom - base.range.top + 1);
  const width = numberAt(4, base.range.right - base.range.left + 1);
  for (const each of [rows, columns, height, width]) if (isError(each)) return each;
  const [r, c, h, w] = [rows, columns, height, width] as number[];
  const top = base.range.top + (r ?? 0);
  const left = base.range.left + (c ?? 0);
  const bottom = top + (h ?? 1) - 1;
  const right = left + (w ?? 1) - 1;
  if (
    (h ?? 1) < 1 ||
    (w ?? 1) < 1 ||
    top < 1 ||
    left < 0 ||
    bottom > LAST_ROW ||
    right > LAST_COLUMN
  )
    return REF;
  return { kind: "reference", sheet: base.sheet, range: { top, left, bottom, right } };
}

function indirect(args: Arg[], context: Evaluation): Value {
  const text = toText(scalarOf(args[0], context));
  if (isError(text)) return text;
  const node = parseFormula(text);
  if (node.kind !== "reference") return REF;
  const sheet = node.sheet === null ? context.sheet : context.sheetNamed(node.sheet);
  if (sheet === null) return REF;
  return { kind: "reference", sheet, range: node.range };
}

const DAY = 86_400_000;
const epoch = (date1904: boolean) => (date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30));

function utc(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Excel's 1900 date system counts a 29 February 1900 that never was, so its
 * serials before 1 March 1900 (61) are a day off from the calendar's; no
 * other spreadsheet copies that, so nothing here can be checked against it.
 */
function assertCalendar(serial: number, date1904: boolean): void {
  if (!date1904 && serial >= 0 && serial < 61) throw new Refusal("early-date");
}

export function serialOf(year: number, month: number, day: number, date1904: boolean): number {
  const serial = Math.round((utc(year, month, day) - epoch(date1904)) / DAY);
  assertCalendar(serial, date1904);
  return serial;
}

function partsOf(
  serial: number,
  date1904: boolean,
): { year: number; month: number; day: number } | null {
  if (!(serial >= 0) || serial > 2_958_465) return null;
  assertCalendar(serial, date1904);
  const date = new Date(epoch(date1904) + Math.floor(serial) * DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

const daysInMonth = (year: number, month: number) => new Date(utc(year, month + 1, 0)).getUTCDate();
const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function dateFunction(
  min: number,
  max: number,
  apply: (numbers: number[], given: boolean[], date1904: boolean) => number | CellError,
): WorkbookFunction {
  return {
    min,
    max,
    call(args, context) {
      return numeric(min, max, (numbers, given) => apply(numbers, given, context.date1904)).call(
        args,
        context,
      );
    },
  };
}

function monthsLater(
  serial: number,
  months: number,
  date1904: boolean,
  end: boolean,
): number | CellError {
  const parts = partsOf(serial, date1904);
  if (!parts) return NUM;
  const month = parts.month + Math.trunc(months);
  const year = parts.year + Math.floor(month / 12);
  const within = ((month % 12) + 12) % 12;
  const day = end ? daysInMonth(year, within) : Math.min(parts.day, daysInMonth(year, within));
  const result = serialOf(year, within, day, date1904);
  return result < 0 ? NUM : result;
}

function yearFraction(
  start: number,
  end: number,
  basis: number,
  date1904: boolean,
): number | CellError {
  if (start > end) [start, end] = [end, start];
  const a = partsOf(start, date1904);
  const b = partsOf(end, date1904);
  if (!a || !b) return NUM;
  const days = Math.floor(end) - Math.floor(start);
  const lastOfFebruary = (parts: { year: number; month: number; day: number }) =>
    parts.month === 1 && parts.day === daysInMonth(parts.year, 1);
  switch (basis) {
    case 0: {
      let d1 = a.day;
      let d2 = b.day;
      if (lastOfFebruary(a)) {
        d1 = 30;
        if (lastOfFebruary(b)) d2 = 30;
      }
      if (d1 === 31) d1 = 30;
      if (d2 === 31 && d1 >= 30) d2 = 30;
      return ((b.year - a.year) * 360 + (b.month - a.month) * 30 + (d2 - d1)) / 360;
    }
    case 1: {
      if (a.year === b.year) return days / (isLeap(a.year) ? 366 : 365);
      const withinYear =
        b.year === a.year + 1 && (a.month > b.month || (a.month === b.month && a.day >= b.day));
      if (withinYear) {
        const feb29 =
          (isLeap(a.year) && (a.month < 1 || (a.month === 1 && a.day <= 29))) ||
          (isLeap(b.year) && (b.month > 1 || (b.month === 1 && b.day === 29)));
        return days / (feb29 ? 366 : 365);
      }
      let total = 0;
      for (let year = a.year; year <= b.year; year++) total += isLeap(year) ? 366 : 365;
      return days / (total / (b.year - a.year + 1));
    }
    case 2:
      return days / 360;
    case 3:
      return days / 365;
    case 4: {
      const d1 = Math.min(a.day, 30);
      const d2 = Math.min(b.day, 30);
      return ((b.year - a.year) * 360 + (b.month - a.month) * 30 + (d2 - d1)) / 360;
    }
    default:
      return NUM;
  }
}

function futureValue(
  rate: number,
  periods: number,
  payment: number,
  present: number,
  type: number,
) {
  if (rate === 0) return -(present + payment * periods);
  const growth = (1 + rate) ** periods;
  return -(present * growth + (payment * (1 + rate * type) * (growth - 1)) / rate);
}

function payment(rate: number, periods: number, present: number, future: number, type: number) {
  if (rate === 0) return -(present + future) / periods;
  const growth = (1 + rate) ** periods;
  return -(rate * (future + present * growth)) / ((1 + rate * type) * (growth - 1));
}

function interestPayment(
  rate: number,
  period: number,
  periods: number,
  present: number,
  future: number,
  type: number,
): number | CellError {
  if (period < 1 || period > periods) return NUM;
  const each = payment(rate, periods, present, future, type);
  if (period === 1 && type === 1) return 0;
  const interest = futureValue(rate, period - 1, each, present, type) * rate;
  return type === 1 ? interest / (1 + rate) : interest;
}

/**
 * Newton's method from `guess`, its slope taken from `f` itself, stopping
 * after as many tries as Excel's function does: #NUM! when it doesn't settle.
 */
function solve(f: (x: number) => number, guess: number, tries: number): number | CellError {
  let x = guess;
  for (let step = 0; step < tries; step++) {
    const value = f(x);
    const h = Math.max(1e-7, Math.abs(x) * 1e-7);
    const slope = (f(x + h) - f(x - h)) / (2 * h);
    if (!Number.isFinite(value) || !Number.isFinite(slope) || slope === 0) return NUM;
    const next = x - value / slope;
    if (!Number.isFinite(next)) return NUM;
    if (Math.abs(next - x) <= 1e-12 * Math.max(1, Math.abs(next))) return next;
    x = next;
  }
  return NUM;
}

/** Excel's IRR and RATE give up after 20 tries, and XIRR after 100. */
const IRR_TRIES = 20;
const XIRR_TRIES = 100;

function flowsOf(arg: Arg | undefined, context: Evaluation): number[] | CellError {
  if (!arg) return VALUE;
  const values: number[] = [];
  for (const value of flatten(arg.value(), context)) {
    if (isError(value)) return value;
    if (typeof value === "number") values.push(value);
  }
  return values;
}

function irr(args: Arg[], context: Evaluation): Value {
  const flows = flowsOf(args[0], context);
  if (isError(flows)) return flows;
  const guess = args[1] && !args[1].missing ? toNumber(scalarOf(args[1], context)) : 0.1;
  if (isError(guess)) return guess;
  if (!flows.some((each) => each > 0) || !flows.some((each) => each < 0)) return NUM;
  const npv = (rate: number) =>
    flows.reduce((total, flow, at) => total + flow / (1 + rate) ** at, 0);
  return solve(npv, guess, IRR_TRIES);
}

function datedFlows(
  args: Arg[],
  context: Evaluation,
  from: number,
): { flows: number[]; days: number[] } | CellError {
  const flows = flowsOf(args[from], context);
  const dates = flowsOf(args[from + 1], context);
  if (isError(flows)) return flows;
  if (isError(dates)) return dates;
  if (flows.length !== dates.length || flows.length === 0) return NUM;
  const start = Math.floor(dates[0] ?? 0);
  const days: number[] = [];
  for (const date of dates) {
    assertCalendar(Math.floor(date), context.date1904);
    if (Math.floor(date) < start) return NUM;
    days.push(Math.floor(date) - start);
  }
  return { flows, days };
}

function xnpv(args: Arg[], context: Evaluation): Value {
  const rate = toNumber(scalarOf(args[0], context));
  if (isError(rate)) return rate;
  const dated = datedFlows(args, context, 1);
  if (isError(dated)) return dated;
  if (rate <= -1) return NUM;
  return finite(
    dated.flows.reduce(
      (total, flow, at) => total + flow / (1 + rate) ** ((dated.days[at] ?? 0) / 365),
      0,
    ),
  );
}

function xirr(args: Arg[], context: Evaluation): Value {
  const dated = datedFlows(args, context, 0);
  if (isError(dated)) return dated;
  const guess = args[2] && !args[2].missing ? toNumber(scalarOf(args[2], context)) : 0.1;
  if (isError(guess)) return guess;
  const { flows, days } = dated;
  if (!flows.some((each) => each > 0) || !flows.some((each) => each < 0)) return NUM;
  const value = (rate: number) =>
    flows.reduce((total, flow, at) => total + flow / (1 + rate) ** ((days[at] ?? 0) / 365), 0);
  return solve(value, guess, XIRR_TRIES);
}

function npv(args: Arg[], context: Evaluation): Value {
  const rate = toNumber(scalarOf(args[0], context));
  if (isError(rate)) return rate;
  const flows = numbersIn(args.slice(1), context);
  if (isError(flows)) return flows;
  if (rate === -1) return DIV0;
  return finite(flows.reduce((total, flow, at) => total + flow / (1 + rate) ** (at + 1), 0));
}

function mirr(args: Arg[], context: Evaluation): Value {
  const flows = flowsOf(args[0], context);
  if (isError(flows)) return flows;
  const finance = toNumber(scalarOf(args[1], context));
  const reinvest = toNumber(scalarOf(args[2], context));
  if (isError(finance)) return finance;
  if (isError(reinvest)) return reinvest;
  const n = flows.length;
  let negative = 0;
  let positive = 0;
  flows.forEach((flow, at) => {
    if (flow < 0) negative += flow / (1 + finance) ** at;
    else positive += flow * (1 + reinvest) ** (n - 1 - at);
  });
  if (negative === 0 || positive === 0 || n < 2) return DIV0;
  return finite((positive / -negative) ** (1 / (n - 1)) - 1);
}

function rate(args: Arg[], context: Evaluation): Value {
  const numbers = args.map((arg) => (arg.missing ? null : toNumber(scalarOf(arg, context))));
  for (const each of numbers) if (isError(each)) return each;
  const [periods, pay, present, future, type, guess] = numbers as (number | null)[];
  if (periods == null || pay == null || present == null) return VALUE;
  const fv = future ?? 0;
  const t = (type ?? 0) !== 0 ? 1 : 0;
  const f = (r: number) => {
    if (r === 0) return present + pay * periods + fv;
    const growth = (1 + r) ** periods;
    return present * growth + (pay * (1 + r * t) * (growth - 1)) / r + fv;
  };
  return solve(f, guess ?? 0.1, IRR_TRIES);
}

function logical(apply: (values: boolean[]) => boolean): WorkbookFunction {
  return {
    min: 1,
    max: MANY,
    call(args, context) {
      const flags: boolean[] = [];
      for (const arg of args) {
        const value = arg.value();
        if (isReference(value) || isMatrix(value)) {
          for (const each of flatten(value, context)) {
            if (isError(each)) return each;
            if (typeof each === "boolean") flags.push(each);
            else if (typeof each === "number") flags.push(each !== 0);
          }
          continue;
        }
        const flag = toBoolean(value);
        if (isError(flag)) return flag;
        flags.push(flag);
      }
      return flags.length === 0 ? VALUE : apply(flags);
    },
  };
}

function conditionOf(arg: Arg | undefined, context: Evaluation): boolean | CellError | Matrix {
  if (!arg) return VALUE;
  const value = operand(arg.value(), context, context.array);
  if (isMatrix(value)) return value;
  return toBoolean(value);
}

function ifFunction(args: Arg[], context: Evaluation): Value {
  const condition = conditionOf(args[0], context);
  if (isError(condition)) return condition;
  const branch = (index: number, fallback: Scalar): Value => {
    const arg = args[index];
    if (!arg) return fallback;
    return arg.missing ? 0 : arg.value();
  };
  if (!isMatrix(condition)) return condition ? branch(1, true) : branch(2, false);
  const yes = operand(branch(1, true), context, true);
  const no = operand(branch(2, false), context, true);
  const pick = (value: Scalar | Matrix, row: number, column: number): Scalar => {
    if (!isMatrix(value)) return value;
    const r = value.rows === 1 ? 0 : row;
    const c = value.columns === 1 ? 0 : column;
    return r < value.rows && c < value.columns ? at(value, r, c) : NA;
  };
  const values: Scalar[] = [];
  for (let row = 0; row < condition.rows; row++) {
    for (let column = 0; column < condition.columns; column++) {
      const flag = toBoolean(at(condition, row, column));
      values.push(isError(flag) ? flag : pick(flag ? yes : no, row, column));
    }
  }
  return matrix(condition.rows, condition.columns, values);
}

function ifError(onlyNa: boolean): WorkbookFunction {
  return {
    min: 2,
    max: 2,
    call(args, context) {
      const value = operand(args[0]?.value() ?? null, context, context.array);
      const caught = (each: Scalar) => isError(each) && (!onlyNa || each === NA);
      if (isMatrix(value)) {
        if (!value.values.some(caught)) return value;
        const fallback = first(operand(args[1]?.value() ?? null, context, context.array));
        return matrix(
          value.rows,
          value.columns,
          value.values.map((each) => (caught(each) ? fallback : each)),
        );
      }
      if (!caught(value)) return value;
      return args[1]?.missing ? 0 : (args[1]?.value() ?? 0);
    },
  };
}

function ifs(args: Arg[], context: Evaluation): Value {
  if (args.length % 2 !== 0) return VALUE;
  for (let index = 0; index < args.length; index += 2) {
    const flag = toBoolean(scalarOf(args[index], context));
    if (isError(flag)) return flag;
    if (flag) return args[index + 1]?.value() ?? NA;
  }
  return NA;
}

function switchFunction(args: Arg[], context: Evaluation): Value {
  const subject = scalarOf(args[0], context);
  if (isError(subject)) return subject;
  let index = 1;
  for (; index + 1 < args.length; index += 2) {
    const candidate = scalarOf(args[index], context);
    if (isError(candidate)) return candidate;
    if (
      typeof candidate === typeof subject &&
      equal(candidate as Exclude<Scalar, CellError>, subject as Exclude<Scalar, CellError>)
    )
      return args[index + 1]?.value() ?? NA;
  }
  return index < args.length ? (args[index]?.value() ?? NA) : NA;
}

function choose(args: Arg[], context: Evaluation): Value {
  const picked = toNumber(scalarOf(args[0], context));
  if (isError(picked)) return picked;
  const chosen = args[Math.trunc(picked)];
  if (Math.trunc(picked) < 1 || !chosen) return VALUE;
  return chosen.missing ? 0 : chosen.value();
}

function information(test: (value: Scalar) => boolean): WorkbookFunction {
  return lifted(1, 1, ([value]) => test(value ?? null));
}

function isBlank(args: Arg[], context: Evaluation): Value {
  const value = args[0]?.value() ?? null;
  if (isReference(value)) return intersect(value, context) === null;
  return false;
}

function text(args: Arg[], context: Evaluation): Value {
  return lifted(2, 2, ([value, format]) => {
    const code = toText(format ?? null);
    if (isError(code)) return code;
    if (isError(value)) return value;
    if (typeof value === "string") {
      const number = textNumber(value);
      return number === null
        ? displayText(value, code).text
        : displayNumber(number, code, { date1904: context.date1904 }).text;
    }
    const number = toNumber(value ?? null);
    if (isError(number)) return number;
    if (isDateFormat(code)) assertCalendar(Math.floor(number), context.date1904);
    return displayNumber(number, code, { date1904: context.date1904 }).text;
  }).call(args, context);
}

function textValue(value: Scalar, date1904: boolean): number | CellError {
  if (typeof value === "string") {
    const iso = /^\s*(\d{4})-(\d\d)-(\d\d)\s*$/.exec(value);
    if (iso) return serialOf(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), date1904);
  }
  return toNumber(value);
}

function stringFunction(
  min: number,
  max: number,
  apply: (values: Scalar[], given: boolean[]) => Scalar,
): WorkbookFunction {
  return lifted(min, max, (values, given) => {
    const error = firstError(values);
    return error ?? apply(values, given);
  });
}

function textOf(value: Scalar): string {
  const read = toText(value);
  return isError(read) ? "" : read;
}

function joinAll(args: Arg[], context: Evaluation, separator: string, skipEmpty: boolean): Value {
  const parts: string[] = [];
  for (const arg of args) {
    if (arg.missing) continue;
    for (const value of flatten(arg.value(), context)) {
      if (isError(value)) return value;
      const part = textOf(value);
      if (skipEmpty && part === "") continue;
      parts.push(part);
    }
  }
  return parts.join(separator);
}

function counter(test: (value: Scalar, direct: boolean) => boolean): WorkbookFunction {
  return {
    min: 1,
    max: MANY,
    call(args, context) {
      let count = 0;
      for (const arg of args) {
        if (arg.missing) continue;
        const value = arg.value();
        if (isReference(value) || isMatrix(value)) {
          for (const each of flatten(value, context)) if (test(each, false)) count++;
        } else if (test(value, true)) count++;
      }
      return count;
    },
  };
}

function countBlank(args: Arg[], context: Evaluation): Value {
  const value = args[0]?.value() ?? null;
  if (!isReference(value)) return VALUE;
  const { range } = value;
  const size = (range.bottom - range.top + 1) * (range.right - range.left + 1);
  const filled = context.filled(value).filter((each) => each.value !== "").length;
  return size - filled;
}

function nth(largest: boolean): WorkbookFunction {
  return {
    min: 2,
    max: 2,
    call(args, context) {
      const numbers = numbersIn(args.slice(0, 1), context);
      if (isError(numbers)) return numbers;
      const k = toNumber(scalarOf(args[1], context));
      if (isError(k)) return k;
      const rank = Math.ceil(k);
      if (rank < 1 || rank > numbers.length) return NUM;
      const sorted = [...numbers].sort((a, b) => (largest ? b - a : a - b));
      return sorted[rank - 1] ?? NUM;
    },
  };
}

function sumProduct(args: Arg[], context: Evaluation): Value {
  const arrays = args.map((arg) => arrayOf(arg.array(), context));
  const [head] = arrays;
  if (!head) return VALUE;
  if (arrays.some((each) => each.rows !== head.rows || each.columns !== head.columns)) return VALUE;
  let total = 0;
  for (let index = 0; index < head.values.length; index++) {
    let product = 1;
    for (const array of arrays) {
      const value = array.values[index] ?? null;
      if (isError(value)) return value;
      product *= typeof value === "number" ? value : 0;
    }
    total += product;
  }
  return finite(total);
}

function rowOrColumn(row: boolean): WorkbookFunction {
  return {
    min: 0,
    max: 1,
    call(args, context) {
      if (!args[0] || args[0].missing) return row ? context.row : context.column + 1;
      const value = args[0].value();
      if (!isReference(value)) return VALUE;
      return row ? value.range.top : value.range.left + 1;
    },
  };
}

function sizeOf(rows: boolean): WorkbookFunction {
  return {
    min: 1,
    max: 1,
    call(args, context) {
      const block = blockOf(args[0] as Arg, context);
      return rows ? blockRows(block) : blockColumns(block);
    },
  };
}

const roundFunction = (mode: "half" | "up" | "down") =>
  numeric(1, 2, ([value = 0, digits = 0]) => roundTo(value, digits, mode));

const FUNCTIONS: ReadonlyMap<string, WorkbookFunction> = new Map<string, WorkbookFunction>([
  ["SUM", aggregate(1, sum)],
  ["PRODUCT", aggregate(1, (numbers) => numbers.reduce((total, each) => total * each, 1))],
  ["SUMSQ", aggregate(1, (numbers) => sum(numbers.map((each) => each * each)))],
  [
    "AVERAGE",
    aggregate(1, (numbers) => (numbers.length === 0 ? DIV0 : sum(numbers) / numbers.length)),
  ],
  ["MAX", aggregate(1, (numbers) => (numbers.length === 0 ? 0 : largest(numbers)))],
  ["MIN", aggregate(1, (numbers) => (numbers.length === 0 ? 0 : smallest(numbers)))],
  [
    "MEDIAN",
    aggregate(1, (numbers) => {
      if (numbers.length === 0) return NUM;
      const sorted = [...numbers].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? (sorted[middle] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    }),
  ],
  ["STDEV", aggregate(1, (numbers) => sqrtOf(variance(numbers, true)))],
  ["STDEV.S", aggregate(1, (numbers) => sqrtOf(variance(numbers, true)))],
  ["STDEV.P", aggregate(1, (numbers) => sqrtOf(variance(numbers, false)))],
  ["STDEVP", aggregate(1, (numbers) => sqrtOf(variance(numbers, false)))],
  ["VAR", aggregate(1, (numbers) => variance(numbers, true))],
  ["VAR.S", aggregate(1, (numbers) => variance(numbers, true))],
  ["VAR.P", aggregate(1, (numbers) => variance(numbers, false))],
  ["VARP", aggregate(1, (numbers) => variance(numbers, false))],
  ["LARGE", nth(true)],
  ["SMALL", nth(false)],
  [
    "COUNT",
    counter(
      (value, direct) =>
        typeof value === "number" ||
        (direct &&
          (typeof value === "boolean" ||
            (typeof value === "string" && textNumber(value) !== null))),
    ),
  ],
  ["COUNTA", counter((value) => value !== null)],
  ["COUNTBLANK", { min: 1, max: 1, call: countBlank }],
  ["SUMIF", conditional("sum", "single")],
  ["SUMIFS", conditional("sum", "multiple")],
  ["AVERAGEIF", conditional("average", "single")],
  ["AVERAGEIFS", conditional("average", "multiple")],
  ["MAXIFS", conditional("max", "multiple")],
  ["MINIFS", conditional("min", "multiple")],
  ["COUNTIF", counted("single")],
  ["COUNTIFS", counted("multiple")],
  ["SUMPRODUCT", { min: 1, max: MANY, call: sumProduct }],
  ["ABS", numeric(1, 1, ([x = 0]) => Math.abs(x))],
  ["SIGN", numeric(1, 1, ([x = 0]) => Math.sign(x))],
  ["SQRT", numeric(1, 1, ([x = 0]) => (x < 0 ? NUM : Math.sqrt(x)))],
  ["EXP", numeric(1, 1, ([x = 0]) => Math.exp(x))],
  ["LN", numeric(1, 1, ([x = 0]) => (x <= 0 ? NUM : Math.log(x)))],
  ["LOG10", numeric(1, 1, ([x = 0]) => (x <= 0 ? NUM : Math.log10(x)))],
  [
    "LOG",
    numeric(1, 2, ([x = 0, base = 10], given) => {
      const b = given[1] ? base : 10;
      return x <= 0 || b <= 0 || b === 1 ? (b === 1 ? DIV0 : NUM) : Math.log(x) / Math.log(b);
    }),
  ],
  [
    "POWER",
    numeric(2, 2, ([x = 0, y = 0]) =>
      x === 0 && y === 0 ? NUM : x === 0 && y < 0 ? DIV0 : x ** y,
    ),
  ],
  ["PI", numeric(0, 0, () => Math.PI)],
  ["INT", numeric(1, 1, ([x = 0]) => Math.floor(x))],
  ["TRUNC", numeric(1, 2, ([x = 0, digits = 0]) => roundTo(x, digits, "down"))],
  ["ROUND", roundFunction("half")],
  ["ROUNDUP", roundFunction("up")],
  ["ROUNDDOWN", roundFunction("down")],
  [
    "MROUND",
    numeric(2, 2, ([x = 0, multiple = 0]) => {
      if (multiple === 0) return 0;
      if (Math.sign(x) * Math.sign(multiple) < 0) return NUM;
      return roundTo(x / multiple, 0, "half") * multiple;
    }),
  ],
  ["MOD", numeric(2, 2, ([n = 0, d = 0]) => (d === 0 ? DIV0 : n - d * Math.floor(n / d)))],
  [
    "CEILING",
    numeric(2, 2, ([x = 0, step = 0]) => {
      if (step === 0) return 0;
      if (x > 0 && step < 0) return NUM;
      return Math.ceil(Number((x / step).toPrecision(15))) * step;
    }),
  ],
  [
    "FLOOR",
    numeric(2, 2, ([x = 0, step = 0]) => {
      if (step === 0) return x === 0 ? 0 : DIV0;
      if (x > 0 && step < 0) return NUM;
      return Math.floor(Number((x / step).toPrecision(15))) * step;
    }),
  ],
  [
    "CEILING.MATH",
    numeric(1, 3, ([x = 0, step = 1, mode = 0], given) => {
      const s = Math.abs(given[1] ? step : 1);
      if (s === 0) return 0;
      const q = Number((x / s).toPrecision(15));
      return (x < 0 && given[2] && mode !== 0 ? Math.floor(q) : Math.ceil(q)) * s;
    }),
  ],
  [
    "FLOOR.MATH",
    numeric(1, 3, ([x = 0, step = 1, mode = 0], given) => {
      const s = Math.abs(given[1] ? step : 1);
      if (s === 0) return 0;
      const q = Number((x / s).toPrecision(15));
      return (x < 0 && given[2] && mode !== 0 ? Math.ceil(q) : Math.floor(q)) * s;
    }),
  ],
  ["IF", { min: 1, max: 3, call: ifFunction }],
  ["IFERROR", ifError(false)],
  ["IFNA", ifError(true)],
  ["IFS", { min: 2, max: MANY, call: ifs }],
  ["SWITCH", { min: 3, max: MANY, call: switchFunction }],
  ["CHOOSE", { min: 2, max: MANY, call: choose }],
  ["AND", logical((flags) => flags.every(Boolean))],
  ["OR", logical((flags) => flags.some(Boolean))],
  ["XOR", logical((flags) => flags.filter(Boolean).length % 2 === 1)],
  [
    "NOT",
    lifted(1, 1, ([value]) => {
      const flag = toBoolean(value ?? null);
      return isError(flag) ? flag : !flag;
    }),
  ],
  ["TRUE", { min: 0, max: 0, call: () => true }],
  ["FALSE", { min: 0, max: 0, call: () => false }],
  ["NA", { min: 0, max: 0, call: () => NA }],
  ["ISNUMBER", information((value) => typeof value === "number")],
  ["ISTEXT", information((value) => typeof value === "string")],
  ["ISNONTEXT", information((value) => typeof value !== "string")],
  ["ISLOGICAL", information((value) => typeof value === "boolean")],
  ["ISERROR", information((value) => isError(value))],
  ["ISERR", information((value) => isError(value) && value !== NA)],
  ["ISNA", information((value) => value === NA)],
  ["ISBLANK", { min: 1, max: 1, call: isBlank }],
  [
    "N",
    lifted(1, 1, ([value]) =>
      typeof value === "number"
        ? value
        : typeof value === "boolean"
          ? Number(value)
          : isError(value)
            ? value
            : 0,
    ),
  ],
  ["INDEX", { min: 2, max: 3, call: index }],
  ["MATCH", { min: 2, max: 3, call: match }],
  ["VLOOKUP", lookupTable(false)],
  ["HLOOKUP", lookupTable(true)],
  ["XLOOKUP", { min: 3, max: 6, call: lookupXl }],
  ["LOOKUP", { min: 2, max: 3, call: lookup }],
  ["ROW", rowOrColumn(true)],
  ["COLUMN", rowOrColumn(false)],
  ["ROWS", sizeOf(true)],
  ["COLUMNS", sizeOf(false)],
  ["OFFSET", { min: 3, max: 5, call: offset }],
  ["INDIRECT", { min: 1, max: 2, call: indirect }],
  [
    "SINGLE",
    {
      min: 1,
      max: 1,
      call: (args, context) => {
        const value = args[0]?.value() ?? null;
        return isReference(value)
          ? intersect(value, context)
          : first(operand(value, context, false));
      },
    },
  ],
  ["NPV", { min: 2, max: MANY, call: npv }],
  ["XNPV", { min: 3, max: 3, call: xnpv }],
  ["IRR", { min: 1, max: 2, call: irr }],
  ["XIRR", { min: 2, max: 3, call: xirr }],
  ["MIRR", { min: 3, max: 3, call: mirr }],
  ["RATE", { min: 3, max: 6, call: rate }],
  [
    "PMT",
    numeric(3, 5, ([r = 0, n = 0, pv = 0, fv = 0, type = 0]) =>
      n === 0 ? NUM : payment(r, n, pv, fv, type !== 0 ? 1 : 0),
    ),
  ],
  [
    "IPMT",
    numeric(4, 6, ([r = 0, per = 0, n = 0, pv = 0, fv = 0, type = 0]) =>
      interestPayment(r, per, n, pv, fv, type !== 0 ? 1 : 0),
    ),
  ],
  [
    "PPMT",
    numeric(4, 6, ([r = 0, per = 0, n = 0, pv = 0, fv = 0, type = 0]) => {
      const interest = interestPayment(r, per, n, pv, fv, type !== 0 ? 1 : 0);
      return isError(interest) ? interest : payment(r, n, pv, fv, type !== 0 ? 1 : 0) - interest;
    }),
  ],
  [
    "FV",
    numeric(3, 5, ([r = 0, n = 0, pmt = 0, pv = 0, type = 0]) =>
      futureValue(r, n, pmt, pv, type !== 0 ? 1 : 0),
    ),
  ],
  [
    "PV",
    numeric(3, 5, ([r = 0, n = 0, pmt = 0, fv = 0, type = 0]) => {
      const t = type !== 0 ? 1 : 0;
      if (r === 0) return -(fv + pmt * n);
      const growth = (1 + r) ** n;
      return -(fv + (pmt * (1 + r * t) * (growth - 1)) / r) / growth;
    }),
  ],
  [
    "NPER",
    numeric(3, 5, ([r = 0, pmt = 0, pv = 0, fv = 0, type = 0]) => {
      const t = type !== 0 ? 1 : 0;
      if (r === 0) return pmt === 0 ? NUM : -(pv + fv) / pmt;
      const numerator = pmt * (1 + r * t) - fv * r;
      const denominator = pmt * (1 + r * t) + pv * r;
      if (numerator / denominator <= 0) return NUM;
      return Math.log(numerator / denominator) / Math.log(1 + r);
    }),
  ],
  [
    "SLN",
    numeric(3, 3, ([cost = 0, salvage = 0, life = 0]) =>
      life === 0 ? DIV0 : (cost - salvage) / life,
    ),
  ],
  [
    "DATE",
    dateFunction(3, 3, ([year = 0, month = 0, day = 0], _given, date1904) => {
      const y = Math.trunc(year) < 1900 ? Math.trunc(year) + 1900 : Math.trunc(year);
      if (Math.trunc(year) < 0 || y > 9999) return NUM;
      const serial = serialOf(y, Math.trunc(month) - 1, Math.trunc(day), date1904);
      return serial < 0 ? NUM : serial;
    }),
  ],
  [
    "YEAR",
    dateFunction(1, 1, ([serial = 0], _given, date1904) => partsOf(serial, date1904)?.year ?? NUM),
  ],
  [
    "MONTH",
    dateFunction(1, 1, ([serial = 0], _given, date1904) => {
      const parts = partsOf(serial, date1904);
      return parts ? parts.month + 1 : NUM;
    }),
  ],
  [
    "DAY",
    dateFunction(1, 1, ([serial = 0], _given, date1904) => partsOf(serial, date1904)?.day ?? NUM),
  ],
  [
    "EOMONTH",
    dateFunction(2, 2, ([start = 0, months = 0], _given, date1904) =>
      monthsLater(start, months, date1904, true),
    ),
  ],
  [
    "EDATE",
    dateFunction(2, 2, ([start = 0, months = 0], _given, date1904) =>
      monthsLater(start, months, date1904, false),
    ),
  ],
  [
    "DAYS",
    dateFunction(2, 2, ([end = 0, start = 0], _given, date1904) => {
      assertCalendar(Math.floor(end), date1904);
      assertCalendar(Math.floor(start), date1904);
      return Math.floor(end) - Math.floor(start);
    }),
  ],
  [
    "YEARFRAC",
    dateFunction(2, 3, ([start = 0, end = 0, basis = 0], _given, date1904) =>
      yearFraction(start, end, Math.trunc(basis), date1904),
    ),
  ],
  ["CONCATENATE", stringFunction(1, MANY, (values) => values.map(textOf).join(""))],
  ["CONCAT", { min: 1, max: MANY, call: (args, context) => joinAll(args, context, "", false) }],
  [
    "TEXTJOIN",
    {
      min: 3,
      max: MANY,
      call: (args, context) => {
        const separator = toText(scalarOf(args[0], context));
        const skip = toBoolean(scalarOf(args[1], context));
        if (isError(separator)) return separator;
        if (isError(skip)) return skip;
        return joinAll(args.slice(2), context, separator, skip);
      },
    },
  ],
  [
    "LEFT",
    stringFunction(1, 2, ([value, count], given) => {
      const n = given[1] ? toNumber(count ?? null) : 1;
      if (isError(n)) return n;
      return n < 0 ? VALUE : textOf(value ?? null).slice(0, Math.trunc(n));
    }),
  ],
  [
    "RIGHT",
    stringFunction(1, 2, ([value, count], given) => {
      const n = given[1] ? toNumber(count ?? null) : 1;
      if (isError(n)) return n;
      const whole = textOf(value ?? null);
      return n < 0 ? VALUE : Math.trunc(n) === 0 ? "" : whole.slice(-Math.trunc(n));
    }),
  ],
  [
    "MID",
    stringFunction(3, 3, ([value, start, count]) => {
      const from = toNumber(start ?? null);
      const n = toNumber(count ?? null);
      if (isError(from)) return from;
      if (isError(n)) return n;
      if (from < 1 || n < 0) return VALUE;
      return textOf(value ?? null).slice(
        Math.trunc(from) - 1,
        Math.trunc(from) - 1 + Math.trunc(n),
      );
    }),
  ],
  ["LEN", stringFunction(1, 1, ([value]) => textOf(value ?? null).length)],
  ["UPPER", stringFunction(1, 1, ([value]) => textOf(value ?? null).toUpperCase())],
  ["LOWER", stringFunction(1, 1, ([value]) => textOf(value ?? null).toLowerCase())],
  [
    "TRIM",
    stringFunction(1, 1, ([value]) =>
      textOf(value ?? null)
        .trim()
        .replace(/ {2,}/g, " "),
    ),
  ],
  ["EXACT", stringFunction(2, 2, ([a, b]) => textOf(a ?? null) === textOf(b ?? null))],
  [
    "REPT",
    stringFunction(2, 2, ([value, times]) => {
      const n = toNumber(times ?? null);
      if (isError(n)) return n;
      return n < 0 ? VALUE : textOf(value ?? null).repeat(Math.trunc(n));
    }),
  ],
  [
    "SUBSTITUTE",
    stringFunction(3, 4, ([value, old, now, instance], given) => {
      const whole = textOf(value ?? null);
      const from = textOf(old ?? null);
      const to = textOf(now ?? null);
      if (from === "") return whole;
      if (!given[3]) return whole.split(from).join(to);
      const n = toNumber(instance ?? null);
      if (isError(n)) return n;
      let seen = 0;
      let at = whole.indexOf(from);
      while (at >= 0) {
        if (++seen === Math.trunc(n))
          return whole.slice(0, at) + to + whole.slice(at + from.length);
        at = whole.indexOf(from, at + from.length);
      }
      return whole;
    }),
  ],
  [
    "FIND",
    stringFunction(2, 3, ([wanted, within, start], given) => {
      const from = given[2] ? toNumber(start ?? null) : 1;
      if (isError(from)) return from;
      const found = textOf(within ?? null).indexOf(textOf(wanted ?? null), Math.trunc(from) - 1);
      return found < 0 || from < 1 ? VALUE : found + 1;
    }),
  ],
  [
    "SEARCH",
    stringFunction(2, 3, ([wanted, within, start], given) => {
      const from = given[2] ? toNumber(start ?? null) : 1;
      if (isError(from)) return from;
      const haystack = textOf(within ?? null);
      const pattern = new RegExp(wildcard(textOf(wanted ?? null)).source.slice(1, -1), "i");
      const found = haystack.slice(Math.trunc(from) - 1).search(pattern);
      return found < 0 || from < 1 ? VALUE : found + Math.trunc(from);
    }),
  ],
  ["TEXT", { min: 2, max: 2, call: text }],
  [
    "VALUE",
    {
      min: 1,
      max: 1,
      call: (args, context) =>
        lifted(1, 1, ([value]) => textValue(value ?? null, context.date1904)).call(args, context),
    },
  ],
]);

/** A function by its name as stored, or null when it isn't one worked out here. */
export function workbookFunction(name: string): WorkbookFunction | null {
  return FUNCTIONS.get(name) ?? null;
}

export const SUPPORTED_FUNCTIONS: readonly string[] = [...FUNCTIONS.keys()];
