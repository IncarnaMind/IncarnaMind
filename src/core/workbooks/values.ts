/**
 * Values as Excel works with them (#2347): numbers, text, TRUE and FALSE,
 * errors and empty cells, arrays of them, and references to cells. The
 * coercions and comparisons follow Excel's: an empty cell is 0 to arithmetic
 * and "" to text, text that reads as a number is one, and numbers sort before
 * text, text before TRUE and FALSE.
 */
import type { CellRange, ErrorCode } from "./parse";

export class CellError {
  constructor(readonly code: ErrorCode) {}
}

const ERRORS = new Map<ErrorCode, CellError>();
export function error(code: ErrorCode): CellError {
  let made = ERRORS.get(code);
  if (!made) {
    made = new CellError(code);
    ERRORS.set(code, made);
  }
  return made;
}

export const DIV0 = error("#DIV/0!");
export const VALUE = error("#VALUE!");
export const NA = error("#N/A");
export const NUM = error("#NUM!");
export const REF = error("#REF!");
export const NAME = error("#NAME?");

/** One cell's value; null is an empty cell. */
export type Scalar = number | string | boolean | CellError | null;

/** An array of values, row by row. */
export interface Matrix {
  kind: "matrix";
  rows: number;
  columns: number;
  values: Scalar[];
  /** A block too large to hold whole, cut to the cells its sheet has: its blanks past them are missing. */
  clipped?: true;
}

/** A block of cells of one sheet, as a reference rather than its values. */
export interface Reference {
  kind: "reference";
  sheet: string;
  range: CellRange;
}

export type Value = Scalar | Matrix | Reference;

export const isError = (value: unknown): value is CellError => value instanceof CellError;

export const isMatrix = (value: Value): value is Matrix =>
  typeof value === "object" && value !== null && !isError(value) && value.kind === "matrix";

export const isReference = (value: Value): value is Reference =>
  typeof value === "object" && value !== null && !isError(value) && value.kind === "reference";

export function matrix(rows: number, columns: number, values: Scalar[]): Matrix {
  return { kind: "matrix", rows, columns, values };
}

export const at = (array: Matrix, row: number, column: number): Scalar =>
  array.values[row * array.columns + column] ?? null;

const NUMERIC_TEXT = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/** Text read as a number as Excel reads it in arithmetic: "1,200", " -3.5 ", "12%", "$40". */
export function textNumber(text: string): number | null {
  let body = text.trim();
  if (body === "") return null;
  let factor = 1;
  if (body.endsWith("%")) {
    factor = 0.01;
    body = body.slice(0, -1).trim();
  }
  let negative = false;
  if (/^\(.*\)$/.test(body)) {
    negative = true;
    body = body.slice(1, -1).trim();
  }
  body = body.replace(/^([-+]?)[$€£¥]/, "$1");
  if (!NUMERIC_TEXT.test(body) || !/\d/.test(body)) return null;
  const value = Number(body.replaceAll(",", "")) * factor;
  return Number.isFinite(value) ? (negative ? -value : value) : null;
}

/** A value as a number to arithmetic: empty is 0, TRUE is 1, text that isn't a number is #VALUE!. */
export function toNumber(value: Scalar): number | CellError {
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const number = textNumber(value);
    if (number !== null) return number;
    if (DATE_LIKE.test(value)) throw new Refusal("date-text");
    return VALUE;
  }
  return value;
}

