import { isCjk, isSpaceless } from "../../shared/text";

const HANGUL = /\p{Script=Hangul}/u;
const LINE_BREAK = /(?<=[^\s])[^\S\n]*\n[^\S\n]*(?=[^\s])/gu;
const ENDS_SENTENCE = /[。．.！!？?；;：:…]/u;
const CLOSES = /[”’"'»›」』】》〉〕）]/u;
const SPACE = /\s/u;

/** The character at `at`, or empty past the end, however many UTF-16 code units it takes. */
function charAt(text: string, at: number): string {
  const code = text.codePointAt(at);
  return code === undefined ? "" : String.fromCodePoint(code);
}

function charBefore(text: string, at: number): string {
  const low = text.charCodeAt(at - 1);
  const high = text.charCodeAt(at - 2);
  const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return text.slice(pair ? at - 2 : at - 1, at);
}

function firstVisible(line: string): string {
  const at = line.search(/[^\s]/u);
  return at < 0 ? "" : charAt(line, at);
}

function lastVisible(line: string): string {
  let end = line.length;
  while (end > 0 && SPACE.test(line.charAt(end - 1))) end--;
  return end === 0 ? "" : charBefore(line, end);
}

/** A line of a page as printed: what it says, the size it is set in, and where it sits. */
export interface PrintedLine {
  text: string;
  /** Its largest font size, in points. */
  size: number;
  /** Its right end, in points from the page's left edge. */
  right: number;
  /** Its left end, in points from the page's left edge; none for a line set at an angle. */
  left?: number;
  /** Its baseline, in points from the page's foot; none for a line set at an angle. */
  baseline?: number;
}

type Placed = PrintedLine & { left: number; baseline: number };

/** A larger size is a different size past this share: a PDF rounds the sizes it writes. */
const SAME_SIZE = 1.05;
/** Lines start at one edge within this many sizes of each other. */
const SAME_LEFT = 0.5;
/** Lines start in one column within this many sizes of each other: a paragraph's first line may be indented. */
const SAME_COLUMN = 2.5;
/** A step down past this many times the page's usual line spacing ends a block: a paragraph's or a heading's space. */
const BLOCK_GAP = 1.25;
/** Lines end at one edge within this many sizes of each other. */
const SAME_EDGE = 0.5;
/**
 * This many lines say where their lines end: a block's, a column's, or a run of them in a row
 * that end together, short of the rest of their block as they may be.
 */
const SEVERAL = 3;
/** A column's lines this many sizes above or below a line are the ones around it. */
const AROUND = 6;
/** One line is set below the next by at most this many sizes, double spacing and all. */
const LINE_STEP = 3;
/**
 * A line ends this many characters short of its measure, or less, where the page wrapped it: a
 * mark that may not start a line takes a character down with it, and figures are narrower.
 */
const SHORT_OF_MEASURE = 2;
/** A Latin letter or a digit is about this share of a CJK character's width, or narrower. */
const NARROW = 0.6;

const sameSize = (a: number, b: number): boolean =>
  a <= 0 || b <= 0 || Math.max(a, b) <= Math.min(a, b) * SAME_SIZE;

const placed = (line: PrintedLine): line is Placed =>
  line.left !== undefined && line.baseline !== undefined && line.right > 0;

/** How far down the page `after` is set below `before`, in points: negative going back up. */
const stepDown = (before: PrintedLine, after: PrintedLine): number | null =>
  placed(before) && placed(after) ? before.baseline - after.baseline : null;

/** The value `share` of the way down `values` from the largest. */
function fromLargest(values: readonly number[], share: number): number | undefined {
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[Math.floor(sorted.length * share)];
}

/**
 * The page's usual step from one line down to the next in `size`: as small as three quarters of
 * its steps, so the space a page leaves between paragraphs doesn't set it. Headings set far apart
 * in a size of their own have none.
 */
function usualStep(page: readonly PrintedLine[], size: number): number | undefined {
  const steps = page.flatMap((line, index) => {
    const next = page[index + 1];
    const step = next ? stepDown(line, next) : null;
    const same = next !== undefined && sameSize(line.size, size) && sameSize(next.size, size);
    return step !== null && same && step > size / 2 && step <= LINE_STEP * size ? [step] : [];
  });
  return fromLargest(steps, 3 / 4);
}

/** The page's lines in blocks: set one under the other at one left edge and in one size, no farther apart than usual. */
function blocksOf(page: readonly PrintedLine[]): PrintedLine[][] {
  const steps = new Map<number, number | undefined>();
  const usual = (size: number) => {
    if (!steps.has(size)) steps.set(size, usualStep(page, size));
    return steps.get(size);
  };
  const goesOn = (before: PrintedLine, after: PrintedLine) => {
    const step = stepDown(before, after);
    const spacing = usual(before.size);
    return (
      placed(before) &&
      placed(after) &&
      step !== null &&
      spacing !== undefined &&
      sameSize(before.size, after.size) &&
      Math.abs(before.left - after.left) <= SAME_LEFT * Math.max(before.size, after.size) &&
      step > 0 &&
      step <= spacing * BLOCK_GAP
    );
  };
  const blocks: PrintedLine[][] = [];
  for (const [index, line] of page.entries()) {
    const before = page[index - 1];
    const block = blocks.at(-1);
    if (before && block && goesOn(before, line)) block.push(line);
    else blocks.push([line]);
  }
  return blocks;
}

/**
 * The right edge each of the page's lines is measured against: where most lines of its block end
 * (see `blockMeasures`). A block of one or two lines can't say where its lines end, so its column
 * does (see `columnEdge`).
 */
export function pageMeasures(page: readonly PrintedLine[]): (number | undefined)[] {
  const measured = new Map<PrintedLine, number | undefined>();
  const few: PrintedLine[][] = [];
  const wrapped: Placed[] = [];
  for (const block of blocksOf(page)) {
    if (block.length < SEVERAL) {
      few.push(block);
      continue;
    }
    const edges = blockMeasures(block);
    block.forEach((line, index) => {
      const edge = edges[index];
      measured.set(line, edge);
      if (edge !== undefined && placed(line) && !shortOf(line, edge, 0)) wrapped.push(line);
    });
  }
  const positioned = page.filter(placed);
  for (const block of few) {
    for (const line of block) {
      if (placed(line)) measured.set(line, columnEdge(line, block, positioned, wrapped));
    }
  }
  return page.map((line) => {
    const measure = measured.get(line);
    if (measure === undefined || !placed(line)) return measure;
    // Text set beside a line, a table's next cell, say, is as far as it could reach.
    const beside = positioned
      .filter(
        (other) =>
          other.left > line.right && Math.abs(other.baseline - line.baseline) <= line.size / 2,
      )
      .map((other) => other.left);
    return Math.min(measure, ...beside);
  });
}

/**
 * Where the lines of `line`'s column end: its wrapped lines around `line`, which a figure beside
 * them may have narrowed; else all its lines, where another starts where `line` does, or there are
 * several; else, for a line few others start near, such as a centred title or a caption, the
 * page's lines.
 */
function columnEdge(
  line: Placed,
  block: readonly PrintedLine[],
  page: readonly Placed[],
  wrapped: readonly Placed[],
): number | undefined {
  const inColumn = (other: Placed) =>
    Math.abs(other.left - line.left) <= SAME_COLUMN * Math.max(line.size, other.size);
  const around = wrapped.filter(
    (other) => inColumn(other) && Math.abs(other.baseline - line.baseline) <= AROUND * line.size,
  );
  const column = page.filter(inColumn);
  const aligned = column.some(
    (other) => !block.includes(other) && Math.abs(other.left - line.left) <= SAME_LEFT * line.size,
  );
  const own = column.length > 1 && column.every((other) => block.includes(other));
  const near =
    around.length > 0 ? around : column.length >= SEVERAL || aligned || own ? column : page;
  return fromLargest(
    near.map((other) => other.right),
    1 / 4,
  );
}

/**
 * Where most of a block's lines end; and, for a few lines in a row that end together short of it,
 * where they end: text set beside a figure is wrapped at the figure.
 */
function blockMeasures(block: readonly PrintedLine[]): (number | undefined)[] {
  const edge = fromLargest(
    block.map((line) => line.right),
    1 / 4,
  );
  const measured: (number | undefined)[] = block.map(() => edge);
  let from = 0;
  for (let to = 1; to <= block.length; to++) {
    const last = block[to - 1];
    const next = block[to];
    if (last && next && Math.abs(last.right - next.right) <= SAME_EDGE * last.size) continue;
    if (to - from >= SEVERAL && edge !== undefined) {
      const run = Math.max(...block.slice(from, to).map((line) => line.right));
      measured.fill(Math.min(edge, run), from, to);
    }
    from = to;
  }
  return measured;
}

/** A mark a line may not end with, which goes down with the word after it. */
const NO_END = /[（［｛【《〈〔「『]/u;
/** A mark a line may not start with, which stays with the word before it. */
const NO_START = /[）］｝】》〉〕」』，。、；：！？]/u;

/**
 * How wide the start of `after` is that the page could not break inside, in points: a Latin word
 * or a number, with an opening mark before it and a closing mark after it.
 */
function firstWordWidth(after: PrintedLine): number {
  const chars = [...after.text.trimStart()];
  const inWord = (char = "") => char !== "" && !SPACE.test(char) && !isSpaceless(char);
  let at = 0;
  while (NO_END.test(chars[at] ?? "")) at++;
  const opens = at;
  let word = 0;
  for (; inWord(chars[at]); at++) word += isCjk(chars[at] ?? "") ? 1 : NARROW;
  if (word === 0) return 0;
  return (opens + word + (NO_START.test(chars[at] ?? "") ? 1 : 0)) * after.size;
}

/**
 * Whether the page ended `before` itself — at a heading, a title, a new paragraph or a new
 * column — rather than wrapping it onto `after`.
 *
 * A wrapped sentence keeps its font size across the break; a heading is set in a size of its own.
 * And a wrapped line reaches its measure, whatever the line under it does: the page ends it
 * because the next character doesn't fit, or, before a Latin word or a number, the next word. A
 * line that stops well short of where its block's lines end was ended on purpose (#3288).
 */
function endedByPage(before: PrintedLine, after: PrintedLine, measure: number | undefined) {
  if (!sameSize(before.size, after.size)) return true;
  if (lastVisible(before.text) === "" || firstVisible(after.text) === "") return true;
  if (measure === undefined || !placed(before)) return false;
  return shortOf(before, measure, firstWordWidth(after));
}

/** Whether `line` stops short of `measure` by more than the page leaves where it wraps, `room` more. */
const shortOf = (line: PrintedLine, measure: number, room: number): boolean =>
  measure - line.right > SHORT_OF_MEASURE * line.size + room;

/** A page's text as extraction reads it, and the newlines in it that the page ended itself. */
export interface PrintedText {
  text: string;
  /**
   * The offsets in `text` of the newlines a page ended itself (see
   * `endedByPage`). An offset names one break, not every line that reads
   * the same: a page may print one line as a heading and again as wrapped
   * text, and only the heading keeps its break.
   */
  kept: ReadonlySet<number>;
}

const TRAILING_SPACE = /[^\S\n]+$/;
const LEADING_SPACE = /^[^\S\n]+/;

/**
 * A page's text from its printed lines: a break the page wrapped is joined
 * as extraction always joined it, beside Han, kana or Hangul, and the
 * newline of one it broke itself is named in `kept`, so that the wider join,
 * made when the page is processed, leaves it alone (see `joinCjkLineWraps`).
 * `measured` is the measure of each line (see `pageMeasures`): the page's,
 * where `lines` are only some of its lines.
 */
export function joinPrintedLines(
  lines: readonly PrintedLine[],
  measured: readonly (number | undefined)[] = pageMeasures(lines),
): PrintedText {
  const kept = new Set<number>();
  let text = "";
  for (const [index, line] of lines.entries()) {
    const before = lines[index - 1];
    if (before === undefined) {
      text = line.text;
      continue;
    }
    if (endedByPage(before, line, measured[index - 1])) {
      if (lastVisible(before.text) !== "" && firstVisible(line.text) !== "") kept.add(text.length);
      text += `\n${line.text}`;
      continue;
    }
    const joins = isCjk(lastVisible(before.text)) && isCjk(firstVisible(line.text));
    text = joins
      ? `${text.replace(TRAILING_SPACE, "")}${line.text.replace(LEADING_SPACE, "")}`
      : `${text}\n${line.text}`;
  }
  const leading = text.length - text.trimStart().length;
  return {
    text: text.trim(),
    kept: new Set([...kept].map((at) => at - leading).filter((at) => at >= 0)),
  };
}

/**
 * A PDF's line break inside running text, joined the way a reader sees it:
 * gone beside Han, kana, Bopomofo or CJK and full-width punctuation, where no
 * space is written, and between two Hangul characters; one space where only
 * one side is Hangul, whose words keep their spaces; and nowhere else.
 *
 * A line that ends in sentence-ending punctuation, or in the mark that closes
 * it, keeps its break: that is where a paragraph or a list item ends, and the
 * model should read it as one. So does a break at a newline named in
 * `keptAt`: one the page made itself, such as a heading's (see
 * `joinPrintedLines`).
 */
export function joinCjkLineWraps(text: string, keptAt?: ReadonlySet<number>): string {
  return text.replace(LINE_BREAK, (match, offset: number) => {
    if (keptAt?.has(offset + match.indexOf("\n"))) return match;
    const before = charBefore(text, offset);
    const after = charAt(text, offset + match.length);
    if (ENDS_SENTENCE.test(before) || CLOSES.test(before)) return match;
    if (isSpaceless(before) || isSpaceless(after)) return "";
    if (!HANGUL.test(before) && !HANGUL.test(after)) return match;
    return HANGUL.test(before) && HANGUL.test(after) ? "" : " ";
  });
}

/** Whether applying only that join rule takes the earlier text to the later text. */
export function onlyCjkLineWrapChange(earlier: string, later: string): boolean {
  return earlier !== later && joinCjkLineWraps(earlier) === later;
}
