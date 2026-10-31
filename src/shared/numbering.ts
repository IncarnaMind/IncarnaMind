/**
 * Numbered lists' schemes (#1419; DESIGN.md › Mind column › Lists › Numbering styles), one format a
 * level, as Word's List Library has them: "1. a. i." (the default), Outline "1. 1.1. 1.1.1.",
 * Clauses "(a) (i) (A)" and Chinese report "一、 （一） 1. （1）". Deeper levels repeat a scheme's
 * last format; Outline adds a number instead. Each level is written as Word writes it, a number
 * format and the text around it, so the editor's markers, the Word export's numbering, and the
 * Word import and paste that recognise a scheme all read the one table.
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
 * Tab and Shift-Tab, the exports and the imports.
 */
export const itemLevel = (depth: number, startLevel: number) =>
  Math.min(DEEPEST_LEVEL, Math.max(0, depth) + Math.max(0, startLevel));

export type WordNumberFormat =
  | "decimal"
  | "lowerLetter"
  | "lowerRoman"
  | "upperLetter"
  | "chineseCounting";

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

const fromRoman = (text: string) => {
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  for (let at = 0; at < text.length; at++) {
    const value = values[text[at] ?? ""] ?? 0;
    const next = values[text[at + 1] ?? ""] ?? 0;
    total += value < next ? -value : value;
  }
  return total;
};
const fromLetters = (text: string) =>
  [...text.toLowerCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 96, 0);
const fromChinese = (text: string) => {
  if (text === "十") return 10;
  const [tens = "", ones = ""] = text.includes("十") ? text.split("十") : ["", text];
  const digit = (each: string) => CHINESE_DIGITS.indexOf(each);
  const ten = text.includes("十") ? (tens === "" ? 1 : digit(tens)) : 0;
  const one = ones === "" ? 0 : digit(ones);
  return ten < 0 || one < 0 ? 0 : ten * 10 + one;
};

/** How each format writes a number, the pattern its written numbers match, and how to read one back. */
const COUNTING: Record<
  WordNumberFormat,
  { write(n: number): string; pattern: string; read(text: string): number }
> = {
  decimal: { write: String, pattern: "\\d{1,4}", read: Number },
  lowerLetter: { write: letters, pattern: "[a-z]{1,3}", read: fromLetters },
  lowerRoman: { write: roman, pattern: "[ivxlcdm]{1,8}", read: fromRoman },
  upperLetter: {
    write: (n) => letters(n).toUpperCase(),
    pattern: "[A-Z]{1,3}",
    read: fromLetters,
  },
  chineseCounting: { write: chinese, pattern: "[一二三四五六七八九十]{1,3}", read: fromChinese },
};

/** Its text has "%" where the number goes. */
interface LevelFormat {
  format: WordNumberFormat;
  text: string;
}

const LEVELS: Record<Exclude<NumberingScheme, "outline">, readonly LevelFormat[]> = {
  default: [
    { format: "decimal", text: "%." },
    { format: "lowerLetter", text: "%." },
    { format: "lowerRoman", text: "%." },
  ],
  clauses: [
    { format: "lowerLetter", text: "(%)" },
    { format: "lowerRoman", text: "(%)" },
    { format: "upperLetter", text: "(%)" },
  ],
  chinese: [
    { format: "chineseCounting", text: "%、" },
    { format: "chineseCounting", text: "（%）" },
    { format: "decimal", text: "%." },
    { format: "decimal", text: "（%）" },
  ],
};

const levelFormat = (scheme: Exclude<NumberingScheme, "outline">, level: number) => {
  const levels = LEVELS[scheme];
  return levels[Math.min(level, levels.length - 1)] ?? { format: "decimal", text: "%." };
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
  const { format, text } = levelFormat(scheme, level);
  return text.replace("%", COUNTING[format].write(own));
}

/**
 * A level of a scheme as Word's numbering writes it (`w:numFmt`, `w:lvlText`) at Word level `at`
 * (from 0; `level` unless the list starts its numbering deeper, under a bullet): "%1.", "(%2)",
 * "%1.%2.%3.". Word's "%n" is the number of its level n (from 1), so a level written deeper
 * than it is numbers itself from that level (ECMA-376 17.9.11).
 */
export function wordLevel(
  scheme: NumberingScheme,
  level: number,
  at = level,
): { format: WordNumberFormat; text: string } {
  if (scheme === "outline") {
    const parts = Array.from({ length: level + 1 }, (_, each) => `%${at - level + each + 1}`);
    return { format: "decimal", text: `${parts.join(".")}.` };
  }
  const { format, text } = levelFormat(scheme, level);
  return { format, text: text.replace("%", `%${at + 1}`) };
}

