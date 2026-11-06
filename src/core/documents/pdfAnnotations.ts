/**
 * The highlights and notes a PDF file itself holds, read when it is added
 * (#327): a reader such as Preview, Acrobat or Zotero saves them inside the
 * file, and IncarnaMind shows them as the User's own are shown, marked "From
 * the file". The words a highlight covers are the page's text items under its
 * quads, so the quote is the page's own words and its check can find them.
 */
import type { AnnotationColour } from "../api";
import { textItemOf } from "./tables";

/** A highlight or note a PDF file holds. */
export interface FileAnnotation {
  /** The page it is on, from 1. */
  page: number;
  /** "highlight" covers words; "note" is a sticky note, with only its words. */
  kind: "highlight" | "note";
  quote: string;
  note: string | null;
  colour: AnnotationColour;
  /** Who made it, as the file says. */
  author: string | null;
  /** Its place among the page's marks: higher first, then further left, so a file listing them in another order still pairs each with its row. */
  order: number;
  /** The page's words right before it, which tell one copy of its words from another. */
  before: string;
  /** The page's words right after it. */
  after: string;
}

/** The subtypes a highlight is saved as. A squiggle or a strike-through marks words too. */
const HIGHLIGHT_SUBTYPES = new Set(["Highlight", "Underline", "Squiggly", "StrikeOut"]);

/** The colours the app draws, as a PDF reader's RGB is matched to one. */
const COLOUR_RGB: readonly (readonly [AnnotationColour, number, number, number])[] = [
  ["yellow", 255, 233, 120],
  ["green", 180, 230, 170],
  ["blue", 175, 215, 250],
  ["pink", 250, 190, 210],
  ["purple", 210, 190, 245],
];

const numbersOf = (value: unknown): number[] | undefined => {
  if (typeof value !== "object" || value === null || !("length" in value)) return undefined;
  const length = (value as { length: unknown }).length;
  if (typeof length !== "number") return undefined;
  const read = Array.from({ length }, (_, at) => (value as Record<number, unknown>)[at]);
  return read.filter((each): each is number => typeof each === "number");
};

const colourOf = (color: readonly number[] | undefined): AnnotationColour => {
  if (!color || color.length < 3) return "yellow";
  const [r = 0, g = 0, b = 0] = color;
  let best: AnnotationColour = "yellow";
  let closest = Number.POSITIVE_INFINITY;
  for (const [name, red, green, blue] of COLOUR_RGB) {
    const distance = (r - red) ** 2 + (g - green) ** 2 + (b - blue) ** 2;
    if (distance < closest) {
      closest = distance;
      best = name;
    }
  }
  return best;
};

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The boxes an annotation covers, in the page's own coordinates. */
function boxesOf(data: { rect?: unknown; quadPoints?: unknown }): Box[] {
  const numbers = (value: unknown): number[] => numbersOf(value) ?? [];
  const quads = numbers(data.quadPoints);
  const hasQuads = data.quadPoints !== undefined && data.quadPoints !== null;
  const boxes: Box[] = [];
  for (let at = 0; at + 7 < quads.length; at += 8) {
    const xs = [quads[at], quads[at + 2], quads[at + 4], quads[at + 6]] as number[];
    const ys = [quads[at + 1], quads[at + 3], quads[at + 5], quads[at + 7]] as number[];
    boxes.push({
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.max(...ys),
      bottom: Math.min(...ys),
    });
  }
  // Quads it can't read are no rectangle: quoting the bounding rect would quote the gap
  // between separate marked runs. A rect alone is still a mark a reader saved whole.
  if (boxes.length === 0 && !hasQuads) {
    const rect = numbers(data.rect);
    if (rect.length === 4) {
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = rect;
      boxes.push({
        left: Math.min(x1, x2),
        right: Math.max(x1, x2),
        top: Math.max(y1, y2),
        bottom: Math.min(y1, y2),
      });
    }
  }
  return boxes;
}

const overlaps = (a: Box, b: Box, slack: number) =>
  a.left - slack <= b.right &&
  b.left - slack <= a.right &&
  a.bottom - slack <= b.top &&
  b.bottom - slack <= a.top;

