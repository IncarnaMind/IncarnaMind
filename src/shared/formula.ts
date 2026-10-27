/**
 * Formulas: the arithmetic behind a calculated figure, done by IncarnaMind
 * rather than in a model's head. A formula combines named inputs, each a
 * figure read from a quote (./figures), in a small part of Excel's formula
 * language: models write it fluently, finance Users read it, and a workbook
 * given the same formula over the same values computes the same doubles.
 *
 * Nothing in a formula reaches JavaScript. The parser knows numbers, the
 * inputs' names, operators, brackets and an allow-list of functions; a name
 * is looked up in a Map of the inputs and a function in a Map of its own,
 * never as a property of an object, and nothing is ever run as code.
 *
 * Units travel with the values, so a combination that can't be right is
 * refused in one line the model can act on, never computed: yuan added to
 * dollars, a percent added to an amount, a difference of percents shown as
 * a percent.
 *
 * Pure, with no Node or DOM imports: the core and the renderer share it.
 */
import type { Language } from "../core/language";
import { type FigureUnit, type Reading, scaleExponent } from "./figures";
import { translate } from "./i18n";

/**
 * The rules a result is worked out and shown by. A calculated figure keeps
 * the version it was made with, so checking it later runs the same rules
 * even after they change.
 */
export const FORMULA_VERSION = 1;

/** What a result measures: a figure's units, and those only arithmetic makes. */
export type ResultUnit =
  | FigureUnit
  /** Like divided by like: 1.25. */
  | { kind: "ratio" }
  /** `of` per one `per`, both ISO 4217 codes: what dividing yuan by dollars gives. */
  | { kind: "rate"; of: string; per: string }
  | { kind: "yes-no" };

/** An input as a formula sees it: a figure read from a quote, under its name in the formula. */
export interface FormulaInput extends Omit<Reading, "unit"> {
  /** "rev2024": a letter or "_" first, then letters, digits and "_". Matched ignoring case, as Excel does. */
  name: string;
  /** A figure's unit, or an exchange rate given as a cited input. */
  unit: FigureUnit | { kind: "rate"; of: string; per: string };
  approximate: boolean;
}

/** A number written in the formula itself, which no quote backs, so a reader is shown it. */
export interface FormulaLiteral {
  /** As written: "4", "5%". */
  text: string;
  value: number;
  /** Its UTF-16 offset in the formula. */
  at: number;
}

/** The scale and decimals an amount input was written in; a result made from it is shown in them. */
export interface WrittenScale {
  /** The power of ten its scale word multiplies by: 8 for "亿". */
  exponent: number;
  word: string | null;
  decimals: number;
}

/**
 * A power of ten in a formula that moves an amount into another scale, as
 * "rev / 10000" reads 万 as 亿 (#577). Inputs are in base units with their
 * page's scale applied already, so the figure would come out that many times
 * too small or large; the scale it is shown in is an option of showing it.
 */
export interface ScaleChange {
  /** The part of the formula that does it: "rev25 / 10000". */
  text: string;
  /** The amount it moves: "rev25". */
  amount: string;
  /** The power of ten the amount ends up multiplied by: −4 for "/ 10000". */
  exponent: number;
  /** The scale the amount's inputs were written in: 万 for 120,345.67 under "单位：万元". */
  from: WrittenScale | null;
}

export interface FormulaResult {
  ok: true;
  version: number;
  /** A double, as Excel computes it; true or false for a comparison. */
  value: number | boolean;
  unit: ResultUnit;
  /** Worked out from an approximate input, so it is approximate too. */
  approximate: boolean;
  literals: FormulaLiteral[];
  /** The scales of the amounts it was worked out from, for showing it. */
  scales: WrittenScale[];
}

export type FormulaProblemKind =
  | "syntax"
  | "name"
  | "function"
  | "units"
  | "zero"
  | "number"
  | "input"
  | "show"
  | "version";

/** Why a formula wasn't worked out or shown, in one line for the model to fix it by. */
export interface FormulaProblem {
  ok: false;
  kind: FormulaProblemKind;
  message: string;
}

export type ShowAs = "number" | "percent" | "points" | "currency" | "times" | "yes-no";

export interface ShowOptions {
  /** The Answer's language, which the result is written in. */
  language: Language;
  /** Instead of the unit's own way: a ratio as a percent or a multiple. */
  as?: ShowAs | null;
  /** Decimal places, 0 to 10, instead of the unit's default. */
  decimals?: number | null;
  /** For an amount: a scale word in the Answer's language, such as "million" or "亿". */
  scale?: string | null;
}

class Refusal extends Error {
  constructor(
    readonly kind: FormulaProblemKind,
    message: string,
  ) {
    super(message);
  }
}

function refuse(kind: FormulaProblemKind, message: string): never {
  throw new Refusal(kind, message);
}

/** Long and deep enough for any figure; beyond them a formula is an attack on the parser's stack. */
export const FORMULA_MAX_LENGTH = 2000;
const MAX_DEPTH = 50;

interface Token {
  kind: "number" | "name" | "operator" | "end";
  text: string;
  at: number;
}

const SPACE = /\s+/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME = /[\p{L}_][\p{L}\d_]*/uy;
const OPERATOR = /<>|<=|>=|[-+*/^%(),=<>]/y;
const NAME_ONLY = /^[\p{L}_][\p{L}\d_]*$/u;

/** What models write for an operator Excel spells otherwise. */
const INSTEAD: ReadonlyMap<string, string> = new Map([
  ["×", "*"],
  ["÷", "/"],
  ["−", "-"],
  ["–", "-"],
  ["（", "("],
  ["）", ")"],
  ["，", ","],
]);

const quoted = (text: string) => (text.includes('"') ? `'${text}'` : `"${text}"`);

function lex(formula: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const take = (pattern: RegExp): string | null => {
    pattern.lastIndex = at;
    return pattern.exec(formula)?.[0] ?? null;
  };
  while (at < formula.length) {
    const space = take(SPACE);
    if (space) {
      at += space.length;
      continue;
    }
    let kind: Token["kind"] = "number";
    let text = take(NUMBER);
    if (text === null) {
      kind = "name";
      text = take(NAME);
    }
    if (text === null) {
      kind = "operator";
      text = take(OPERATOR);
    }
    if (text === null) {
      const char = String.fromCodePoint(formula.codePointAt(at) ?? 0);
      const instead = INSTEAD.get(char);
      return refuse(
        "syntax",
        `formula: unexpected ${quoted(char)} at character ${at + 1}${instead ? `; write ${instead} instead` : ""}.`,
      );
    }
    tokens.push({ kind, text, at });
    at += text.length;
  }
  return tokens;
}

