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
  const numbers = (value: unknown): number[] =>
    Array.isArray(value) ? value.filter((each): each is number => typeof each === "number") : [];
  const quads = numbers(data.quadPoints);
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
  if (boxes.length === 0) {
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

/** The words of `items` under `boxes`, top to bottom and left to right, a space where items are apart. */
function wordsUnder(boxes: readonly Box[], items: readonly object[]): string {
  if (boxes.length === 0) return "";
  const covered = placedOf(items).filter((item) => {
    const middle = (item.box.top + item.box.bottom) / 2;
    return boxes.some(
      (box) =>
        overlaps(box, item.box, item.size * 0.25) && middle <= box.top && middle >= box.bottom,
    );
  });
  covered.sort((a, b) => b.box.top - a.box.top || a.box.left - b.box.left);
  const lines: Placed[][] = [];
  for (const item of covered) {
    const line = lines.at(-1);
    const size = Math.max(item.size, line?.[0]?.size ?? 0);
    if (line && Math.abs((line[0]?.box.top ?? 0) - item.box.top) <= size * 0.6) line.push(item);
    else lines.push([item]);
  }
  return lines
    .map((line) =>
      line
        .sort((a, b) => a.box.left - b.box.left)
        .map((item, index) => {
          const previous = line[index - 1];
          const gap = previous ? item.box.left - previous.box.right : 0;
          const space = previous && gap > item.size * 0.18 ? " " : "";
          return `${space}${item.str}`;
        })
        .join(""),
    )
    .join("\n")
    .replaceAll("\u0000", "")
    .trim();
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
    if (HIGHLIGHT_SUBTYPES.has(subtype)) {
      const quote = wordsUnder(boxesOf(data), items);
      if (quote === "") continue;
      found.push({
        page,
        kind: "highlight",
        quote,
        note,
        colour,
        author,
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
      });
    }
  }
  return found;
}