interface Placed {
  str: string;
  box: Box;
  size: number;
}

function placedOf(items: readonly object[]): Placed[] {
  const placed: Placed[] = [];
  for (const item of items) {
    const text = textItemOf(item);
    if (!text || text.str === "") continue;
    const size = text.size > 0 ? text.size : text.fontSize;
    placed.push({
      str: text.str,
      size,
      // A glyph rises 0.75 of its size above the baseline and falls 0.25 below it: a reader's
      // quad around one line then holds that line and not the one above.
      box: {
        left: text.x,
        right: text.x + text.width,
        top: text.baseline + size * 0.75,
        bottom: text.baseline - size * 0.25,
      },
    });
  }
  return placed;
}

/** Whether a mark covers a glyph item whole, so its words are the marked words. */
function holds(box: Box, item: Placed): boolean {
  // A line's item may end in a space or a hair beyond the mark's quad: a word's width of
  // slack keeps those, while a mark over part of a long item stays partial.
  const across = Math.max(item.size, 0.5);
  const down = Math.max(item.size * 0.25, 0.5);
  return (
    item.box.left >= box.left - across &&
    item.box.right <= box.right + across &&
    item.box.top <= box.top + down &&
    item.box.bottom >= box.bottom - down
  );
}

/** The words of `items` under `boxes`, top to bottom and left to right, a space where items are apart. */
function wordsUnder(boxes: readonly Box[], items: readonly object[]): string {
  if (boxes.length === 0) return "";
  const covered = coveredOf(boxes, items);
  // A mark over part of an item can't be quoted by the whole item: its exact words are unknown.
  if (covered.some((item) => !boxes.some((box) => holds(box, item)))) return "";
  return linesOf(covered)
    .map((line) => lineText(line).text)
    .join("\n")
    .replaceAll("\u0000", "")
    .trim();
}

/** Whether a glyph's own box is one a mark covers: it overlaps, and its middle is inside. */
function covers(boxes: readonly Box[], item: Placed): boolean {
  const middle = (item.box.top + item.box.bottom) / 2;
  return boxes.some(
    (box) => overlaps(box, item.box, item.size * 0.25) && middle <= box.top && middle >= box.bottom,
  );
}

function coveredOf(boxes: readonly Box[], items: readonly object[]): Placed[] {
  return placedOf(items).filter((item) => covers(boxes, item));
}

function linesOf(placed: Placed[]): Placed[][] {
  placed.sort((a, b) => b.box.top - a.box.top || a.box.left - b.box.left);
  const lines: Placed[][] = [];
  for (const item of placed) {
    const line = lines.at(-1);
    const size = Math.max(item.size, line?.[0]?.size ?? 0);
    if (line && Math.abs((line[0]?.box.top ?? 0) - item.box.top) <= size * 0.6) line.push(item);
    else lines.push([item]);
  }
  return lines;
}

interface Span {
  start: number;
  end: number;
}

/** A line's words left to right, and where each item's own words sit in them. */
function lineText(line: Placed[]): { text: string; spans: Map<Placed, Span> } {
  line.sort((a, b) => a.box.left - b.box.left);
  let text = "";
  const spans = new Map<Placed, Span>();
  for (const [index, item] of line.entries()) {
    const previous = line[index - 1];
    const gap = previous ? item.box.left - previous.box.right : 0;
    const space = previous && gap > item.size * 0.18 ? " " : "";
    text += space;
    const start = text.length;
    text += item.str;
    spans.set(item, { start, end: text.length });
  }
  return { text, spans };
}

/** The page's own words in reading order, with each text item's place in them. */
function pageTextOf(items: readonly object[]) {
  let text = "";
  const spans = new Map<Placed, Span>();
  const placed: Placed[] = [];
  for (const [index, line] of linesOf(placedOf(items)).entries()) {
    if (index > 0) text += "\n";
    const offset = text.length;
    const written = lineText(line);
    text += written.text;
    for (const [item, span] of written.spans) {
      spans.set(item, { start: span.start + offset, end: span.end + offset });
      placed.push(item);
    }
  }
  return { text, spans, placed };
}

/** How much of the page's words before and after a mark is kept to tell it from another. */
const AROUND = 80;