/** A number as text, as Excel writes one it joins with &: up to 15 significant digits. */
export function numberText(value: number): string {
  if (value === 0) return "0";
  const rounded = Number(value.toPrecision(15));
  const plain = String(rounded);
  if (!plain.includes("e")) return plain;
  const [mantissa, exponent] = rounded.toExponential(14).split("e");
  const digits = (mantissa ?? "").replace(/\.?0+$/, "");
  const power = Number(exponent);
  return `${digits}E${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
}

export function toText(value: Scalar): string | CellError {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return numberText(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value;
}

export function toBoolean(value: Scalar): boolean | CellError {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (upper === "TRUE") return true;
    if (upper === "FALSE") return false;
    return VALUE;
  }
  return value;
}

/** What a formula met as it ran that IncarnaMind can't work out with confidence. */
export type Unsure =
  | "unsorted"
  | "early-date"
  | "criterion"
  | "text-order"
  | "too-large"
  | "date-text";

/** What Excel would read as a date or time, by the computer's settings, in a form not read here. */
export const DATE_LIKE =
  /:|\d[/.-]\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|[年月日]/i;

/** Stops working a formula out: its cell keeps the value Excel saved, named with why. */
export class Refusal extends Error {
  constructor(readonly why: Unsure) {
    super(why);
  }
}

/** Two numbers as Excel compares them: the same when they agree to 15 significant digits. */
export const sameNumber = (a: number, b: number): boolean =>
  a === b || (Number.isFinite(a) && Number.isFinite(b) && a.toPrecision(15) === b.toPrecision(15));

const rank = (value: number | string | boolean) =>
  typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2;

const ORDERED_TEXT = /^[A-Za-z0-9 ]*$/;
const weight = (character: string) => {
  const code = character.charCodeAt(0);
  return character === " " ? 0 : code <= 57 ? code - 47 : code - 54;
};

/**
 * Excel's order of two texts, ignoring case: digits, then letters, and a space before letters.
 * Excel orders punctuation and other scripts by rules of its own ("_" before "A"), so ordering
 * text that holds any is refused; so is a space against a digit, which Excel's documents order
 * both ways.
 */
function textOrder(a: string, b: string): number {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  if (x === y) return 0;
  if (!ORDERED_TEXT.test(x) || !ORDERED_TEXT.test(y)) throw new Refusal("text-order");
  for (let index = 0; index < Math.min(x.length, y.length); index++) {
    const p = x[index] ?? " ";
    const q = y[index] ?? " ";
    if (p === q) continue;
    if ((p === " " && /\d/.test(q)) || (q === " " && /\d/.test(p))) throw new Refusal("text-order");
    return weight(p) - weight(q);
  }
  return x.length - y.length;
}

const filledIn = (
  a: Exclude<Scalar, CellError>,
  b: Exclude<Scalar, CellError>,
): [number | string | boolean, number | string | boolean] => [
  a ?? (typeof b === "string" ? "" : typeof b === "boolean" ? false : 0),
  b ?? (typeof a === "string" ? "" : typeof a === "boolean" ? false : 0),
];

/** Whether two values that aren't errors are equal as Excel's = finds them. */
export function equal(a: Exclude<Scalar, CellError>, b: Exclude<Scalar, CellError>): boolean {
  const [left, right] = filledIn(a, b);
  if (typeof left === "number" && typeof right === "number") return sameNumber(left, right);
  if (typeof left === "string" && typeof right === "string")
    return left.toUpperCase() === right.toUpperCase();
  return left === right;
}

/** Excel's order of two values that aren't errors: negative, 0 or positive. */
export function compare(a: Exclude<Scalar, CellError>, b: Exclude<Scalar, CellError>): number {
  const [left, right] = filledIn(a, b);
  if (rank(left) !== rank(right)) return rank(left) - rank(right);
  if (typeof left === "string" && typeof right === "string") return textOrder(left, right);
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return sameNumber(left as number, right as number) ? 0 : (left as number) - (right as number);
}

/** A whole result that arithmetic gave, or #NUM! for one Excel can't hold. */
export const finite = (value: number): number | CellError => (Number.isFinite(value) ? value : NUM);

/**
 * Applies `apply` to each pair of elements, as Excel does to two arrays: a
 * single value, row or column is repeated to the other's size; past the end
 * of a larger one is #N/A.
 */
export function elementwise(
  left: Scalar | Matrix,
  right: Scalar | Matrix,
  apply: (a: Scalar, b: Scalar) => Scalar,
): Scalar | Matrix {
  if (!isMatrixValue(left) && !isMatrixValue(right)) return apply(left, right);
  const shape = (value: Scalar | Matrix) =>
    isMatrixValue(value) ? { rows: value.rows, columns: value.columns } : { rows: 1, columns: 1 };
  const a = shape(left);
  const b = shape(right);
  const rows = Math.max(a.rows, b.rows);
  const columns = Math.max(a.columns, b.columns);
  const pick = (value: Scalar | Matrix, row: number, column: number): Scalar => {
    if (!isMatrixValue(value)) return value;
    const r = value.rows === 1 ? 0 : row;
    const c = value.columns === 1 ? 0 : column;
    return r < value.rows && c < value.columns ? at(value, r, c) : NA;
  };
  const values: Scalar[] = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      values.push(apply(pick(left, row, column), pick(right, row, column)));
  return matrix(rows, columns, values);
}

function isMatrixValue(value: Scalar | Matrix): value is Matrix {
  return typeof value === "object" && value !== null && !isError(value);
}

/** Applies `apply` to each element of an array, or to a single value. */
export function each(value: Scalar | Matrix, apply: (a: Scalar) => Scalar): Scalar | Matrix {
  if (!isMatrixValue(value)) return apply(value);
  return matrix(value.rows, value.columns, value.values.map(apply));
}