type FunctionName = "SUM" | "AVERAGE" | "MIN" | "MAX" | "ABS" | "ROUND" | "RRI" | "SQRT";

const FUNCTIONS: ReadonlyMap<
  string,
  { name: FunctionName; min: number; max: number; usage: string }
> = new Map(
  (
    [
      ["SUM", 1, 255, "SUM(a, b, …)"],
      ["AVERAGE", 1, 255, "AVERAGE(a, b, …)"],
      ["MIN", 1, 255, "MIN(a, b, …)"],
      ["MAX", 1, 255, "MAX(a, b, …)"],
      ["ABS", 1, 1, "ABS(x)"],
      ["ROUND", 2, 2, "ROUND(x, decimals)"],
      ["RRI", 3, 3, "RRI(periods, start, end)"],
      ["SQRT", 1, 1, "SQRT(x)"],
    ] as const
  ).map(([name, min, max, usage]) => [name, { name, min, max, usage }]),
);

const OFFERED = `+ - * / ^, ${[...FUNCTIONS.keys()].join(", ")}`;

type Operator = "+" | "-" | "*" | "/" | "^" | "=" | "<>" | "<" | ">" | "<=" | ">=";

type Node = { from: number; to: number } & (
  | { type: "number"; value: number; text: string; percent: boolean }
  | { type: "name"; name: string }
  | { type: "boolean"; value: boolean }
  | { type: "negate" | "plus"; operand: Node }
  | { type: "binary"; op: Operator; left: Node; right: Node }
  | { type: "call"; name: FunctionName; args: Node[] }
);

/**
 * Excel's precedence, which isn't a textbook's: a sign binds tighter than
 * "^" (-2^2 is 4), "^" groups from the left (2^3^2 is 64), and "%" divides
 * the number before it by 100. A formula reads the same here as in a sheet.
 */
function parse(formula: string): Node {
  if (formula.length > FORMULA_MAX_LENGTH)
    refuse(
      "syntax",
      `formula: it's longer than ${FORMULA_MAX_LENGTH} characters; write it in fewer.`,
    );
  const tokens = lex(formula);
  const end: Token = { kind: "end", text: "", at: formula.length };
  let index = 0;
  let depth = 0;
  const peek = (): Token => tokens[index] ?? end;
  const next = (): Token => {
    const token = peek();
    index++;
    return token;
  };
  const is = (...operators: string[]) =>
    peek().kind === "operator" && operators.includes(peek().text);
  const unexpected = (token: Token): never =>
    token.kind === "end"
      ? refuse("syntax", "formula: it ends too soon; a number, a name or a ) is missing.")
      : refuse("syntax", `formula: unexpected ${quoted(token.text)} at character ${token.at + 1}.`);
  const nested = <T>(read: () => T): T => {
    depth++;
    if (depth > MAX_DEPTH)
      refuse("syntax", `formula: brackets and signs nest more than ${MAX_DEPTH} deep.`);
    const node = read();
    depth--;
    return node;
  };
  const closing = () => {
    const close = next();
    if (close.kind !== "operator" || close.text !== ")") unexpected(close);
    return close.at + 1;
  };
  const binary = (left: Node, op: Operator, right: Node): Node => ({
    type: "binary",
    op,
    left,
    right,
    from: left.from,
    to: right.to,
  });
  const leftToRight = (operators: Operator[], operand: () => Node) => (): Node => {
    let left = operand();
    while (is(...operators)) {
      const token = next();
      const op = operators.find((each) => each === token.text) ?? unexpected(token);
      left = binary(left, op, operand());
    }
    return left;
  };

  const primary = (): Node => {
    const token = next();
    const to = token.at + token.text.length;
    if (token.kind === "number") {
      const value = Number(token.text);
      if (!Number.isFinite(value))
        refuse("number", `formula: ${token.text} is too large for a number.`);
      return { type: "number", value, text: token.text, percent: false, from: token.at, to };
    }
    if (token.kind === "name") {
      const upper = token.text.toUpperCase();
      if (is("(")) {
        const fn = FUNCTIONS.get(upper);
        if (!fn) return refuse("function", `${token.text} isn't available; use ${OFFERED}.`);
        next();
        return nested(() => {
          const args: Node[] = [];
          if (!is(")")) {
            args.push(comparison());
            while (is(",")) {
              next();
              args.push(comparison());
            }
          }
          const close = closing();
          if (args.length < fn.min || args.length > fn.max) {
            const count =
              fn.min === fn.max ? `${fn.min} value${fn.min > 1 ? "s" : ""}` : "1 to 255 values";
            refuse("function", `${fn.name} takes ${count}: ${fn.usage}.`);
          }
          return { type: "call", name: fn.name, args, from: token.at, to: close };
        });
      }
      if (upper === "TRUE" || upper === "FALSE")
        return { type: "boolean", value: upper === "TRUE", from: token.at, to };
      return { type: "name", name: token.text, from: token.at, to };
    }
    if (token.kind === "operator" && token.text === "(") {
      return nested(() => {
        const inner = comparison();
        return { ...inner, from: token.at, to: closing() };
      });
    }
    return unexpected(token);
  };

  const percent = (): Node => {
    const node = primary();
    if (!is("%")) return node;
    const sign = next();
    if (node.type !== "number" || node.percent)
      return refuse(
        "syntax",
        `formula: the % at character ${sign.at + 1} can only follow a number written in the formula, such as 5%.`,
      );
    return {
      ...node,
      value: node.value / 100,
      text: `${node.text}%`,
      percent: true,
      to: sign.at + 1,
    };
  };

  const unary = (): Node => {
    if (!is("-", "+")) return percent();
    const sign = next();
    return nested(() => {
      const operand = unary();
      const type = sign.text === "-" ? "negate" : "plus";
      return { type, operand, from: sign.at, to: operand.to };
    });
  };

  const power = leftToRight(["^"], unary);
  const product = leftToRight(["*", "/"], power);
  const sum = leftToRight(["+", "-"], product);
  const comparison = leftToRight(["=", "<>", "<", ">", "<=", ">="], sum);

  // Excel's own "=" before a formula.
  if (is("=")) next();
  if (peek().kind === "end")
    refuse("syntax", "formula: it's empty; write it over the inputs' names, such as (b - a) / a.");
  const tree = comparison();
  if (peek().kind !== "end") unexpected(peek());
  return tree;
}

function nodesIn(node: Node, keep: (node: Node) => boolean, into: Node[] = []): Node[] {
  if (keep(node)) into.push(node);
  if (node.type === "negate" || node.type === "plus") nodesIn(node.operand, keep, into);
  else if (node.type === "binary") {
    nodesIn(node.left, keep, into);
    nodesIn(node.right, keep, into);
  } else if (node.type === "call") {
    for (const arg of node.args) nodesIn(arg, keep, into);
  }
  return into;
}

