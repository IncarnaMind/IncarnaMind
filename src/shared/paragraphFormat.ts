/**
 * The formatting the User gives paragraphs and text, as a Mind stores it (`ParagraphFormat`,
 * `TEXT_COLOR_MARK`, `TEXT_FONT_MARK`, `TEXT_SIZE_MARK`), and as CSS. What is read is checked
 * value by value, since another device wrote it and the editor turns it into CSS.
 */
import type { ParagraphFormat, WordParagraphLook } from "../core/api";
import { isRecord } from "../core/errors";
import { isFontFamily, SINGLE_LINE } from "./mindStyle";

const ALIGNS = ["left", "center", "right", "justify", "distribute"] as const;
const RULES = ["auto", "exact", "atLeast"] as const;
const HEX = /^[0-9A-F]{6}$/i;

const oneOf = <T extends string>(value: unknown, values: readonly T[]): T | undefined =>
  values.find((each) => each === value);

// Word's own limits: lengths up to 22 inches, a line spacing of 0.06 to 132 lines.
const within = (low: number, high: number) => (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high
    ? value
    : undefined;
const indent = within(-1584, 1584);
const space = within(0, 1584);
const characters = within(-100, 100);
const lines = within(0.06, 132);
const height = within(0.5, 1584);
const fontSize = within(1, 1638);

function readLine(value: unknown): WordParagraphLook["line"] | undefined {
  if (!isRecord(value)) return undefined;
  const rule = oneOf(value.rule, RULES);
  const amount = rule === "auto" ? lines(value.value) : height(value.value);
  return rule && amount !== undefined ? { rule, value: amount } : undefined;
}

/** A paragraph's format as stored; anything malformed is left out. */
export function readParagraphFormat(value: unknown): ParagraphFormat {
  if (!isRecord(value)) return {};
  const format: ParagraphFormat = {};
  const set = <K extends keyof ParagraphFormat>(name: K, read: ParagraphFormat[K]) => {
    if (read !== undefined) format[name] = read;
  };
  set("align", oneOf(value.align, ALIGNS));
  set("left", indent(value.left));
  set("right", indent(value.right));
  set("firstLine", indent(value.firstLine));
  set("firstLineChars", characters(value.firstLineChars));
  set("before", space(value.before));
  set("after", space(value.after));
  set("line", readLine(value.line));
  return format;
}

/** The value to store: null for a format that sets nothing, so the paragraph is as it was. */
export const storedFormat = (value: unknown): ParagraphFormat | null => {
  const read = readParagraphFormat(value);
  return Object.keys(read).length > 0 ? read : null;
};

export const readTextColor = (value: unknown): string | null =>
  typeof value === "string" && HEX.test(value) ? value.toUpperCase() : null;

export const readTextFont = (value: unknown): string | null => (isFontFamily(value) ? value : null);

export const readTextSize = (value: unknown): number | null => fontSize(value) ?? null;

/** `length` writes a length in points as CSS. */
export function lineHeightCss(
  line: WordParagraphLook["line"],
  length: (points: number) => string,
): string {
  if (!line) return String(SINGLE_LINE);
  if (line.rule === "auto") return String(Math.round(SINGLE_LINE * line.value * 1000) / 1000);
  if (line.rule === "exact") return length(line.value);
  return `max(${SINGLE_LINE}em, ${length(line.value)})`;
}

/**
 * A paragraph's format as CSS declarations. A first line in characters is in the paragraph's
 * text size, or its look's character size (`--word-char`). Space before adds to the space the
 * Mind keeps between Blocks (`--block-gap`), as Word adds it to the paragraph's before.
 */
export function paragraphFormatDeclarations(
  format: ParagraphFormat,
  length: (points: number) => string,
): string[] {
  const { align, left, right, firstLine, firstLineChars, before, after, line } = format;
  return [
    align ? `text-align: ${align === "distribute" ? "justify" : align}` : "",
    align === "distribute" ? "text-align-last: justify" : "",
    left !== undefined ? `margin-left: ${length(left)}` : "",
    right !== undefined ? `margin-right: ${length(right)}` : "",
    firstLineChars !== undefined
      ? `text-indent: calc(var(--word-char, 1em) * ${firstLineChars})`
      : firstLine !== undefined
        ? `text-indent: ${length(firstLine)}`
        : "",
    before !== undefined ? `margin-top: calc(var(--block-gap, 0px) + ${length(before)})` : "",
    after !== undefined ? `margin-bottom: ${length(after)}` : "",
    line ? `line-height: ${lineHeightCss(line, length)}` : "",
  ].filter(Boolean);
}
