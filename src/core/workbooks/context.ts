/**
 * What a formula is worked out in (#2347): the cell it is in, how it reads
 * other cells, and how a function reads its arguments. A plain formula reads
 * a block of cells where it wants one value as Excel does, by its row or
 * column (implicit intersection); an array formula ({=…}), and an argument
 * Excel takes as an array (SUMPRODUCT's), reads the whole block.
 */
import type { FormulaNode } from "./parse";
import {
  at,
  type CellError,
  isError,
  isMatrix,
  isReference,
  type Matrix,
  matrix,
  type Reference,
  Refusal,
  type Scalar,
  VALUE,
  type Value,
} from "./values";

/** A non-empty cell in a block: where it is, and its value. */
export interface PlacedValue {
  row: number;
  column: number;
  value: Scalar;
}

export interface Evaluation {
  sheet: string;
  row: number;
  column: number;
  /** An array formula: its expressions are worked out over whole blocks. */
  array: boolean;
  date1904: boolean;
  cell(sheet: string, row: number, column: number): Scalar;
  /** The block's values, cut to where its sheet has any. */
  values(reference: Reference): Matrix;
  /** Its non-empty cells, row by row. */
  filled(reference: Reference): PlacedValue[];
  /** A sheet by its name as a formula writes it, in the workbook's own spelling; null if none. */
  sheetNamed(name: string): string | null;
  /** A defined name's formula, as the formula's sheet sees it; null if none. */
  name(sheet: string | null, name: string): FormulaNode | null;
  evaluate(node: FormulaNode, array: boolean): Value;
}

/** A function's argument, worked out only when the function asks for it. */
export interface Arg {
  node: FormulaNode;
  /** Missing, as in IF(A1,,2). */
  missing: boolean;
  /** Its value, a reference left as one. */
  value(): Value;
  /** Its value worked out over whole arrays, as an array parameter takes it. */
  array(): Scalar | Matrix;
}

/** A reference's one value where one is wanted, as the formula's cell reads it. */
export function intersect(reference: Reference, context: Evaluation): Scalar {
  const { range, sheet } = reference;
  if (range.top === range.bottom && range.left === range.right)
    return context.cell(sheet, range.top, range.left);
  if (range.left === range.right && context.row >= range.top && context.row <= range.bottom)
    return context.cell(sheet, context.row, range.left);
  if (range.top === range.bottom && context.column >= range.left && context.column <= range.right)
    return context.cell(sheet, range.top, context.column);
  return VALUE;
}

/** A value as an operand: a reference read as one value, or as a block in an array formula. */
export function operand(value: Value, context: Evaluation, array: boolean): Scalar | Matrix {
  if (!isReference(value)) return value;
  if (!array) return intersect(value, context);
  const block = context.values(value);
  // Element by element, a blank counts ("" or 0): a block missing its blanks would count wrong.
  if (block.clipped) throw new Refusal("too-large");
  return block;
}

/** One value: an array's first, as a cell shows a formula that gives one. */
export function first(value: Scalar | Matrix): Scalar {
  return isMatrix(value) ? at(value, 0, 0) : value;
}

export function scalarOf(arg: Arg | undefined, context: Evaluation): Scalar {
  if (!arg || arg.missing) return null;
  return first(operand(arg.value(), context, false));
}

/** The values of a reference or array, row by row; a single value alone. */
export function flatten(value: Value, context: Evaluation): Scalar[] {
  if (isReference(value)) return context.filled(value).map((each) => each.value);
  if (isMatrix(value)) return value.values;
  return [value];
}

/** A block's values as an array, whatever was given: a reference's cells, an array, or one value. */
export function arrayOf(value: Value, context: Evaluation): Matrix {
  if (isReference(value)) return context.values(value);
  if (isMatrix(value)) return value;
  return matrix(1, 1, [value]);
}

export const firstError = (values: readonly Scalar[]): CellError | null => {
  for (const value of values) if (isError(value)) return value;
  return null;
};