/** A number written in the formula has no unit of its own: it scales, or it is a share like the "1" in "b / a - 1". */
type Unit = ResultUnit | { kind: "number" };

const RATIO: Unit = { kind: "ratio" };
const PERCENT: Unit = { kind: "percent" };
const POINTS: Unit = { kind: "points" };
const TIMES: Unit = { kind: "times" };
const NUMBER_UNIT: Unit = { kind: "number" };
const YES_NO: Unit = { kind: "yes-no" };

/** One of the shares a difference of is percentage points. */
const isFraction = (unit: Unit) => unit.kind === "ratio" || unit.kind === "percent";
/** What multiplies an amount without changing what it is. */
const isScalar = (unit: Unit) =>
  unit.kind === "number" ||
  unit.kind === "ratio" ||
  unit.kind === "percent" ||
  unit.kind === "times";
/** Money or a count, whose scale and decimals the inputs set. A plain figure's unit is only unstated. */
const isAmount = (unit: Unit) =>
  unit.kind === "plain" || unit.kind === "currency" || unit.kind === "other";
const isCount = (unit: Unit) => unit.kind === "number" || unit.kind === "plain";

function same(a: Unit, b: Unit): boolean {
  if (a.kind === "currency" && b.kind === "currency") return a.code === b.code;
  if (a.kind === "other" && b.kind === "other")
    return a.word.toLowerCase() === b.word.toLowerCase();
  if (a.kind === "rate" && b.kind === "rate") return a.of === b.of && a.per === b.per;
  return a.kind === b.kind;
}

/** A comparison's yes or no is 1 or 0, as Excel's TRUE and FALSE are. */
interface Value {
  n: number;
  unit: Unit;
  approximate: boolean;
  scales: WrittenScale[];
  node: Node;
}

const isZero = (value: Value) => value.unit.kind === "number" && value.n === 0;

/**
 * The unit of a sum, of a comparison's two sides, or of a MIN's values;
 * null when they can't be put together. A number written in the formula
 * joins shares, but never an amount: "rev + 100" would add 100 to a value
 * whose scale is already applied, and 100 of what is the question a cited
 * input answers. Zero is zero in any unit, so "profit > 0" stands.
 */
function joined(a: Value, b: Value): Unit | null {
  const [x, y] = [a.unit, b.unit];
  if (x.kind === "yes-no" || y.kind === "yes-no") return null;
  if (same(x, y)) return x;
  if (isZero(a)) return y;
  if (isZero(b)) return x;
  for (const [p, q] of [
    [x, y],
    [y, x],
  ]) {
    if (!p || !q) continue;
    if (p.kind === "number" && (isScalar(q) || q.kind === "points")) return q;
    if (p.kind === "ratio" && q.kind === "percent") return q;
    if (p.kind === "percent" && q.kind === "points") return p;
  }
  return null;
}

/**
 * A difference of two shares is percentage points, whether the shares were
 * quoted (41.2% − 38.9%) or worked out (gp / rev − gp_prior / rev_prior):
 * "up 2.3%" would say something else.
 */
function difference(a: Value, b: Value): Unit | null {
  if (isFraction(a.unit) && isFraction(b.unit)) return POINTS;
  if (a.unit.kind === "points" && b.unit.kind === "percent") return null;
  return joined(a, b);
}

function product(a: Unit, b: Unit): Unit | null {
  if (a.kind === "yes-no" || b.kind === "yes-no") return null;
  if (a.kind === "number") return b;
  if (b.kind === "number") return a;
  for (const [p, q] of [
    [a, b],
    [b, a],
  ]) {
    if (!p || !q) continue;
    if (isScalar(p) && (isAmount(q) || q.kind === "rate" || q.kind === "points")) return q;
    if (p.kind === "plain" && (q.kind === "currency" || q.kind === "other" || q.kind === "rate"))
      return q;
    if (p.kind === "currency" && q.kind === "rate" && q.per === p.code)
      return { kind: "currency", code: q.of };
  }
  if (isScalar(a) && isScalar(b)) {
    if (a.kind === b.kind) return a;
    return a.kind === "times" || b.kind === "times" ? TIMES : PERCENT;
  }
  if (a.kind === "plain" && b.kind === "plain") return a;
  return null;
}

/** Like over like is a ratio; an amount over another currency's is an exchange rate. */
function quotient(a: Unit, b: Unit): Unit | null {
  if (a.kind === "yes-no" || b.kind === "yes-no") return null;
  if (b.kind === "number") return a;
  if (same(a, b) || (isFraction(a) && isFraction(b))) return RATIO;
  if (a.kind === "number") {
    if (isScalar(b)) return RATIO;
    if (b.kind === "plain") return b;
    if (b.kind === "rate") return { kind: "rate", of: b.per, per: b.of };
    return null;
  }
  if (a.kind === "currency" && b.kind === "currency")
    return { kind: "rate", of: a.code, per: b.code };
  if (a.kind === "currency" && b.kind === "rate" && b.of === a.code)
    return { kind: "currency", code: b.per };
  if ((isAmount(a) || a.kind === "rate" || a.kind === "points") && isScalar(b)) return a;
  if ((a.kind === "currency" || a.kind === "other") && b.kind === "plain") return a;
  if (isScalar(a) && isScalar(b)) return RATIO;
  return null;
}

/** What a power of a value is: only of a number with no unit, or of a ratio such as end ÷ start. */
function powerOf(base: Unit): Unit | null {
  if (isCount(base) || base.kind === "ratio") return base;
  return base.kind === "percent" ? RATIO : null;
}

function phrase(unit: Unit): string {
  switch (unit.kind) {
    case "number":
      return "a number written in the formula";
    case "plain":
      return "a number with no unit";
    case "ratio":
      return "a ratio";
    case "percent":
      return "a percent";
    case "points":
      return "percentage points";
    case "times":
      return "a multiple";
    case "currency":
      return `an amount in ${unit.code}`;
    case "other":
      return `an amount in ${unit.word}`;
    case "rate":
      return `an exchange rate (${unit.of} per ${unit.per})`;
    case "yes-no":
      return "yes or no";
  }
}

/** Excel compares on the 15 significant digits it keeps, so 0.1 + 0.2 = 0.3 holds there and here. */
const excelDigits = (x: number) => Number(x.toPrecision(15));

/**
 * A number with no unit or scale of its own ("3.5" in "3.5:1") times an amount in a scale is a
 * multiplier: the product is shown as the amount is written. Its own decimals, moved into that
 * scale, would show as noise: "£154.0000000 million" for £44 million × 3.5 (#1784).
 */