// Word writes the Chinese counting format under another name too. Its traditional ideographs
// (壹, 貳) are another counting, which the scheme doesn't draw.
const SAME_FORMAT: Readonly<Record<string, WordNumberFormat>> = {
  chineseCountingThousand: "chineseCounting",
};
const sameText = (text: string) => text.replace(/\(/g, "（").replace(/\)/g, "）");

/**
 * The scheme a Word list is written in, and the level of it the list starts at, from its levels'
 * number formats and texts (`levels`, by level from 0), or null: a list numbered any other way.
 * The levels its definition's items use (`used`, the lists nested in it among them) must all
 * match, counted from the first level its own items use (`own`); Outline's levels must carry their
 * parents' numbers. A list that starts its numbering a level in, under a bullet, draws the scheme's
 * first format at that level and every level above it (#1419).
 */
export function schemeOfWordLevels(
  levels: ReadonlyMap<number, { format: string; text: string }>,
  used: readonly number[],
  own: readonly number[] = used,
): { scheme: NumberingScheme; startLevel: number } | null {
  const depth = Math.min(...own);
  const matches = (scheme: NumberingScheme, level: number, at: number) => {
    const written = levels.get(at);
    if (!written) return false;
    const wanted = wordLevel(scheme, level, at);
    const format = SAME_FORMAT[written.format] ?? written.format;
    const lenient = scheme === "chinese" ? sameText : (text: string) => text;
    return format === wanted.format && lenient(written.text.trim()) === lenient(wanted.text);
  };
  const fits = (scheme: NumberingScheme, startLevel: number) =>
    used.every(
      (level) =>
        level - depth + startLevel >= 0 && matches(scheme, level - depth + startLevel, level),
    );
  // The levels above tell the readings apart where the list's own don't: a decimal "%3." is
  // Chinese report's third level, and also the first format of a list under two bullets.
  const above = (scheme: NumberingScheme, startLevel: number) =>
    Array.from({ length: depth }, (_, at) => at).every((at) =>
      matches(scheme, Math.max(at - depth + startLevel, 0), at),
    );
  const startLevels = [depth, ...Array.from({ length: depth + 1 }, (_, at) => at)];
  for (const whole of [true, false]) {
    // A scheme read at its own levels first, as most lists are written; else from its first level.
    for (const startLevel of startLevels) {
      const scheme = NUMBERING_SCHEMES.find(
        (each) => fits(each, startLevel) && (!whole || above(each, startLevel)),
      );
      if (scheme) return { scheme, startLevel };
    }
  }
  return null;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The number `marker` gives an item at `level` of `scheme`, or null when the scheme writes it otherwise. */
export function markerNumber(
  scheme: NumberingScheme,
  level: number,
  marker: string,
): number | null {
  if (scheme === "outline") {
    const found = new RegExp(`^(?:\\d{1,4}\\.){${level}}(\\d{1,4})\\.$`).exec(marker);
    return found ? Number(found[1]) : null;
  }
  const { format, text } = levelFormat(scheme, level);
  const [before = "", after = ""] = text.split("%");
  const counting = COUNTING[format];
  const lenient = scheme === "chinese" ? sameText : (each: string) => each;
  const found = new RegExp(
    `^${escaped(lenient(before))}(${counting.pattern})${escaped(lenient(after))}$`,
  ).exec(lenient(marker));
  const number = found ? counting.read(found[1] ?? "") : 0;
  return number > 0 ? number : null;
}

/**
 * The one scheme every marker of a list is written in, each at its level ("(a)" at the first,
 * "(i)" at the second), each number one more than the one before it at its level, or null: a list
 * whose markers no scheme writes stays typed text. Counting on is what tells "(i) (ii) (iii)" from
 * letters, which would read them as 9, 243 and 6,327.
 */
export function schemeOfMarkers(
  markers: readonly { marker: string; level: number }[],
): NumberingScheme | null {
  const countsOn = (scheme: NumberingScheme) => {
    const last: number[] = [];
    return markers.every(({ marker, level }) => {
      const number = markerNumber(scheme, level, marker);
      const before = last[level];
      last.length = level;
      if (number === null) return false;
      last[level] = number;
      return before === undefined || number === before + 1;
    });
  };
  return NUMBERING_SCHEMES.find(countsOn) ?? null;
}
