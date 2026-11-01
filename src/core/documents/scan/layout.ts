/**
 * A scanned page's text (#397), from the lines the recognizer read on its
 * picture: put in reading order, joined into the page's Unit, each line
 * anchored to its box on the page so the viewer can find a quote on the
 * picture, and the words the recognizer was unsure of marked, so a quote of
 * them can say so.
 *
 * Reading order: the page is levelled by the median slant of its long lines
 * (a scan is rarely straight), then read row by row, top to bottom, each
 * row's lines left to right, which keeps a table's rows together. A page in
 * two columns of text, found by a gap no line of text crosses, is read one
 * column after the other, between the lines that span both (a title). Pure.
 */

import { isCjk } from "../../../shared/text";
import type { Anchor, QuarterTurn, TextUnit, UnitScan } from "../../../shared/units";
import type { RecognizedLine } from "../../adapters";

/** A word the recognizer is less sure of than this, at its least sure character, is marked unsure. */
export const UNSURE_BELOW = 0.8;

/**
 * Letters a recognizer reads for digits: a for 4, o and O for 0, l, I and i
 * for 1, S for 5, B for 8, Z for 2, G for 6.
 */
const DIGIT_LETTER = /[aAoOlIiSsBbZzGg]/;

/** Marks that never belong in a number: a separator or sign the recognizer made up. */
const STRAY_MARK = /[;!?=~^&*#@_|\\]/;

/**
 * Whether a word starts like a number and mixes its digits with a letter a
 * recognizer reads for one, or with a stray mark: "2o25", "7a;45o", "1O%",
 * "l2,000", "3S.6". Always unsure, whatever the recognizer's score (#535).
 * A code's letters come first ("Q3", "A4", "H2O", "FY2025", "No.7"), and an
 * ordinal's suffix is a word's own ("1st", "2nd"): both follow the score.
 */
export function mixedNumberWord(text: string): boolean {
  const word = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!/\d/.test(word) || /^\d+(?:st|nd|rd|th)$/iu.test(word)) return false;
  // A lower-case l or a capital I in front of digits is a 1 the recognizer missed.
  if (/^[lI]\d/u.test(word)) return true;
  if (!/^\d/u.test(word)) return false;
  return DIGIT_LETTER.test(word) || STRAY_MARK.test(word);
}

/** Lines at least this much longer than tall show the page's slant. */
const SLANT_LINE_RATIO = 4;
/** Two lines are in one row when they overlap by at least this share of the shorter's height. */
const ROW_OVERLAP = 0.5;
/** A gap between two lines of a row wider than this many line heights reads as a tab: a table's cells. */
const CELL_GAP = 1.5;
/** A column's lines are at least this share of the page's width, its median line twice that. */
const MIN_COLUMN_LINE = 0.15;
/** A column needs this many lines to count. */
const MIN_COLUMN_LINES = 4;

interface Placed {
  line: RecognizedLine;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The median of the slants of the page's long lines, in radians: 0 for a straight page. */
export function pageSlant(lines: readonly RecognizedLine[]): number {
  const slants: number[] = [];
  for (const { quad } of lines) {
    const [topLeft, topRight, , bottomLeft] = quad;
    const length = Math.hypot(topRight[0] - topLeft[0], topRight[1] - topLeft[1]);
    const height = Math.hypot(bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]);
    if (length < height * SLANT_LINE_RATIO) continue;
    slants.push(Math.atan2(topRight[1] - topLeft[1], topRight[0] - topLeft[0]));
  }
  if (slants.length === 0) return 0;
  slants.sort((a, b) => a - b);
  return slants[Math.floor(slants.length / 2)] as number;
}

/** Each line's bounds once the page is turned level. */
function levelled(lines: readonly RecognizedLine[]): Placed[] {
  const slant = pageSlant(lines);
  const cos = Math.cos(-slant);
  const sin = Math.sin(-slant);
  return lines.map((line) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [x, y] of line.quad) {
      xs.push(x * cos - y * sin);
      ys.push(x * sin + y * cos);
    }
    return {
      line,
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    };
  });
}

/** Lines grouped into rows, top to bottom, each row's lines left to right. */
function rows(placed: readonly Placed[]): Placed[][] {
  const sorted = [...placed].sort((a, b) => a.top + a.bottom - (b.top + b.bottom));
  const grouped: { lines: Placed[]; top: number; bottom: number }[] = [];
  for (const each of sorted) {
    const height = each.bottom - each.top;
    const row = grouped.at(-1);
    if (row) {
      const overlap = Math.min(row.bottom, each.bottom) - Math.max(row.top, each.top);
      const shorter = Math.min(height, row.bottom - row.top);
      if (overlap >= shorter * ROW_OVERLAP) {
        row.lines.push(each);
        row.top = Math.min(row.top, each.top);
        row.bottom = Math.max(row.bottom, each.bottom);
        continue;
      }
    }
    grouped.push({ lines: [each], top: each.top, bottom: each.bottom });
  }
  return grouped.map((row) => row.lines.sort((a, b) => a.left - b.left));
}

/**
 * Where a page of two columns of text splits: the x, in the middle half of
 * the page's text, crossed by the fewest lines, if the lines on each side of
 * it are long enough to be a column of text (a table's cells aren't). Null
 * for a page of one column.
 */