function productScales(a: Value, b: Value): WrittenScale[] {
  const multiplies = (x: Value, y: Value) =>
    x.unit.kind === "plain" &&
    x.scales.every((each) => each.exponent === 0) &&
    y.scales.some((each) => each.exponent > 0);
  if (multiplies(a, b)) return b.scales;
  if (multiplies(b, a)) return a.scales;
  return [...a.scales, ...b.scales];
}

/** The powers of ten that scale words stand for: thousand, 万, million, 亿, billion, trillion. */
const SCALE_STEPS: ReadonlySet<number> = new Set([3, 4, 6, 8, 9, 12]);
/** The scales Chinese statements are written in: 千, 万, 百万, 亿, 万亿. */
const CHINESE_SCALES: ReadonlySet<number> = new Set([3, 4, 6, 8, 12]);

/** The power of ten a number written in the formula is ("10000", "1e8", "10^4", "0.001"); null for any other. */
function powerOfTen(value: Value): number | null {
  if (value.unit.kind !== "number" || value.n <= 0) return null;
  const exponent = Math.round(Math.log10(value.n));
  return Math.abs(10 ** exponent - value.n) <= 1e-9 * value.n ? exponent : null;
}

function evaluate(
  tree: Node,
  formula: string,
  inputs: ReadonlyMap<string, FormulaInput>,
  changes?: Map<Node, ScaleChange>,
): Value {
  const source = (node: Node) => {
    const text = formula.slice(node.from, node.to).replace(/\s+/g, " ").trim();
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  };
  const describe = (value: Value) => `${phrase(value.unit)} (${source(value.node)})`;

  const mismatch = (
    verb: "add" | "subtract" | "compare" | "multiply" | "divide",
    a: Value,
    b: Value,
  ): never => {
    const [x, y] = [a.unit, b.unit];
    if (
      x.kind === "currency" &&
      y.kind === "currency" &&
      x.code !== y.code &&
      (verb === "add" || verb === "subtract" || verb === "compare")
    ) {
      refuse(
        "units",
        `${source(a.node)} is ${x.code} and ${source(b.node)} is ${y.code}; add an exchange rate as a cited input.`,
      );
    }
    const sentence = {
      add: `can't add ${describe(b)} to ${describe(a)}`,
      subtract: `can't subtract ${describe(b)} from ${describe(a)}`,
      compare: `can't compare ${describe(a)} with ${describe(b)}`,
      multiply: `can't multiply ${describe(a)} by ${describe(b)}`,
      divide: `can't divide ${describe(a)} by ${describe(b)}`,
    }[verb];
    const written = [a, b].find((value) => value.unit.kind === "number");
    const plain = [a, b].find((value) => value.unit.kind === "plain");
    const other = [a, b].find((value) => value !== written && value !== plain);
    let hint = "";
    if (written && other && (isAmount(other.unit) || other.unit.kind === "rate"))
      hint = `; give ${source(written.node)} as a cited input`;
    else if (plain && other && (other.unit.kind === "currency" || other.unit.kind === "other"))
      hint = `; give the unit of ${source(plain.node)} with unitQuote`;
    return refuse("units", `${sentence}${hint}.`);
  };

  const result = (node: Node, unit: Unit, n: number, from: Value[], scales: WrittenScale[]) => {
    if (!Number.isFinite(n)) refuse("number", `${source(node)} is too large for a number.`);
    return {
      n,
      unit,
      approximate: from.some((value) => value.approximate),
      scales: isAmount(unit) ? scales : [],
      node,
    };
  };

  const together = (name: FunctionName, values: Value[]): Unit => {
    const [first, ...rest] = values;
    if (!first) return NUMBER_UNIT;
    const yesNo = values.find((value) => value.unit.kind === "yes-no");
    if (yesNo) refuse("units", `${name} can't take ${describe(yesNo)}.`);
    const verb = name === "SUM" || name === "AVERAGE" ? "add" : "compare";
    let unit = first.unit;
    for (const value of rest)
      unit = joined({ ...first, unit }, value) ?? mismatch(verb, first, value);
    return unit;
  };

  const divide = (a: Value, b: Value, what = "the formula"): number => {
    if (b.n === 0) refuse("zero", `${source(b.node)} is 0, so ${what} divides by zero.`);
    return a.n / b.n;
  };

  const raise = (node: Node, a: Value, b: Value): Value => {
    if (!isCount(b.unit) && b.unit.kind !== "ratio")
      refuse("units", `${describe(b)} can't be a power; use a number with no unit.`);
    const unit = powerOf(a.unit) ?? refuse("units", `can't raise ${describe(a)} to a power.`);
    if (a.n === 0 && b.n === 0)
      refuse("number", `${source(node)} is 0 to the power 0, which has no value.`);
    if (a.n === 0 && b.n < 0)
      refuse(
        "zero",
        `${source(a.node)} is 0 and its power is negative, so the formula divides by zero.`,
      );
    if (a.n < 0 && !Number.isInteger(b.n))
      refuse(
        "number",
        `${source(a.node)} is negative, so it has no power ${source(b.node)}, which isn't a whole number.`,
      );
    return result(node, unit, a.n ** b.n, [a, b], a.scales);
  };

  /** Amounts divided by something other than a number written in the formula: rates per so many of it. */
  const perQuantity = new Set<Node>();
  /** An amount times powers of ten, by the node that ends the run: what they come to, and the amount. */
  const scaledBy = new Map<Node, { exponent: number; amount: Value }>();
  /**
   * Notes a power of ten that multiplies or divides an amount, adding it to
   * those before it ("rev / 100 / 100" is "rev / 10000"). One that makes a
   * rate per so many of something isn't a change of scale, and is left: a
   * rate times it (beds / people * 10000), a dividend times it that is then
   * divided by a quantity (rev * 1000 / users), or a quantity divided by it
   * that then divides (rev / (users / 1000)). See `divided`.
   */
  const noteScale = (node: Node, amount: Value, literal: Value, sign: 1 | -1) => {
    const power = powerOfTen(literal);
    if (!changes || !power || !isAmount(amount.unit)) return;
    if (sign === 1 && perQuantity.has(amount.node)) {
      perQuantity.add(node);
      return;
    }
    const before = scaledBy.get(amount.node);
    const exponent = (before?.exponent ?? 0) + sign * power;
    const base = before?.amount ?? amount;
    scaledBy.set(node, { exponent, amount: base });
    changes.delete(amount.node);
    const from = base.scales[0] ?? null;
    // Or one written Chinese scale onto another, two steps apart: "rev / 100" reads 百万 as 亿.
    const lands =
      from?.word != null &&
      /[\u4e00-\u9fff]/.test(from.word) &&
      CHINESE_SCALES.has(from.exponent - exponent);
    if (SCALE_STEPS.has(Math.abs(exponent)) || lands)
      changes.set(node, { text: source(node), amount: source(base.node), exponent, from });
  };
  /** A division by a quantity: what scaled its dividend or its divisor made a rate per so many. */
  const divided = (node: Node, a: Value, b: Value) => {
    if (b.unit.kind === "number") return;
    perQuantity.add(node);
    if (a.node.type === "binary" && a.node.op === "*") changes?.delete(a.node);
    changes?.delete(b.node);
  };

  const number = (value: Value, what: string): number => {
    if (!isCount(value.unit))
      refuse("units", `${what} (${source(value.node)}) must be a number with no unit.`);
    return value.n;
  };

  const run = (node: Node): Value => {
    switch (node.type) {
      case "number":
        return {
          n: node.value,
          unit: node.percent ? PERCENT : NUMBER_UNIT,
          approximate: false,
          scales: [],
          node,
        };
      case "boolean":
        return { n: node.value ? 1 : 0, unit: YES_NO, approximate: false, scales: [], node };
      case "name": {
        const input =
          inputs.get(node.name.toLowerCase()) ?? refuse("name", `${node.name} isn't an input.`);
        const scales = isAmount(input.unit)
          ? [
              {
                exponent: Math.round(Math.log10(input.scale)),
                word: input.scaleWord,
                decimals: input.decimals,
              },
            ]
          : [];
        return { n: input.value, unit: input.unit, approximate: input.approximate, scales, node };
      }
      case "plus":
        return { ...run(node.operand), node };
      case "negate": {
        const a = run(node.operand);
        if (a.unit.kind === "yes-no") refuse("units", `can't make ${describe(a)} negative.`);
        return { ...a, n: -a.n, node };
      }
      case "binary": {
        const a = run(node.left);
        const b = run(node.right);
        const scales = [...a.scales, ...b.scales];
        switch (node.op) {
          case "+":
            return result(node, joined(a, b) ?? mismatch("add", a, b), a.n + b.n, [a, b], scales);
          case "-":
            return result(
              node,
              difference(a, b) ?? mismatch("subtract", a, b),
              a.n - b.n,
              [a, b],
              scales,
            );
          case "*": {
            const unit = product(a.unit, b.unit) ?? mismatch("multiply", a, b);
            noteScale(node, a, b, 1);
            noteScale(node, b, a, 1);
            return result(node, unit, a.n * b.n, [a, b], productScales(a, b));
          }
          case "/": {
            const unit = quotient(a.unit, b.unit) ?? mismatch("divide", a, b);
            noteScale(node, a, b, -1);
            divided(node, a, b);
            return result(node, unit, divide(a, b), [a, b], a.scales);
          }
          case "^":
            return raise(node, a, b);
          default: {
            const bothYesNo = a.unit.kind === "yes-no" && b.unit.kind === "yes-no";
            const unit = bothYesNo ? YES_NO : joined(a, b);
            const pointsAndPercent =
              (a.unit.kind === "points" && b.unit.kind === "percent") ||
              (a.unit.kind === "percent" && b.unit.kind === "points");
            if (!unit || pointsAndPercent) mismatch("compare", a, b);
            const [x, y] = [excelDigits(a.n), excelDigits(b.n)];
            const holds = {
              "=": x === y,
              "<>": x !== y,
              "<": x < y,
              ">": x > y,
              "<=": x <= y,
              ">=": x >= y,
            }[node.op];
            return result(node, YES_NO, holds ? 1 : 0, [a, b], []);
          }
        }
      }
      case "call": {
        const args = node.args.map(run);
        // The parser checked how many values each function takes.
        const arg = (at: number) =>
          args[at] ?? refuse("function", `${node.name} is missing a value.`);
        const scales = args.flatMap((each) => each.scales);
        const numbers = args.map((each) => each.n);
        // Excel adds a SUM's values in order, one double at a time.
        const sum = () => numbers.reduce((total, n) => total + n, 0);
        switch (node.name) {
          case "SUM":
            return result(node, together(node.name, args), sum(), args, scales);
          case "AVERAGE":
            return result(node, together(node.name, args), sum() / args.length, args, scales);
          case "MIN":
            return result(node, together(node.name, args), Math.min(...numbers), args, scales);
          case "MAX":
            return result(node, together(node.name, args), Math.max(...numbers), args, scales);
        }
        const a = arg(0);
        switch (node.name) {
          case "ABS":
            if (a.unit.kind === "yes-no") refuse("units", `ABS can't take ${describe(a)}.`);
            return result(node, a.unit, Math.abs(a.n), [a], a.scales);
          case "ROUND":
            if (a.unit.kind === "yes-no") refuse("units", `ROUND can't take ${describe(a)}.`);
            return result(
              node,
              a.unit,
              excelRound(a.n, number(arg(1), "ROUND's decimals")),
              [a],
              a.scales,
            );
          case "SQRT": {
            const unit = powerOf(a.unit) ?? refuse("units", `SQRT can't take ${describe(a)}.`);
            if (a.n < 0)
              refuse("number", `${source(a.node)} is negative, so it has no square root.`);
            return result(node, unit, Math.sqrt(a.n), [a], a.scales);
          }
          case "RRI": {
            const [b, c] = [arg(1), arg(2)];
            const periods = number(a, "RRI's number of periods");
            if (!joined(b, c)) mismatch("compare", b, c);
            if (periods <= 0)
              refuse("number", `RRI's number of periods (${source(a.node)}) must be above 0.`);
            const growth = divide(c, b, "RRI");
            if (growth < 0)
              refuse(
                "number",
                `RRI's start (${source(b.node)}) and end (${source(c.node)}) must have the same sign.`,
              );
            return result(node, PERCENT, growth ** (1 / periods) - 1, [a, b, c], []);
          }
        }
      }
    }
  };
  return run(tree);
}

