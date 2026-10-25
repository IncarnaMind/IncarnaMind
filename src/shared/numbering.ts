/**
 * Numbered lists' schemes (#1419; DESIGN.md › Mind column › Lists › Numbering styles), one format a
 * level, as Word's List Library has them: "1. a. i." (the default), Outline "1. 1.1. 1.1.1.",
 * Clauses "(a) (i) (A)" and Chinese report "一、 （一） 1. （1）". Deeper levels repeat a scheme's
 * last format; Outline adds a number instead. Shared by the editor, which draws the markers, and
 * the exports, which write them.
 */

export const NUMBERING_SCHEMES = ["default", "outline", "clauses", "chinese"] as const;
export type NumberingScheme = (typeof NUMBERING_SCHEMES)[number];

/** The deepest level a marker is drawn for, from 0: Word's nine. */
export const DEEPEST_LEVEL = 8;

export const isNumberingScheme = (value: unknown): value is NumberingScheme =>
  typeof value === "string" && (NUMBERING_SCHEMES as readonly string[]).includes(value);

/**
 * The level of a list's items, from 0: how deep the list is nested, plus the level its outermost
 * list starts at (`startLevel`, for a list begun with "(i)" or "（一）"). The one rule for drawing,
 * Tab and Shift-Tab, and the exports.
 */
export const itemLevel = (depth: number, startLevel: number) =>
  Math.min(DEEPEST_LEVEL, Math.max(0, depth) + Math.max(0, startLevel));

// A list's `start` comes from a pasted or stored file, so it can be any number: each conversion
// stays bounded and draws a number it can't write in the scheme as that number (#1419).
const letters = (n: number) => {
  if (!Number.isInteger(n) || n < 1) return String(n);
  let text = "";
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    text = String.fromCharCode(97 + ((rest - 1) % 26)) + text;
  }
  return text;
};

/** Past this, Roman numerals are drawn as their number, which also bounds the subtraction. */
const ROMAN_LIMIT = 3999;

const ROMAN: readonly [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];
const roman = (n: number) => {
  if (!Number.isInteger(n) || n < 1 || n > ROMAN_LIMIT) return String(n);
  let text = "";
  let rest = n;
  for (const [value, digits] of ROMAN) {
    while (rest >= value) {
      text += digits;
      rest -= value;
    }
  }
  return text;
};

const CHINESE_DIGITS = "零一二三四五六七八九";
const chinese = (n: number): string => {
  if (n < 10) return CHINESE_DIGITS[n] ?? String(n);
  if (n < 20) return `十${n % 10 ? CHINESE_DIGITS[n % 10] : ""}`;
  if (n < 100) {
    return `${CHINESE_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CHINESE_DIGITS[n % 10] : ""}`;
  }
  return String(n);
};

type Format = (n: number) => string;
const FORMATS: Record<Exclude<NumberingScheme, "outline">, readonly Format[]> = {
  default: [(n) => `${n}.`, (n) => `${letters(n)}.`, (n) => `${roman(n)}.`],
  clauses: [
    (n) => `(${letters(n)})`,
    (n) => `(${roman(n)})`,
    (n) => `(${letters(n).toUpperCase()})`,
  ],
  chinese: [
    (n) => `${chinese(n)}、`,
    (n) => `（${chinese(n)}）`,
    (n) => `${n}.`,
    (n) => `（${n}）`,
  ],
};

/**
 * The marker of an item at `level` (from 0), its list's numbers so far a level each (`numbers`, the
 * item's own last): "3.", "b.", "1.2.", "(ii)", "（一）".
 */
export function numberingMarker(
  scheme: NumberingScheme,
  level: number,
  numbers: readonly number[],
): string {
  const own = numbers[level] ?? 1;
  if (scheme === "outline") {
    return `${numbers
      .slice(0, level + 1)
      .map((n) => n || 1)
      .join(".")}.`;
  }
  const formats = FORMATS[scheme];
  const format = formats[Math.min(level, formats.length - 1)] ?? formats[0];
  return format ? format(own) : `${own}.`;
}
