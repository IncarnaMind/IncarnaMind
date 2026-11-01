/**
 * Excel's formula language as a workbook stores it (#2347): A1 references,
 * ranges, whole columns and rows, other sheets, defined names, functions and
 * array constants, parsed into a tree. What can't be worked out here parses
 * into an `unsupported` node that names it: a link to another workbook, a
 * table's structured reference, a range over several sheets, an
 * intersection, a formula that doesn't parse.
 */
import { columnName } from "../../shared/units";

/** Excel's last row (from 1) and column (from 0). */
export const LAST_ROW = 1_048_576;
export const LAST_COLUMN = 16_383;

/** A block of cells: rows from 1, columns from 0, ends included. */
export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export const ERROR_CODES = [
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#GETTING_DATA",
  "#SPILL!",
  "#CALC!",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Why part of a formula can't be worked out here, for the User to read. */
export type UnsupportedPart =
  | "external"
  | "table"
  | "three-d"
  | "intersection"
  | "union"
  | "syntax"
  | "dynamic-range";

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "&"
  | "="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">=";

export type FormulaNode =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "error"; code: ErrorCode }
  | { kind: "reference"; sheet: string | null; range: CellRange }
  | { kind: "name"; sheet: string | null; name: string }
  | { kind: "unary"; operator: "-" | "+" | "%"; operand: FormulaNode }
  | { kind: "binary"; operator: BinaryOperator; left: FormulaNode; right: FormulaNode }
  | { kind: "call"; name: string; args: FormulaNode[] }
  | { kind: "array"; rows: FormulaNode[][] }
  | { kind: "missing" }
  | { kind: "unsupported"; part: UnsupportedPart; text: string };

/** A reference as written: each end's row and column, and which of them are absolute ($). */
interface WrittenEnd {
  row: number | null;
  column: number | null;
  rowFixed: boolean;
  columnFixed: boolean;
}

type Token =
  | { kind: "number"; value: number; start: number; end: number }
  | { kind: "text"; value: string; start: number; end: number }
  | { kind: "error"; code: ErrorCode; start: number; end: number }
  | {
      kind: "reference";
      /** Its sheet prefix as written ("'Q3 Plan'!"), or "" for none. */
      prefix: string;
      sheet: string | null;
      from: WrittenEnd;
      to: WrittenEnd | null;
      start: number;
      end: number;
    }
  | { kind: "word"; sheet: string | null; word: string; start: number; end: number }
  | { kind: "operator"; value: string; start: number; end: number }
  | { kind: "unsupported"; part: UnsupportedPart; start: number; end: number };

const SPACE = /\s+/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const TEXT = /"((?:[^"]|"")*)"/y;
const ERROR = /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!)/iy;
const QUOTED_SHEET = /'((?:[^']|'')+)'!/y;
const PLAIN_SHEET = /([\p{L}_\\][\p{L}\p{N}_.]*)!/uy;
const SHEETS_RANGE = /[\p{L}_][\p{L}\p{N}_.]*:[\p{L}_][\p{L}\p{N}_.]*!/uy;
const EXTERNAL_SHEET = /\[\d+\][^!]*!/y;
const CELL = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\p{L}\p{N}_.(![])/uy;
const COLUMNS = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\p{L}\p{N}_.(!])/uy;
const ROWS = /(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\p{L}\p{N}_.(!])/uy;
const WORD = /[\p{L}_\\][\p{L}\p{N}_.]*/uy;
const OPERATOR = /<>|<=|>=|[-+*/^&=<>%(),;{}:]/y;

function columnNumber(letters: string): number | null {
  let value = 0;
  for (const letter of letters.toUpperCase()) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value >= 1 && value - 1 <= LAST_COLUMN ? value - 1 : null;
}

function cellEnd(
  columnFixed: string,
  letters: string,
  rowFixed: string,
  digits: string,
): WrittenEnd | null {
  const column = columnNumber(letters);
  const row = Number(digits);
  if (column === null || row < 1 || row > LAST_ROW) return null;
  return { row, column, rowFixed: rowFixed === "$", columnFixed: columnFixed === "$" };
}