/** Names ignore case, as Excel's do. */
function inputsByName(inputs: readonly FormulaInput[]): Map<string, FormulaInput> {
  const byName = new Map<string, FormulaInput>();
  for (const input of inputs) {
    if (!NAME_ONLY.test(input.name))
      refuse(
        "input",
        `input ${quoted(input.name)} needs a name a formula can use: a letter first, then letters, digits or _.`,
      );
    const key = input.name.toLowerCase();
    if (key === "true" || key === "false")
      refuse("input", `input ${input.name} can't be called TRUE or FALSE; give it another name.`);
    if (byName.has(key))
      refuse("input", `two inputs are named ${input.name}; give each its own name.`);
    if (!Number.isFinite(input.value)) refuse("input", `input ${input.name} isn't a number.`);
    byName.set(key, input);
  }
  return byName;
}

/**
 * Works out `formula` over `inputs` by the rules of `version`. Never throws
 * for anything a formula or its inputs say: what can't be worked out comes
 * back as a problem in one line.
 */
export function evaluateFormula(
  formula: string,
  inputs: readonly FormulaInput[],
  version: number = FORMULA_VERSION,
): FormulaResult | FormulaProblem {
  try {
    if (version !== FORMULA_VERSION)
      refuse(
        "version",
        `this formula follows rules version ${version}, and this IncarnaMind has version ${FORMULA_VERSION}.`,
      );
    const byName = inputsByName(inputs);
    const tree = parse(formula);
    const names = inputs.map((input) => input.name).join(", ");
    const used = nodesIn(tree, (node) => node.type === "name");
    for (const node of used) {
      if (node.type !== "name" || byName.has(node.name.toLowerCase())) continue;
      refuse(
        "name",
        names
          ? `the formula uses ${node.name}, which isn't one of its inputs (${names}).`
          : `the formula uses ${node.name}, but it has no inputs; give each number as a cited input.`,
      );
    }
    if (used.length === 0)
      refuse(
        "name",
        names
          ? `the formula uses none of its inputs; write it over their names (${names}).`
          : "the formula has no inputs; give each number as a cited input.",
      );
    const value = evaluate(tree, formula, byName);
    const unit: ResultUnit = value.unit.kind === "number" ? { kind: "plain" } : value.unit;
    return {
      ok: true,
      version,
      value: unit.kind === "yes-no" ? value.n === 1 : value.n,
      unit,
      approximate: value.approximate,
      literals: nodesIn(tree, (node) => node.type === "number").flatMap((node) =>
        node.type === "number" ? [{ text: node.text, value: node.value, at: node.from }] : [],
      ),
      scales: value.scales,
    };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, kind: error.kind, message: error.message };
    throw error;
  }
}

