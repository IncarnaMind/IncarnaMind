/**
 * A figure worked out by the plain calculator (#3393): the model gives each input as a plain
 * number with the quote it comes from, an expression over them, the label that says what the
 * figure is and the text it is shown as. Code reads no unit or scale: it confirms by their digits
 * alone that each number stands in its quote and that the shown text carries the result, and does
 * the arithmetic. One place for an Answer, a check and a connected agent.
 */
import { evaluateArithmetic, type FormulaLiteral, formulaText } from "./formula";

/** A number as a text writes it: its digits, with the separators between them. */
export interface WrittenNumber {
  chars: string;
  start: number;
  /** Its digits, with the zeros that lead or end them taken off: "4,560" is "456". */
  digits: string;
}

// Digits with the separators a number is written with between them: "1,286", "4.82", "1 234,5".
const NUMBER = /[0-9０-９]+(?:[.,'’  ][0-9０-９]+)*/g;
// Chinese numerals written as characters, which no digit stands for ("三成", "两千").
const CHARACTER_NUMERAL = /[〇零一二两三四五六七八九十百千万亿]+/u;

const asciiDigits = (text: string) =>
  text.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));

const significant = (digits: string) => digits.replace(/^0+/, "").replace(/0+$/, "") || "0";

export function writtenNumbers(text: string): WrittenNumber[] {
  return [...text.matchAll(NUMBER)].map((found) => ({
    chars: found[0],
    start: found.index,
    digits: significant(asciiDigits(found[0]).replace(/\D/g, "")),
  }));
}

/** A value's significant digits, to twelve: 0.0096 and 9,600 are both "96". */
export function digitsOf(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return "0";
  const [mantissa = "0"] = Math.abs(value).toExponential(11).split("e");
  return significant(mantissa.replace(".", ""));
}

/** Where an input's number stands in its quote, as written; `inCharacters` when no digit writes it. */
export interface Located {
  chars: string;
  start: number;
  inCharacters: boolean;
}