/** A reference's ends at `at`, after its sheet prefix; null when there is none there. */
function readReference(
  formula: string,
  at: number,
): { from: WrittenEnd; to: WrittenEnd | null; end: number } | null {
  CELL.lastIndex = at;
  const cell = CELL.exec(formula);
  if (cell) {
    const from = cellEnd(cell[1] ?? "", cell[2] ?? "", cell[3] ?? "", cell[4] ?? "");
    if (!from) return null;
    let end = CELL.lastIndex;
    if (formula[end] === ":") {
      CELL.lastIndex = end + 1;
      const second = CELL.exec(formula);
      const to = second
        ? cellEnd(second[1] ?? "", second[2] ?? "", second[3] ?? "", second[4] ?? "")
        : null;
      if (second && to) {
        end = CELL.lastIndex;
        return { from, to, end };
      }
    }
    return { from, to: null, end };
  }
  COLUMNS.lastIndex = at;
  const columns = COLUMNS.exec(formula);
  if (columns) {
    const left = columnNumber(columns[2] ?? "");
    const right = columnNumber(columns[4] ?? "");
    if (left === null || right === null) return null;
    return {
      from: { row: null, column: left, rowFixed: false, columnFixed: columns[1] === "$" },
      to: { row: null, column: right, rowFixed: false, columnFixed: columns[3] === "$" },
      end: COLUMNS.lastIndex,
    };
  }
  ROWS.lastIndex = at;
  const rows = ROWS.exec(formula);
  if (rows) {
    const top = Number(rows[2]);
    const bottom = Number(rows[4]);
    if (top < 1 || bottom < 1 || top > LAST_ROW || bottom > LAST_ROW) return null;
    return {
      from: { row: top, column: null, rowFixed: rows[1] === "$", columnFixed: false },
      to: { row: bottom, column: null, rowFixed: rows[3] === "$", columnFixed: false },
      end: ROWS.lastIndex,
    };
  }
  return null;
}

function lex(formula: string): Token[] | null {
  const tokens: Token[] = [];
  let at = 0;
  const sticky = (pattern: RegExp) => {
    pattern.lastIndex = at;
    return pattern.exec(formula);
  };
  while (at < formula.length) {
    const start = at;
    const space = sticky(SPACE);
    if (space) {
      at = SPACE.lastIndex;
      continue;
    }
    const text = sticky(TEXT);
    if (text) {
      at = TEXT.lastIndex;
      tokens.push({ kind: "text", value: (text[1] ?? "").replaceAll('""', '"'), start, end: at });
      continue;
    }
    const error = sticky(ERROR);
    if (error) {
      at = ERROR.lastIndex;
      const code = ERROR_CODES.find((each) => each === error[0].toUpperCase()) ?? "#VALUE!";
      tokens.push({ kind: "error", code, start, end: at });
      continue;
    }
    if (formula[at] === "[" || sticky(EXTERNAL_SHEET)) {
      return [{ kind: "unsupported", part: "external", start, end: formula.length }];
    }
    if (sticky(SHEETS_RANGE)) {
      tokens.push({ kind: "unsupported", part: "three-d", start, end: SHEETS_RANGE.lastIndex });
      const after = readReference(formula, SHEETS_RANGE.lastIndex);
      at = after ? after.end : SHEETS_RANGE.lastIndex;
      continue;
    }
    let sheet: string | null = null;
    let prefixEnd = at;
    const quoted = sticky(QUOTED_SHEET);
    const plain = quoted ? null : sticky(PLAIN_SHEET);
    if (quoted) {
      sheet = (quoted[1] ?? "").replaceAll("''", "'");
      prefixEnd = QUOTED_SHEET.lastIndex;
    } else if (plain) {
      sheet = plain[1] ?? "";
      prefixEnd = PLAIN_SHEET.lastIndex;
    }
    if (sheet !== null) {
      if (sheet.includes("[") || formula[prefixEnd] === "[") {
        return [{ kind: "unsupported", part: "external", start, end: formula.length }];
      }
      if (/^[^:]+:[^:]+$/.test(sheet)) {
        tokens.push({ kind: "unsupported", part: "three-d", start, end: prefixEnd });
        const after = readReference(formula, prefixEnd);
        at = after ? after.end : prefixEnd;
        continue;
      }
    }
    const reference = readReference(formula, prefixEnd);
    if (reference) {
      at = reference.end;
      tokens.push({
        kind: "reference",
        prefix: formula.slice(start, prefixEnd),
        sheet,
        from: reference.from,
        to: reference.to,
        start,
        end: at,
      });
      continue;
    }
    if (sheet !== null) {
      ERROR.lastIndex = prefixEnd;
      const sheetError = ERROR.exec(formula);
      if (sheetError) {
        at = ERROR.lastIndex;
        tokens.push({ kind: "error", code: "#REF!", start, end: at });
        continue;
      }
    }
    WORD.lastIndex = prefixEnd;
    const word = WORD.exec(formula);
    if (word) {
      at = WORD.lastIndex;
      if (formula[at] === "[") {
        let depth = 0;
        while (at < formula.length) {
          if (formula[at] === "[") depth++;
          else if (formula[at] === "]" && --depth === 0) break;
          at++;
        }
        tokens.push({ kind: "unsupported", part: "table", start, end: at + 1 });
        at++;
        continue;
      }
      tokens.push({ kind: "word", sheet, word: word[0], start, end: at });
      continue;
    }
    if (sheet !== null) return null;
    const number = sticky(NUMBER);
    if (number) {
      at = NUMBER.lastIndex;
      tokens.push({ kind: "number", value: Number(number[0]), start, end: at });
      continue;
    }
    const operator = sticky(OPERATOR);
    if (operator) {
      at = OPERATOR.lastIndex;
      tokens.push({ kind: "operator", value: operator[0], start, end: at });
      continue;
    }
    return null;
  }
  return tokens;
}