/**
 * Where a formula moves an amount into another scale with a power of ten,
 * in the order it writes them (see `ScaleChange`); none for a formula that
 * can't be worked out. What it works out is unchanged: this is for the Tool
 * that takes formulas, to refuse them.
 */
export function scaleChanges(formula: string, inputs: readonly FormulaInput[]): ScaleChange[] {
  try {
    const changes = new Map<Node, ScaleChange>();
    evaluate(parse(formula), formula, inputsByName(inputs), changes);
    return [...changes.entries()].sort(([a], [b]) => a.from - b.from).map(([, change]) => change);
  } catch (error) {
    if (error instanceof Refusal) return [];
    throw error;
  }
}

/**
 * A formula that is only a sum of inputs, "price - fee - legal + refund": its
 * first term, and the terms it takes away. Null for any other formula.
 */
export function sumOf(formula: string): { total: string; taken: string[] } | null {
  const terms = (node: Node): { name: string; taken: boolean }[] | null => {
    if (node.type === "name") return [{ name: node.name, taken: false }];
    if (node.type !== "binary" || (node.op !== "+" && node.op !== "-")) return null;
    if (node.right.type !== "name") return null;
    const left = terms(node.left);
    return left && [...left, { name: node.right.name, taken: node.op === "-" }];
  };
  try {
    const found = terms(parse(formula));
    const [first] = found ?? [];
    if (!found || !first) return null;
    return {
      total: first.name,
      taken: found.filter((term) => term.taken).map((term) => term.name),
    };
  } catch (error) {
    if (error instanceof Refusal) return null;
    throw error;
  }
}

const READ_AS: ReadonlyMap<string, string> = new Map([
  ["*", "×"],
  ["/", "÷"],
  ["-", "−"],
]);

/**
 * A formula as a person reads it: each name `say` knows replaced by what it
 * gives (an input's label, or its number as written), and "*", "/" and "-"
 * written "×", "÷" and "−". A formula that can't be read comes back as it is.
 */
export function formulaText(formula: string, say: (name: string) => string | null): string {
  let tokens: Token[];
  try {
    tokens = lex(formula);
  } catch (error) {
    if (error instanceof Refusal) return formula;
    throw error;
  }
  if (tokens[0]?.kind === "operator" && tokens[0].text === "=") tokens = tokens.slice(1);
  let text = "";
  let previous: Token | null = null;
  let afterSign = false;
  for (const token of tokens) {
    const operator = token.kind === "operator" ? token.text : null;
    const sign =
      (operator === "-" || operator === "+") &&
      (previous === null || (previous.kind === "operator" && !/^[)%]$/.test(previous.text)));
    const tight =
      previous === null ||
      afterSign ||
      (previous.kind === "operator" && previous.text === "(") ||
      operator === ")" ||
      operator === "," ||
      operator === "%" ||
      (operator === "(" && previous.kind === "name");
    if (!tight) text += " ";
    text +=
      token.kind === "name"
        ? (say(token.text) ?? token.text)
        : (READ_AS.get(token.text) ?? token.text);
    afterSign = sign;
    previous = token;
  }
  return text;
}

function increment(digits: string): string {
  let at = digits.length - 1;
  while (at >= 0 && digits[at] === "9") at--;
  if (at < 0) return `1${"0".repeat(digits.length)}`;
  return `${digits.slice(0, at)}${Number(digits[at]) + 1}${"0".repeat(digits.length - at - 1)}`;
}

/**
 * |x| × 10^shift to `decimals` places (tens and hundreds when negative),
 * rounded half away from zero on the 15 significant digits Excel keeps of a
 * double. That is how Excel's ROUND and its number formats round: 2.675 is
 * 2.67499999999999982 as a double, and still rounds to 2.68. Shifting the
 * digits, rather than multiplying, keeps 0.0235 as 2.35 percent.
 */
function digitsOf(
  x: number,
  shift: number,
  decimals: number,
): { negative: boolean; whole: string; fraction: string } {
  const [mantissa = "0", exponent = "0"] = Math.abs(x).toExponential(14).split("e");
  const digits = mantissa.replace(".", "");
  const keep = Number(exponent) + 1 + shift + decimals;
  let kept = keep > 0 ? digits.slice(0, keep).padEnd(keep, "0") : "";
  if (keep >= 0 && (digits[keep] ?? "0") >= "5") kept = increment(kept);
  kept = kept.replace(/^0+/, "");
  const negative = x < 0 && kept !== "";
  if (decimals <= 0)
    return { negative, whole: kept === "" ? "0" : kept + "0".repeat(-decimals), fraction: "" };
  const padded = kept.padStart(decimals + 1, "0");
  return { negative, whole: padded.slice(0, -decimals), fraction: padded.slice(-decimals) };
}