/** A written number read with "." as its decimal mark: "1,231.0" is 1231. */
export const writtenValue = (chars: string): number =>
  Number(asciiDigits(chars).replace(/[,'’\u00a0\u202f]/g, ""));

/**
 * Where `value` stands in `quote`: a number the quote writes whose digits are the value's, times a
 * power of ten ("4,560万元" stands for 45,600,000 and 4,560); `written`, when given, names which.
 * A quote that writes its number only in characters ("三成") can't be read by digits: the value is
 * taken as given, with the quote shown beside it. Null when it doesn't stand there.
 */
export function locate(value: number, quote: string, written?: string | null): Located | null {
  const digits = digitsOf(value);
  const numbers = writtenNumbers(quote);
  // `written` only chooses among the quote's whole numbers: "12" never stands for 12 in "12,345".
  const named = new Set(writtenNumbers(written?.trim() ?? "").map((each) => each.chars));
  const chosen = numbers.filter((each) => named.has(each.chars));
  const candidates = chosen.length > 0 ? chosen : numbers;
  const found = candidates.find((each) => each.digits === digits);
  if (found) return { chars: found.chars, start: found.start, inCharacters: false };
  if (numbers.length > 0) return null;
  const characters = CHARACTER_NUMERAL.exec(quote);
  return characters ? { chars: characters[0], start: characters.index, inCharacters: true } : null;
}

/**
 * Whether `result` rounded to the digits `shown` writes is those digits: "£66,560", "17.0%". Zeros
 * after a decimal point are digits shown ("20.0%" is not 0.204); a whole number's last zeros may
 * be its scale ("$70,000" for 70,412).
 */
export function shownCarries(shown: string, result: number): boolean {
  const [only, ...more] = writtenNumbers(shown);
  if (!only || more.length > 0) return false;
  const written = asciiDigits(only.chars);
  const fraction = /\.\d+$/.test(written.replace(/[,'’\u00a0\u202f]/g, ""));
  const all = written.replace(/\D/g, "").replace(/^0+/, "");
  const digits = fraction ? all : all.replace(/0+$/, "");
  const size = Math.abs(result);
  if (digits === "") return size < 1e-9;
  if (size === 0) return false;
  const places = digits.length;
  const exponent = Math.floor(Math.log10(size));
  const near = (scaled: number, target: number) => Math.abs(scaled - target) <= 0.5 + 1e-9 * scaled;
  if (near(size / 10 ** (exponent - places + 1), Number(digits))) return true;
  // Rounding can carry into a new place: 9.96 shown as "10.0", 999.6 as "1,000"; 8.5 is never "1".
  const kept = fraction ? places - 1 : places;
  const carried = 10 ** kept;
  return (
    written.replace(/\D/g, "").endsWith("0") &&
    Number(digits) === (fraction ? carried : 1) &&
    near(size / 10 ** (exponent - kept + 1), carried)
  );
}

/** Whether a comparison's shown text says its result: "yes" for true, "no" for false. */
function saysResult(shown: string, result: boolean): boolean {
  const said = shown
    .trim()
    .replace(/[.。!！]+$/u, "")
    .toLowerCase();
  return (result ? ["yes", "true", "是", "对"] : ["no", "false", "否", "不是"]).includes(said);
}

/** A plain number with its thousands grouped: 364800000 as "364,800,000", 1.42 as "1.42". */
export function plainNumber(value: number): string {
  const text = String(Number(value.toPrecision(12)));
  if (/e/i.test(text)) return text;
  const [whole = "", fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export interface PlainInput {
  name: string;
  value: number;
  /** The quote the number comes from. */
  quote: string;
  /** The number as the quote writes it, when the model named it. */
  written?: string | null;
}

/** What the model is told of an input value whose digits its quote doesn't write. */
export function notInQuote(value: number, quote: string): string {
  const has = writtenNumbers(quote).map((each) => each.chars);
  return `${plainNumber(value)} isn't in its quote${has.length > 0 ? `, which has ${has.join(", ")}` : ""}: give the number the quote writes, as a plain number, moved by a power of ten only where you mean another scale or unit`;
}

export interface PlainWorked {
  value: number | boolean;
  /** Where each input's number stands in its quote, in order. */
  located: Located[];
  literals: FormulaLiteral[];
  /** The formula over the values used, and the result as shown: "512,000 × (1.42 − 1.29) = £66,560". */
  working: string;
}

/**
 * Works a figure out: each input's number confirmed in its quote, the expression evaluated over the
 * values, and the shown text confirmed to carry the result. The problems, in words for the model,
 * when any of it fails.
 */
export function workPlain(figure: {
  inputs: readonly PlainInput[];
  formula: string;
  shown: string;
}): PlainWorked | { problems: string[] } {
  const problems: string[] = [];
  const located = figure.inputs.flatMap((input) => {
    const found = locate(input.value, input.quote, input.written);
    if (found) return [found];
    problems.push(`${input.name}: ${notInQuote(input.value, input.quote)}`);
    return [];
  });
  if (problems.length > 0) return { problems };
  const result = evaluateArithmetic(
    figure.formula,
    figure.inputs.map(({ name, value }) => ({ name, value })),
  );
  if (!result.ok) return { problems: [result.message] };
  if (typeof result.value === "boolean" && !saysResult(figure.shown, result.value))
    return {
      problems: [
        `the formula gives ${result.value ? "yes" : "no"}, and shown "${figure.shown}" doesn't say so: write yes or no, as the result is`,
      ],
    };
  if (typeof result.value === "number" && !shownCarries(figure.shown, result.value))
    return {
      problems: [
        `the formula gives ${plainNumber(result.value)}, and shown "${figure.shown}" doesn't write those digits: write the figure as the Answer shows it, its digits the result's as you round it, with its unit and scale, and one number in it`,
      ],
    };
  const byName = new Map(figure.inputs.map((input) => [input.name.toLowerCase(), input]));
  const used = formulaText(figure.formula, (name) => {
    const input = byName.get(name.toLowerCase());
    return input ? plainNumber(input.value) : null;
  });
  const moved = figure.inputs.flatMap((input, at) => {
    const place = located[at];
    if (!place) return [];
    return place.inCharacters || writtenValue(place.chars) !== input.value
      ? [`${place.chars} → ${plainNumber(input.value)}`]
      : [];
  });
  return {
    value: result.value,
    located,
    literals: result.literals,
    working: `${used} = ${figure.shown}${moved.length > 0 ? ` · ${moved.join(", ")}` : ""}`,
  };
}

type WorkingToken =
  | { kind: "number"; chars: string; value: number }
  | { kind: "sign"; text: string };

// A number as `writtenNumbers` reads one, or a sign of arithmetic as a line of working writes it.
const WORKING_TOKEN = /([0-9０-９]+(?:[.,'’\u00a0\u202f][0-9０-９]+)*)|([-+*/×÷−–()（）])/g;
const SIGNS: Readonly<Record<string, string>> = {
  "×": "*",
  "÷": "/",
  "−": "-",
  "–": "-",
  "（": "(",
  "）": ")",
};
const YEAR = /^(?:19|20)\d{2}$/;

/** The numbers and signs a line of working writes before its "=", a year beside a number left out. */
function workingTokens(text: string): WorkingToken[] {
  const read: WorkingToken[] = [...text.matchAll(WORKING_TOKEN)].map((found) =>
    found[1] !== undefined
      ? { kind: "number", chars: found[1], value: writtenValue(found[1]) }
      : { kind: "sign", text: SIGNS[found[2] ?? ""] ?? found[2] ?? "" },
  );
  // "2025 revenue 48,250 − 2024 revenue 44,100": a year names a figure, it isn't one.
  return read.filter((token, at) => {
    if (token.kind !== "number" || !YEAR.test(token.chars)) return true;
    return read[at + 1]?.kind !== "number" && read[at - 1]?.kind !== "number";
  });
}

const powerOfTen = (value: number) =>
  value > 0 && Math.abs(10 ** Math.round(Math.log10(value)) - value) <= 1e-9 * value;

/**
 * Whether a line of working adds up (#3393): the arithmetic it writes before its "=" over numbers
 * that each stand in one of `quotes` by their digits (or are a power of ten, a change of scale),
 * and the number right after the "=" carrying its result. Null for a line that writes no
 * arithmetic, such as a step of plain logic.
 */
export function workingAddsUp(line: string, quotes: readonly string[]): boolean | null {
  const equals = line.search(/[=＝]/);
  if (equals < 0) return null;
  const tokens = workingTokens(line.slice(0, equals));
  const sign = (token: WorkingToken | undefined) =>
    token?.kind === "sign" && /^[-+*/]$/.test(token.text);
  if (!tokens.some((token, at) => sign(token) && tokens[at + 1] !== undefined)) return null;
  const [result] = writtenNumbers(line.slice(equals + 1));
  if (!result) return false;
  // The arithmetic is the longest end of what comes before "=" that reads as a formula.
  for (let from = 0; from < tokens.length; from++) {
    const part = tokens.slice(from);
    const numbers = part.filter((token) => token.kind === "number");
    let at = 0;
    const formula = part
      .map((token) => (token.kind === "number" ? `n${at++}` : token.text))
      .join(" ");
    const worked = evaluateArithmetic(
      formula,
      numbers.map((token, index) => ({ name: `n${index}`, value: token.value })),
    );
    if (!worked.ok || typeof worked.value !== "number" || !part.some(sign)) continue;
    const quoted = numbers.every(
      (token) =>
        powerOfTen(token.value) ||
        quotes.some((quote) => locate(token.value, quote)?.inCharacters === false),
    );
    return quoted && shownCarries(result.chars, worked.value);
  }
  return false;
}
