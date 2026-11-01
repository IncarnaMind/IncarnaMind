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
 * Real code and everyday-number shapes whose letters or marks between digits
 * are their own: a quarter ("3Q24", "2024Q3"), a half-year ("1H25", "2024H2"),
 * a size or product ("4x4", "3×4"), scientific notation ("1e6"), a time or a
 * ratio ("10:30", "3:1", "10h30"), and a fraction or slash date ("1/2",
 * "2024/3/1"). They follow the recognizer's score, with or without a unit
 * after them ("10:30am", "1/2kg"); anything else between a number's digits is
 * a digit it may have misread.
 */
const CODE_SHAPE =
  /^(?:[1-4]Q\d{2}|\d{4}Q[1-4]|[1-2]H\d{2}|\d{4}H[1-2]|\d+[xX×]\d+|\d+(?:\.\d+)?e[+-]?\d+|\d+:\d+(?::\d+)?|\d{1,2}h\d{2}|\d+\/\d+(?:\/\d+)?)$/u;

/**
 * A unit or suffix after a number or a shape ("10:30am", "1/2kg", "3x4m",
 * "3/4ths"): the shape is read without it, as a plain number's unit is. A
 * bare "x" ("1e6x") isn't one: that is a word the scan may have misread.
 */
const TRAILING_UNIT =
  /(?:am|pm|kg|g|mg|km|cm|mm|m|l|ml|cl|dl|s|sec|secs|min|mins|h|hr|hrs|d|day|days|wk|wks|mo|mos|yr|yrs|th|ths|bps|bp|bn|b|k|GB|MB|TB|KB|Hz|kHz|MHz|GHz|W|kW|MW|GW|V|mA|mAh|kWh|MWh)$/iu;

/**
 * A CJK numeral: between digits ("2〇25") it is a digit the scan may have read
 * as a character. The scale characters (十百千万亿) aren't digits and break the
 * run, so "1万2千" and "3亿5000万" are numbers of their own.
 */
const CJK_NUMERAL = "〇零一二三四五六七八九两壹贰叁肆伍陆柒捌玖";

/**
 * Whether a word starts like a number and holds, between its first and last
 * digit, anything but a digit, comma or full stop: a letter or a mark the
 * recognizer read for a digit ("2o25", "1T5", "7a;45o", "74;450"), or a
 * Chinese numeral ("2〇25"). Always unsure, whatever the recognizer's score
 * (#535). A few real codes keep their letters ("3Q24", "2024Q3", "1H25",
 * "4x4", "1e6"), and a number's unit or scale follows its digits ("2.5bn",
 * "10bps", "1990s", "10am", "50kg", "100ml", "4GB", "5G", "12b"); those, a
 * code's letters before the number ("Q3", "A4", "H2O", "FY2025", "No.7"), a
 * range's ends ("10am-12pm") and an ordinal's suffix ("1st", "2nd") follow
 * the recognizer's score, as does a shape with a unit after it ("10:30am").
 */
export function mixedNumberWord(text: string): boolean {
  // Full-width digits and marks read as the ASCII ones a number is written with ("１T５" is "1T5").
  const word = text.normalize("NFKC").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!/\p{Nd}/u.test(word)) return false;
  // A range's ends are numbers of their own, and their units belong to them ("10bps-20bps").
  if (/[-–—]/u.test(word)) {
    return word.split(/[-–—]/u).some((part) => part !== "" && mixedNumberWord(part));
  }
  if (/^\p{Nd}+(?:st|nd|rd|th)$/iu.test(word)) return false;
  // A lower-case l or a capital I in front of digits is a 1 the recognizer missed.
  if (/^[lI]\p{Nd}/u.test(word)) return true;
  if (!/^\p{Nd}/u.test(word)) return false;
  const core = word.slice(word.search(/\p{Nd}/u), word.search(/\p{Nd}(?![\s\S]*\p{Nd})/u) + 1);
  if (/[^\p{Nd}.,]/u.test(core) && !CODE_SHAPE.test(word.replace(TRAILING_UNIT, ""))) return true;
  // An O for a 0 beside the last digit: "1O%", "1o.". A unit's letter ("5l") isn't one.
  return /\p{Nd}[Oo](?!\p{L})/u.test(word);
}

/**
 * The words of a scanned Unit that may have been misread: those stored when it
 * was read, and those a number's shape shows (#535), so a page read before
 * that rule is covered without reading it again. Spans are into the Unit's
 * text, in order, each once.
 */
export function unsureSpansIn(unit: {
  text: string;
  label?: TextUnit["label"];
}): [number, number][] {
  if (!unit.label?.scan) return [];
  const spans: [number, number][] = (unit.label.scan.unsure ?? []).map(([from, to]) => [from, to]);
  for (const match of unit.text.matchAll(NUMBER_RUN)) {
    if (!mixedNumberWord(match[0])) continue;
    const start = match.index ?? 0;
    spans.push([start, start + match[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    // Two words that touch are two words (each Chinese character is one); only an overlap is one word.
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  return merged;
}

/**
 * A stretch of a scanned line that can be a number: not a space, and not a
 * character of Chinese, Japanese or Korean text, though a CJK numeral is one
 * of the number ("2〇25").
 */
const NUMBER_RUN = new RegExp(
  `(?:[^\\s\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}]|[${CJK_NUMERAL}])+`,
  "gu",
);

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