/** Excel's ROUND: decimals cut to a whole number, then half away from zero. */
function excelRound(x: number, decimals: number): number {
  const places = Math.max(-330, Math.min(330, Math.trunc(decimals)));
  const { negative, whole, fraction } = digitsOf(x, 0, places);
  const rounded = Number(fraction ? `${whole}.${fraction}` : whole);
  return negative ? -rounded : rounded;
}

function written(x: number, shift: number, decimals: number): { sign: string; text: string } {
  const { negative, whole, fraction } = digitsOf(x, shift, decimals);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return { sign: negative ? "-" : "", text: fraction ? `${grouped}.${fraction}` : grouped };
}

const signed = (x: number, shift: number, decimals: number) => {
  const { sign, text } = written(x, shift, decimals);
  return sign + text;
};

/**
 * How each language writes an amount: its scales, largest first, and money
 * before the number (English) or after its scale (Chinese). These are number
 * formats, like Intl's, rather than sentences: Chinese counts in 万 and 亿
 * where English counts in thousands, so one can't be a translation of the
 * other. "$" is US dollars, as the figure reader reads a bare "$"; other
 * dollars carry their country's letters, so a shown result reads back as the
 * currency it is.
 */
const WRITING: {
  readonly [L in Language]: {
    scales: readonly (readonly [exponent: number, word: string])[];
    own: RegExp;
    currencyAfter: boolean;
    currency: ReadonlyMap<string, string>;
  };
} = {
  en: {
    scales: [
      [12, "trillion"],
      [9, "billion"],
      [6, "million"],
      [3, "thousand"],
    ],
    own: /^[A-Za-z]/,
    currencyAfter: false,
    currency: new Map([
      ["USD", "$"],
      ["EUR", "€"],
      ["GBP", "£"],
      ["CNY", "RMB "],
      ["JPY", "JPY "],
      ["HKD", "HK$"],
      ["AUD", "A$"],
      ["CAD", "C$"],
      ["NZD", "NZ$"],
      ["SGD", "S$"],
      ["TWD", "NT$"],
      ["INR", "₹"],
      ["KRW", "₩"],
    ]),
  },
  "zh-CN": {
    scales: [
      [12, "万亿"],
      [8, "亿"],
      [4, "万"],
    ],
    own: /\p{Script=Han}/u,
    currencyAfter: true,
    currency: new Map([
      ["CNY", "元"],
      ["USD", "美元"],
      ["HKD", "港元"],
      ["EUR", "欧元"],
      ["JPY", "日元"],
      ["GBP", "英镑"],
      ["AUD", "澳元"],
      ["CAD", "加元"],
      ["TWD", "新台币"],
      ["SGD", "新加坡元"],
      ["CHF", "瑞士法郎"],
      ["KRW", "韩元"],
      ["MOP", "澳门元"],
      ["RUB", "卢布"],
    ]),
  },
};

/** The scale words an amount can be shown in, in a language, smallest first: 万, 亿, 万亿. */
export function scaleWords(language: Language): string[] {
  return WRITING[language].scales.map(([, word]) => word).reverse();
}

/** The word a language writes a power of ten's scale with: 亿 for 8 in Chinese; null when it has none. */
export function scaleWordOf(exponent: number, language: Language): string | null {
  return WRITING[language].scales.find(([each]) => each === exponent)?.[1] ?? null;
}

const SHOWN_AS: { readonly [K in ResultUnit["kind"]]: readonly ShowAs[] } = {
  plain: ["number"],
  ratio: ["number", "percent", "times"],
  percent: ["percent"],
  points: ["points"],
  times: ["times", "number"],
  currency: ["currency"],
  other: ["number"],
  rate: ["number"],
  "yes-no": ["yes-no"],
};

const AS_PHRASE: ReadonlyMap<string, string> = new Map([
  ["number", "a number"],
  ["percent", "a percent"],
  ["points", "percentage points"],
  ["currency", "an amount of money"],
  ["times", "a multiple"],
  ["yes-no", "yes or no"],
]);

interface Scale {
  exponent: number;
  word: string | null;
  /** The decimals the scale was chosen to show the result in, when its inputs' written digits settle them. */
  decimals?: number;
}

const NO_SCALE: Scale = { exponent: 0, word: null };

/** "millions" is spelt "million"; an abbreviation ("bn", "m") and a Chinese word stay as written. */
const spelt = (word: string) =>
  /^[A-Za-z]{4,}$/.test(word) ? word.toLowerCase().replace(/s$/, "") : word;

/**
 * The scale an amount is shown in, from `scales`, the scales its inputs were written in. Inputs
 * written in the Answer's language keep their scale: the largest of them that shows the result
 * exactly in one decimal more than its inputs written in that scale have ("$2bn + $500m" is
 * $2.5bn, "$1.2bn + $350m" is $1.55bn), with that decimal shown only when it isn't a zero
 * ("$1.2bn + $300m" is $1.5bn), else the smallest, so no input's digits are lost ("$1.2bn + $383m"
 * is $1,583m, "2亿 + 5,120万" is 25,120万); one step smaller while the result is under 1 in it
 * ("0.3亿" is 3,000万). Inputs written in the other language give the largest of the Answer's own
 * scales the result fills ("$1.2bn" is 12亿美元). With `decimals` given, those are the decimals
 * the result is judged in.
 */
function scaleFor(
  value: number,
  scales: readonly WrittenScale[],
  language: Language,
  decimals: number | null = null,
): Scale {
  const { scales: steps, own } = WRITING[language];
  const size = Math.abs(excelDigits(value));
  let start: Scale | null = null;
  const byExponent = new Map<number, { scale: Scale; decimals: number }>();
  for (const each of scales) {
    const kept = each.word === null || each.exponent === 0 || own.test(each.word);
    if (!kept) continue;
    const scale =
      each.word && each.exponent > 0
        ? { exponent: each.exponent, word: spelt(each.word) }
        : NO_SCALE;
    if (!start || scale.exponent < start.exponent) start = scale;
    const same = byExponent.get(scale.exponent);
    byExponent.set(scale.exponent, {
      scale: same?.scale ?? scale,
      decimals: Math.max(same?.decimals ?? 0, each.decimals),
    });
  }
  if (start && start.exponent > 0) {
    const exactIn = (at: { scale: Scale }, places: number) =>
      size >= 10 ** at.scale.exponent &&
      excelDigits(roundedAt(value, at.scale.exponent, places)) === excelDigits(value);
    const first = start.exponent;
    const fits = [...byExponent.values()]
      .filter((at) => at.scale.exponent > first)
      .sort((a, b) => b.scale.exponent - a.scale.exponent)
      .find((at) => exactIn(at, decimals ?? at.decimals + 1));
    if (fits) {
      const places = decimals ?? (exactIn(fits, fits.decimals) ? fits.decimals : fits.decimals + 1);
      return { ...fits.scale, decimals: places };
    }
  }
  if (start && (start.exponent === 0 || size >= 10 ** start.exponent)) return start;
  const step = steps.find(
    ([exponent]) => size >= 10 ** exponent && (!start || exponent < start.exponent),
  );
  return step ? { exponent: step[0], word: step[1] } : NO_SCALE;
}