function gutter(placed: readonly Placed[]): number | null {
  if (placed.length < MIN_COLUMN_LINES * 2) return null;
  const left = Math.min(...placed.map((each) => each.left));
  const right = Math.max(...placed.map((each) => each.right));
  const width = right - left;
  if (width <= 0) return null;
  let best: { x: number; crossing: number } | null = null;
  const steps = 64;
  for (let step = Math.floor(steps / 4); step <= Math.ceil((steps * 3) / 4); step++) {
    const x = left + (width * step) / steps;
    const crossing = placed.filter((each) => each.left < x && each.right > x).length;
    if (!best || crossing < best.crossing) best = { x, crossing };
  }
  if (!best || best.crossing > placed.length * 0.15) return null;
  const x = best.x;
  const median = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const sides = [placed.filter((each) => each.right <= x), placed.filter((each) => each.left >= x)];
  for (const side of sides) {
    const long = side.filter((each) => each.right - each.left >= width * MIN_COLUMN_LINE);
    if (long.length < MIN_COLUMN_LINES) return null;
    if (median(side.map((each) => each.right - each.left)) < width * MIN_COLUMN_LINE * 2)
      return null;
  }
  return x;
}

/** The page's lines as rows, in reading order (see the module comment). */
export function readingOrder(lines: readonly RecognizedLine[]): RecognizedLine[][] {
  const placed = levelled(lines);
  const split = gutter(placed);
  if (split === null) return rows(placed).map((row) => row.map((each) => each.line));
  // Bands of two columns, between the lines that cross the gutter.
  const spanning = placed
    .filter((each) => each.left < split && each.right > split)
    .sort((a, b) => a.top - b.top);
  const ordered: Placed[][] = [];
  let above = Number.NEGATIVE_INFINITY;
  for (const band of [...spanning, null]) {
    const below = band ? (band.top + band.bottom) / 2 : Number.POSITIVE_INFINITY;
    const inBand = placed.filter((each) => {
      const middle = (each.top + each.bottom) / 2;
      return !(each.left < split && each.right > split) && middle > above && middle <= below;
    });
    ordered.push(...rows(inBand.filter((each) => each.right <= split)));
    ordered.push(...rows(inBand.filter((each) => each.right > split)));
    if (band) ordered.push([band]);
    above = below;
  }
  return ordered.map((row) => row.map((each) => each.line));
}

/** The spans of a line's words that are unsure: too little sure of, or a number's look (#535), as offsets into its text. */
export function unsureWords(line: RecognizedLine): [number, number][] {
  const spans: [number, number][] = [];
  let at = 0;
  let word: { start: number; end: number; least: number } | null = null;
  const close = () => {
    if (
      word &&
      (word.least < UNSURE_BELOW || mixedNumberWord(line.text.slice(word.start, word.end)))
    ) {
      spans.push([word.start, word.end]);
    }
    word = null;
  };
  for (const character of line.characters) {
    const start = at;
    at += character.text.length;
    if (character.text.trim() === "") {
      close();
      continue;
    }
    // Each Chinese or Japanese character is a word of its own: there are no spaces to tell.
    if (isCjk(character.text)) {
      close();
      if (character.confidence < UNSURE_BELOW) spans.push([start, at]);
      continue;
    }
    if (!word) word = { start, end: at, least: character.confidence };
    else {
      word.end = at;
      word.least = Math.min(word.least, character.confidence);
    }
  }
  close();
  return spans;
}

/** A box's corners as fractions of the picture's size, rounded: x and y of each, in the quad's order. */
function fractionQuad(line: RecognizedLine, width: number, height: number): number[] {
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return line.quad.flatMap(([x, y]) => [round(x / width), round(y / height)]);
}

/**
 * A scanned page's Unit: its lines in reading order, a row's lines joined by
 * a space (a tab across a wide gap, as between a table's cells), rows by line
 * breaks. Each line is anchored ("line1", "line2", … in reading order) with
 * its box as fractions of the picture (`Anchor.quad`); the label says who
 * read it (`reader`) and which words it was unsure of.
 */
export function scannedUnit(
  page: number,
  lines: readonly RecognizedLine[],
  picture: { width: number; height: number },
  reader: string,
  turn: QuarterTurn = 0,
): TextUnit {
  let text = "";
  const anchors: Anchor[] = [];
  const unsure: [number, number][] = [];
  let number = 0;
  for (const row of readingOrder(lines)) {
    if (text) text += "\n";
    row.forEach((line, index) => {
      if (index > 0) {
        const previous = row[index - 1] as RecognizedLine;
        const gap = line.quad[0][0] - previous.quad[1][0];
        const height = Math.abs(line.quad[3][1] - line.quad[0][1]);
        text += gap > height * CELL_GAP ? "\t" : " ";
      }
      const start = text.length;
      text += line.text;
      number++;
      anchors.push({
        start,
        end: text.length,
        target: `line${number}`,
        quad: fractionQuad(line, picture.width, picture.height),
      });
      for (const [from, to] of unsureWords(line)) unsure.push([start + from, start + to]);
    });
  }
  const scan: UnitScan = {
    reader,
    ...(turn !== 0 && { turn }),
    ...(unsure.length > 0 && { unsure }),
  };
  return { page, kind: "page", label: { scan }, text, anchors };
}