function rangeOf(from: WrittenEnd, to: WrittenEnd | null): CellRange {
  const end = to ?? from;
  const rows = [from.row ?? 1, end.row ?? LAST_ROW];
  const columns = [from.column ?? 0, end.column ?? LAST_COLUMN];
  if (from.row === null || end.row === null) {
    rows[0] = 1;
    rows[1] = LAST_ROW;
  }
  if (from.column === null || end.column === null) {
    columns[0] = 0;
    columns[1] = LAST_COLUMN;
  }
  return {
    top: Math.min(rows[0] ?? 1, rows[1] ?? 1),
    bottom: Math.max(rows[0] ?? 1, rows[1] ?? 1),
    left: Math.min(columns[0] ?? 0, columns[1] ?? 0),
    right: Math.max(columns[0] ?? 0, columns[1] ?? 0),
  };
}

/** Function names as a workbook stores newer ones: "_xlfn.XLOOKUP" is XLOOKUP. */
export function functionName(stored: string): string {
  return stored.replace(/^_xlfn\.(?:_xlws\.)?/i, "").toUpperCase();
}

const BINARY: ReadonlyMap<string, { power: number; right: boolean }> = new Map([
  ["=", { power: 1, right: false }],
  ["<>", { power: 1, right: false }],
  ["<", { power: 1, right: false }],
  [">", { power: 1, right: false }],
  ["<=", { power: 1, right: false }],
  [">=", { power: 1, right: false }],
  ["&", { power: 2, right: false }],
  ["+", { power: 3, right: false }],
  ["-", { power: 3, right: false }],
  ["*", { power: 4, right: false }],
  ["/", { power: 4, right: false }],
  ["^", { power: 5, right: false }],
]);
const PERCENT_POWER = 6;
const NEGATION_POWER = 7;

class ParseError extends Error {
  constructor(readonly part: UnsupportedPart = "syntax") {
    super(part);
  }
}

/**
 * Parses a formula as a workbook stores it, without its "=". A formula that
 * doesn't parse, or has a part that can't be worked out, is one
 * `unsupported` node naming the first such part.
 */