function roundedAt(x: number, exponent: number, decimals: number): number {
  const { negative, whole, fraction } = digitsOf(x, -exponent, decimals);
  const rounded = Number(`${whole}.${fraction || "0"}e${exponent}`);
  return negative ? -rounded : rounded;
}

const magnitude = (x: number) => Number(Math.abs(x).toExponential(14).split("e")[1]);

/**
 * An amount's decimals: as many as its inputs were written with, in the
 * scale it is shown in. Shown in a smaller scale than its inputs, their
 * decimals say nothing, so it keeps three significant digits: a share price
 * worked out from millions isn't "$1".
 */
function decimalsFor(value: number, scales: readonly WrittenScale[], scale: Scale): number {
  const derived =
    scales.length === 0
      ? 2
      : Math.max(...scales.map((each) => each.decimals + scale.exponent - each.exponent));
  if (derived >= 0) return Math.min(derived, 10);
  const threeDigits = (x: number) => Math.min(6, Math.max(0, 2 - magnitude(x) + scale.exponent));
  if (value === 0) return 0;
  const first = threeDigits(value);
  const rounded = roundedAt(value, scale.exponent, first);
  return rounded === 0 ? 0 : threeDigits(rounded);
}

function amount(
  value: number,
  unit: Unit,
  scales: readonly WrittenScale[],
  options: ShowOptions,
): string {
  const { language } = options;
  const writing = WRITING[language];
  let scale: Scale;
  if (options.scale) scale = { exponent: scaleExponent(options.scale), word: spelt(options.scale) };
  else {
    // 9,999.96万 rounds to 10,000万, which is 1.0亿.
    const asked = options.decimals ?? null;
    const first = scaleFor(value, scales, language, asked);
    const decimals = asked ?? first.decimals ?? decimalsFor(value, scales, first);
    scale = scaleFor(roundedAt(value, first.exponent, decimals), scales, language, asked);
  }
  const { sign, text } = written(
    value,
    -scale.exponent,
    options.decimals ?? scale.decimals ?? decimalsFor(value, scales, scale),
  );
  let shown = text;
  if (scale.word) shown += /^[A-Za-z]{4,}$/.test(scale.word) ? ` ${scale.word}` : scale.word;
  if (unit.kind === "currency") {
    const word = writing.currency.get(unit.code);
    if (word === undefined) return `${sign}${unit.code} ${shown}`;
    return writing.currencyAfter ? `${sign}${shown}${word}` : `${sign}${word}${shown}`;
  }
  if (unit.kind === "other")
    return `${sign}${shown}${/\p{Script=Han}/u.test(unit.word) ? "" : " "}${unit.word}`;
  return sign + shown;
}

/**
 * A result as the Answer writes it, in its language: "25.0%", "2.3
 * percentage points", "$251.6 million", "about 1.2 billion"; "2.3个百分点",
 * "3,045.74万元", "约1.2亿元". Percents and points to one decimal, ratios
 * and multiples to two, amounts as their inputs were written.
 */
export function showResult(
  result: FormulaResult,
  options: ShowOptions,
): { ok: true; shown: string } | FormulaProblem {
  const problem = (kind: FormulaProblemKind, message: string): FormulaProblem => ({
    ok: false,
    kind,
    message,
  });
  if (result.version !== FORMULA_VERSION)
    return problem(
      "version",
      `this result follows rules version ${result.version}, and this IncarnaMind has version ${FORMULA_VERSION}.`,
    );
  const { unit, value, approximate } = result;
  const { language, decimals } = options;
  const allowed = SHOWN_AS[unit.kind];
  const as = options.as ?? allowed[0] ?? "number";
  if (!allowed.includes(as)) {
    const hint =
      unit.kind === "points" ? "; a difference of two percents is in percentage points" : "";
    return problem(
      "show",
      `${phrase(unit)} can't be shown as ${AS_PHRASE.get(as) ?? quoted(as)}${hint}.`,
    );
  }
  if (decimals != null && !(Number.isInteger(decimals) && decimals >= 0 && decimals <= 10))
    return problem("show", "decimals must be a whole number from 0 to 10.");
  if (options.scale != null) {
    if (!isAmount(unit) || as !== SHOWN_AS[unit.kind][0])
      return problem("show", `${phrase(unit)} isn't shown in a scale; leave scale out.`);
    if (scaleExponent(options.scale) <= 0 || !WRITING[language].own.test(options.scale))
      return problem("show", `scale must be one of ${scaleWords(language).join(", ")}.`);
  }

  let shown: string;
  if (typeof value === "boolean") shown = translate(language, value ? "figure.yes" : "figure.no");
  else if (as === "percent") shown = `${signed(value, 2, decimals ?? 1)}%`;
  else if (as === "points")
    shown = translate(language, "figure.points", { value: signed(value, 2, decimals ?? 1) });
  else if (as === "times")
    shown = translate(language, "figure.times", { value: signed(value, 0, decimals ?? 2) });
  else if (unit.kind === "rate")
    shown = translate(language, "figure.rate", {
      per: unit.per,
      of: unit.of,
      value: signed(value, 0, decimals ?? 4),
    });
  else if (unit.kind === "ratio" || unit.kind === "times") shown = signed(value, 0, decimals ?? 2);
  else shown = amount(value, unit, result.scales, options);
  if (approximate && typeof value !== "boolean")
    shown = translate(language, "figure.about", { value: shown });
  return { ok: true, shown };
}

/**
 * A shown figure's number alone: an approximate result is wrapped in
 * "figure.about" ("about 1.31x", "约1.31倍"), and a sentence that already
 * says so keeps its own word when its number is replaced (#1247).
 */
export function figureNumber(shown: string, language: Language): string {
  const [before = "", after = ""] = translate(language, "figure.about", {
    value: "\u0000",
  }).split("\u0000");
  return shown.length > before.length + after.length &&
    shown.startsWith(before) &&
    shown.endsWith(after)
    ? shown.slice(before.length, shown.length - after.length)
    : shown;
}
