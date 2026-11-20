/**
 * A figure worked out by the plain calculator (#3393): the model gives each input as a plain
 * number with the quote it comes from, an expression over them and the label that says what the
 * figure is; it is told the result, and writes the figure in its own text. Code reads no unit or
 * scale: it confirms by their digits alone that each number stands in its quote and that what the
 * text writes for the figure carries the result, and does the arithmetic. One place for an Answer,
 * a check and a connected agent.
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
  const named = written?.trim();
  const candidates =
    named && quote.includes(named)
      ? writtenNumbers(named).map((each) => ({
          ...each,
          start: quote.indexOf(named) + each.start,
        }))
      : numbers;
  const found = candidates.find((each) => each.digits === digits);
  if (found) return { chars: found.chars, start: found.start, inCharacters: false };
  if (numbers.length > 0) return null;
  const characters = CHARACTER_NUMERAL.exec(quote);
  return characters ? { chars: characters[0], start: characters.index, inCharacters: true } : null;
}

/** Whether `result` rounded to the digits `shown` writes is those digits: "£66,560", "17.0%". */
export function shownCarries(shown: string, result: number): boolean {
  const [only, ...more] = writtenNumbers(shown);
  if (!only || more.length > 0) return false;
  if (only.digits === "0") return Math.abs(result) < 1e-9;
  const size = Math.abs(result);
  if (size === 0) return false;
  const places = only.digits.length;
  const exponent = Math.floor(Math.log10(size));
  // Rounding can carry into a new place: 9.96 shown as "10.0"; 8.5 is never "1".
  const carries = Math.round(size / 10 ** (exponent - places + 1)) >= 10 ** places;
  return [exponent, ...(carries ? [exponent + 1] : [])].some((top) => {
    const scaled = size / 10 ** (top - places + 1);
    return Math.abs(scaled - Number(only.digits)) <= 0.5 + 1e-9 * scaled;
  });
}

/** A plain number with its thousands grouped: 364800000 as "364,800,000", 1.42 as "1.42". */
export function plainNumber(value: number): string {
  const text = String(Number(value.toPrecision(12)));
  if (/e/i.test(text)) return text;
  const [whole = "", fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * A result as the model is told it: a number written plainly, its whole part in full and six
 * significant digits at least ("0.204387", "66,560.4"), or "true" or "false".
 */
export function resultText(value: number | boolean): string {
  if (typeof value !== "number") return String(value);
  const whole = Math.abs(Math.trunc(value)).toString().length;
  return plainNumber(Number(value.toPrecision(Math.min(Math.max(6, whole + 2), 15))));
}

export interface PlainInput {
  name: string;
  value: number;
  /** The quote the number comes from. */
  quote: string;
  /** The number as the quote writes it, when the model named it. */
  written?: string | null;
}

export interface PlainWorked {
  value: number | boolean;
  /** Where each input's number stands in its quote, in order. */
  located: Located[];
  literals: FormulaLiteral[];
  /** The formula over the values used, with `shown` (the result unless given): "512,000 × 0.13 = 66,560". */
  working: string;
}

/**
 * Works a figure out: each input's number confirmed in its quote and the expression evaluated over
 * the values. The problems, in words for the model, when any of it fails. `shown`, when the figure
 * is written already (a connected agent's working), must carry the result.
 */
export function workPlain(figure: {
  inputs: readonly PlainInput[];
  formula: string;
  shown?: string;
}): PlainWorked | { problems: string[] } {
  const problems: string[] = [];
  const located = figure.inputs.flatMap((input) => {
    const found = locate(input.value, input.quote, input.written);
    if (found) return [found];
    const has = writtenNumbers(input.quote).map((each) => each.chars);
    problems.push(
      `${input.name}: ${plainNumber(input.value)} isn't in its quote${has.length > 0 ? `, which has ${has.join(", ")}` : ""}: give the number the quote writes, as a plain number, moved by a power of ten only where you mean another scale or unit`,
    );
    return [];
  });
  if (problems.length > 0) return { problems };
  const result = evaluateArithmetic(
    figure.formula,
    figure.inputs.map(({ name, value }) => ({ name, value })),
  );
  if (!result.ok) return { problems: [result.message] };
  const { shown } = figure;
  if (shown !== undefined && typeof result.value === "number" && !shownCarries(shown, result.value))
    return {
      problems: [
        `the formula gives ${plainNumber(result.value)}, and "${shown}" doesn't write those digits: write the figure with the result's digits as you round them, its unit and scale, and one number in it`,
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
    working: `${used} = ${shown ?? resultText(result.value)}${moved.length > 0 ? ` · ${moved.join(", ")}` : ""}`,
  };
}