/** The page's words just before `start` and just after `end`, `AROUND` characters each. */
function aroundAt(text: string, start: number, end: number): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, start - AROUND), start),
    after: text.slice(end, end + AROUND),
  };
}

/** The text nearest an icon's place, where its own words are none: before the item it is left of, else after it. */
function nearestOffset(context: ReturnType<typeof pageTextOf>, boxes: readonly Box[]): number {
  const box = boxes[0];
  if (!box) return 0;
  const x = (box.left + box.right) / 2;
  const y = (box.top + box.bottom) / 2;
  const away = (item: Placed) => {
    const across = Math.max(item.box.left - x, x - item.box.right, 0);
    const down = Math.max(item.box.bottom - y, y - item.box.top, 0);
    return Math.hypot(across, down);
  };
  const nearest = [...context.placed].sort((a, b) => away(a) - away(b))[0];
  const span = nearest ? context.spans.get(nearest) : undefined;
  if (!nearest || !span) return 0;
  return x < (nearest.box.left + nearest.box.right) / 2 ? span.start : span.end;
}

function orderOf(boxes: readonly Box[]): number {
  if (boxes.length === 0) return 0;
  const top = Math.max(...boxes.map((box) => box.top));
  const left = Math.min(...boxes.filter((box) => box.top === top).map((box) => box.left));
  return left - top * 1000;
}

/** The page's words around a mark: a highlight's own covered range, or an icon's nearest words. */
function surroundingsOf(
  context: ReturnType<typeof pageTextOf>,
  boxes: readonly Box[],
): { before: string; after: string } {
  if (context.text === "") return { before: "", after: "" };
  const covered = context.placed
    .filter((item) => covers(boxes, item))
    .map((item) => context.spans.get(item))
    .filter((span): span is Span => span !== undefined)
    .sort((a, b) => a.start - b.start);
  const first = covered[0];
  const last = covered.at(-1);
  if (first && last) return aroundAt(context.text, first.start, last.end);
  const at = nearestOffset(context, boxes);
  return aroundAt(context.text, at, at);
}

const textOf = (value: unknown): string =>
  typeof value === "string" ? value.replaceAll("\u0000", "").replace(/\r\n?/g, "\n").trim() : "";

/**
 * The highlights and notes `annotations` holds on a page, with the page's text
 * `items` (pdf.js's text content): a quote's words are those the highlight
 * covers. The store cites each quote against the pages it keeps.
 */
export function readFileAnnotations(
  page: number,
  annotations: readonly object[],
  items: readonly object[],
): FileAnnotation[] {
  const found: FileAnnotation[] = [];
  // The page's words, built once for every mark on it; a page with no marks pays nothing.
  let context: ReturnType<typeof pageTextOf> | null = null;
  const wordsAround = (boxes: readonly Box[]) => {
    context ??= pageTextOf(items);
    return surroundingsOf(context, boxes);
  };
  for (const annotation of annotations) {
    if (typeof annotation !== "object" || annotation === null) continue;
    const data = annotation as {
      subtype?: unknown;
      rect?: unknown;
      quadPoints?: unknown;
      contents?: unknown;
      contentsObj?: { str?: unknown };
      title?: unknown;
      titleObj?: { str?: unknown };
      color?: unknown;
    };
    const subtype = typeof data.subtype === "string" ? data.subtype : "";
    const note = textOf(data.contentsObj?.str ?? data.contents) || null;
    const author = textOf(data.titleObj?.str ?? data.title) || null;
    const colour = colourOf(numbersOf(data.color));
    const boxes = boxesOf(data);
    if (HIGHLIGHT_SUBTYPES.has(subtype)) {
      const quote = wordsUnder(boxes, items);
      if (quote === "") continue;
      found.push({
        page,
        kind: "highlight",
        quote,
        note,
        colour,
        author,
        order: orderOf(boxes),
        ...wordsAround(boxes),
      });
      continue;
    }
    if (subtype === "Text" && note !== null) {
      found.push({
        page,
        kind: "note",
        quote: "",
        note,
        colour,
        author,
        order: orderOf(boxes),
        ...wordsAround(boxes),
      });
    }
  }
  return found;
}
