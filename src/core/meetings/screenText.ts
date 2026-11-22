/**
 * A shared window's text, from the two readings of one settled picture
 * (ADR-0031): its lines in reading order, as a scanned page's (a table row by
 * row, a slide's columns one after the other), each with its box, and the
 * figures the reading may have got wrong. A figure is unsure when the two
 * readings disagree on it, when the recogniser was unsure of one of its
 * characters, or when it mixes digits with letters or marks a number doesn't
 * have ("2o25", "l2,000", "3S.6"), which codes such as "Q3", "H2O" or "FY2025"
 * don't. Pure.
 */
import type { RecognizedLine } from "../adapters";
import { scannedUnit, UNSURE_BELOW } from "../documents/scan/layout";

/** A line's box on the picture, as fractions of its size: left, top, right, bottom. */
export type LineBox = [number, number, number, number];

export interface ScreenText {
  text: string;
  /** The figures that may be misread: [start, end) offsets into `text`. */
  unsure: [number, number][];
  /** Each line's place in `text`, and its box. */
  lines: { start: number; end: number; box: LineBox }[];
}

/** Two lines of the two readings are the same line when their boxes overlap this much. */
const SAME_LINE = 0.5;

/** A figure: digits, with the marks a number is written with between them. */
const FIGURE = /\d(?:[\d,.]*\d)?/g;

/** The words of a line, as runs of anything but spaces. */
const WORD = /\S+/g;

/** Letters a reading confuses with digits, and the marks a misread digit leaves. */
const CONFUSED = /[OolISZB]/;
const NUMBER_MARKS = /[,.%]/;

/** Whether a word is a number with something in it no number has: "2o25", "7a;45o", "1O%", "l2,000", "3S.6". */
export function misreadNumber(word: string): boolean {
  if (!/\d/.test(word)) return false;
  // A Latin letter or a stray mark between two digits: "2026年10月" writes its digits apart on purpose.
  if (/\d[^\d\s,.%+\-–/:]*[A-Za-z;'"!|][^\d\s]*\d/.test(word)) return true;
  // A letter that looks like a digit, beside one, in a word written as a number.
  for (let at = 0; at < word.length; at++) {
    const character = word[at] as string;
    if (!CONFUSED.test(character)) continue;
    const beside = `${word[at - 1] ?? ""}${word[at + 1] ?? ""}`;
    if (/\d/.test(beside) && NUMBER_MARKS.test(word)) return true;
  }
  return false;
}

/** A box's bounds, as fractions of the picture. */
function boxOf(quad: readonly number[]): LineBox {
  const xs = [quad[0], quad[2], quad[4], quad[6]].map((value) => value ?? 0);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map((value) => value ?? 0);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function overlap(a: LineBox, b: LineBox): number {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (width <= 0 || height <= 0) return 0;
  const area = (box: LineBox) => (box[2] - box[0]) * (box[3] - box[1]);
  return (width * height) / (area(a) + area(b) - width * height);
}

const figuresOf = (text: string): string[] => text.match(FIGURE) ?? [];

/** The spans of a line's figures that a character the recogniser was unsure of falls in. */
function doubtfulFigures(line: RecognizedLine): [number, number][] {
  const doubtful: number[] = [];
  let at = 0;
  for (const character of line.characters) {
    if (character.confidence < UNSURE_BELOW) {
      for (let offset = 0; offset < character.text.length; offset++) doubtful.push(at + offset);
    }
    at += character.text.length;
  }
  const spans: [number, number][] = [];
  for (const match of line.text.matchAll(FIGURE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (doubtful.some((offset) => offset >= start && offset < end)) spans.push([start, end]);
  }
  return spans;
}

/** The text read from a settled picture: `first` read, and `second`, a second later; null when it wasn't read again. */
export function screenText(
  first: readonly RecognizedLine[],
  second: readonly RecognizedLine[] | null,
  picture: { width: number; height: number },
): ScreenText {
  const unit = scannedUnit(1, first, picture, "");
  const secondBoxes = (second ?? []).map((line) => ({
    line,
    box: boxOf(line.quad.flatMap(([x, y]) => [x / picture.width, y / picture.height])),
  }));
  const unsure: [number, number][] = [];
  const lines: ScreenText["lines"] = [];
  for (const anchor of unit.anchors ?? []) {
    const box = boxOf(anchor.quad ?? []);
    lines.push({ start: anchor.start, end: anchor.end, box });
    const text = unit.text.slice(anchor.start, anchor.end);
    const read = first.find((line) => line.text === text);
    const mark = (from: number, to: number) =>
      unsure.push([anchor.start + from, anchor.start + to]);
    if (read) for (const [from, to] of doubtfulFigures(read)) mark(from, to);
    for (const word of text.matchAll(WORD)) {
      if (misreadNumber(word[0])) mark(word.index, word.index + word[0].length);
    }
    if (second === null) continue;
    let best: { line: RecognizedLine; overlap: number } | null = null;
    for (const each of secondBoxes) {
      const shared = overlap(box, each.box);
      if (shared >= SAME_LINE && (!best || shared > best.overlap)) {
        best = { line: each.line, overlap: shared };
      }
    }
    const again = best ? figuresOf(best.line.text) : [];
    for (const match of text.matchAll(FIGURE)) {
      const at = again.indexOf(match[0]);
      if (at >= 0) again.splice(at, 1);
      else mark(match.index, match.index + match[0].length);
    }
  }
  return { text: unit.text, unsure: merged(unsure), lines };
}

/** Spans in order, overlapping ones joined. */
function merged(spans: readonly [number, number][]): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** The text with each unsure figure marked "⟦…⟧", as the model reads it. */
export function markedText({ text, unsure }: Pick<ScreenText, "text" | "unsure">): string {
  let marked = "";
  let from = 0;
  for (const [start, end] of unsure) {
    marked += `${text.slice(from, start)}⟦${text.slice(start, end)}⟧`;
    from = end;
  }
  return marked + text.slice(from);
}