export function parseFormula(formula: string): FormulaNode {
  const tokens = lex(formula);
  if (!tokens) return { kind: "unsupported", part: "syntax", text: formula };
  let at = 0;
  const peek = () => tokens[at];
  const isOperator = (value: string, token = peek()) =>
    token?.kind === "operator" && token.value === value;
  const expect = (value: string) => {
    if (!isOperator(value)) throw new ParseError();
    at++;
  };

  const constant = (): FormulaNode => {
    const token = tokens[at++];
    if (!token) throw new ParseError();
    if (token.kind === "operator" && (token.value === "-" || token.value === "+")) {
      const next = constant();
      if (next.kind !== "number") throw new ParseError();
      return token.value === "-" ? { kind: "number", value: -next.value } : next;
    }
    if (token.kind === "number") return { kind: "number", value: token.value };
    if (token.kind === "text") return { kind: "text", value: token.value };
    if (token.kind === "error") return { kind: "error", code: token.code };
    if (token.kind === "word" && /^(TRUE|FALSE)$/i.test(token.word))
      return { kind: "boolean", value: token.word.toUpperCase() === "TRUE" };
    throw new ParseError();
  };

  const arrayConstant = (): FormulaNode => {
    const rows: FormulaNode[][] = [[]];
    for (;;) {
      rows[rows.length - 1]?.push(constant());
      if (isOperator(",")) at++;
      else if (isOperator(";")) {
        at++;
        rows.push([]);
      } else break;
    }
    expect("}");
    const width = rows[0]?.length ?? 0;
    if (rows.some((row) => row.length !== width)) throw new ParseError();
    return { kind: "array", rows };
  };

  const callArguments = (): FormulaNode[] => {
    const args: FormulaNode[] = [];
    if (isOperator(")")) {
      at++;
      return args;
    }
    for (;;) {
      args.push(isOperator(",") || isOperator(")") ? { kind: "missing" } : expression(0));
      if (isOperator(",")) {
        at++;
        continue;
      }
      expect(")");
      return args;
    }
  };

  const primary = (): FormulaNode => {
    const token = tokens[at++];
    if (!token) throw new ParseError();
    switch (token.kind) {
      case "number":
        return { kind: "number", value: token.value };
      case "text":
        return { kind: "text", value: token.value };
      case "error":
        return { kind: "error", code: token.code };
      case "unsupported":
        throw new ParseError(token.part);
      case "reference":
        return { kind: "reference", sheet: token.sheet, range: rangeOf(token.from, token.to) };
      case "word": {
        if (isOperator("(")) {
          at++;
          return { kind: "call", name: token.word, args: callArguments() };
        }
        if (token.sheet === null && /^(TRUE|FALSE)$/i.test(token.word))
          return { kind: "boolean", value: token.word.toUpperCase() === "TRUE" };
        return { kind: "name", sheet: token.sheet, name: token.word };
      }
      case "operator": {
        if (token.value === "(") {
          const inner = expression(0);
          if (isOperator(",")) throw new ParseError("union");
          expect(")");
          return inner;
        }
        if (token.value === "{") return arrayConstant();
        if (token.value === "-" || token.value === "+") {
          const operand = expression(NEGATION_POWER);
          return { kind: "unary", operator: token.value, operand };
        }
        throw new ParseError();
      }
    }
  };

  const expression = (minimum: number): FormulaNode => {
    let left = primary();
    for (;;) {
      const token = peek();
      if (!token) return left;
      if (token.kind !== "operator") throw new ParseError("intersection");
      if (token.value === "%") {
        if (PERCENT_POWER < minimum) return left;
        at++;
        left = { kind: "unary", operator: "%", operand: left };
        continue;
      }
      if (token.value === ":") throw new ParseError("dynamic-range");
      const binary = BINARY.get(token.value);
      if (!binary || binary.power < minimum) return left;
      at++;
      const right = expression(binary.right ? binary.power : binary.power + 1);
      left = { kind: "binary", operator: token.value as BinaryOperator, left, right };
    }
  };

  try {
    const node = expression(0);
    if (at < tokens.length) {
      const rest = tokens[at];
      throw new ParseError(rest?.kind === "unsupported" ? rest.part : "syntax");
    }
    return node;
  } catch (error) {
    if (error instanceof ParseError)
      return { kind: "unsupported", part: error.part, text: formula };
    throw error;
  }
}

/** A sheet's name as a formula writes it: quoted when it has to be. */
export function sheetPrefix(sheet: string): string {
  return /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(sheet) && !/^[A-Za-z]{1,3}\d+$/.test(sheet)
    ? `${sheet}!`
    : `'${sheet.replaceAll("'", "''")}'!`;
}

/** A cell's A1 reference: "C12". */
export const cellName = (row: number, column: number): string => `${columnName(column)}${row}`;

/** A range as A1 text: "C12", "C3:C12", "C:C", "3:3". */
export function rangeName(range: CellRange): string {
  if (range.top === 1 && range.bottom === LAST_ROW)
    return `${columnName(range.left)}:${columnName(range.right)}`;
  if (range.left === 0 && range.right === LAST_COLUMN) return `${range.top}:${range.bottom}`;
  const from = cellName(range.top, range.left);
  return range.top === range.bottom && range.left === range.right
    ? from
    : `${from}:${cellName(range.bottom, range.right)}`;
}

function shiftedEnd(end: WrittenEnd, rows: number, columns: number): string | null {
  const column = end.column === null ? null : end.columnFixed ? end.column : end.column + columns;
  const row = end.row === null ? null : end.rowFixed ? end.row : end.row + rows;
  if (column !== null && (column < 0 || column > LAST_COLUMN)) return null;
  if (row !== null && (row < 1 || row > LAST_ROW)) return null;
  return `${column === null ? "" : `${end.columnFixed ? "$" : ""}${columnName(column)}`}${
    row === null ? "" : `${end.rowFixed ? "$" : ""}${row}`
  }`;
}

/**
 * A shared formula as the cell `rows` down and `columns` across from the one
 * that stores it reads: its relative references moved, its absolute ($) ones
 * kept, as Excel fills a formula. A reference moved off the sheet is #REF!.
 */
export function moveFormula(formula: string, rows: number, columns: number): string {
  if (rows === 0 && columns === 0) return formula;
  const tokens = lex(formula);
  if (!tokens) return formula;
  let moved = "";
  let from = 0;
  for (const token of tokens) {
    if (token.kind !== "reference") continue;
    const start = shiftedEnd(token.from, rows, columns);
    const end = token.to ? shiftedEnd(token.to, rows, columns) : "";
    moved += formula.slice(from, token.start);
    moved +=
      start === null || end === null
        ? "#REF!"
        : `${token.prefix}${start}${token.to ? `:${end}` : ""}`;
    from = token.end;
  }
  return moved + formula.slice(from);
}
