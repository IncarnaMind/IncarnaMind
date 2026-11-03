/**
 * The sheet preview's geometry and cell styles, kept apart from React so
 * they can be tested: rows and columns of varying sizes (some hidden),
 * fonts, borders and the edges between cells, as Excel draws them. Pure.
 */
import type { CSSProperties } from "react";
import type { BorderEdge, CellStyle, FontStyle } from "../../../core/documents/formats/xlsxStyles";
import { fontKind } from "../../../shared/fontKinds";
import { officeFontName } from "./officeFontNames";

/**
 * Rows or columns: each the default size unless set (0 hides it). Offsets
 * come from the few sizes set, so a sheet of a million rows costs no more
 * than the rows that differ.
 */
export class Axis {
  /** The indexes whose size is set, in order, and the sum of their differences up to each. */
  private readonly set: number[];
  private readonly sizes: Map<number, number>;
  private readonly before: number[];

  constructor(
    /** The first index: 1 for rows, 0 for columns. */
    readonly first: number,
    readonly count: number,
    readonly defaultSize: number,
    sizes: ReadonlyMap<number, number>,
  ) {
    this.sizes = new Map([...sizes].filter(([index]) => index >= first && index < first + count));
    this.set = [...this.sizes.keys()].sort((a, b) => a - b);
    this.before = [];
    let sum = 0;
    for (const index of this.set) {
      this.before.push(sum);
      sum += (this.sizes.get(index) as number) - defaultSize;
    }
  }

  get last(): number {
    return this.first + this.count - 1;
  }

  size(index: number): number {
    return this.sizes.get(index) ?? this.defaultSize;
  }

  /** Where `index` starts, from the start of the first. */
  start(index: number): number {
    // The sizes set before `index`: a binary search.
    let low = 0;
    let high = this.set.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.set[middle] as number) < index) low = middle + 1;
      else high = middle;
    }
    const extra =
      low === 0
        ? 0
        : (this.before[low - 1] as number) +
          (this.sizes.get(this.set[low - 1] as number) as number) -
          this.defaultSize;
    return (index - this.first) * this.defaultSize + extra;
  }

  get total(): number {
    return this.start(this.first + this.count);
  }

  /** The shown index at `offset`: the last one starting at or before it. */
  indexAt(offset: number): number {
    let low = this.first;
    let high = this.last;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.start(middle) <= offset) low = middle;
      else high = middle - 1;
    }
    // A hidden one takes no room: the next shown one is at that offset.
    let index = low;
    while (index < this.last && this.size(index) === 0) index++;
    return index;
  }

  /** The shown indexes from `from` to `to`. */
  visible(from: number, to: number): number[] {
    const shown: number[] = [];
    for (let index = Math.max(from, this.first); index <= Math.min(to, this.last); index++) {
      if (this.size(index) > 0) shown.push(index);
    }
    return shown;
  }
}

/** Excel's line height for a font size: 11pt text sits in a 15pt (20px) row. */
export function rowHeightFor(points: number, lines: number): number {
  return Math.round((lines * points * 4 * 15) / (3 * 11));
}

const FALLBACKS = {
  serif: "var(--font-serif)",
  mono: "var(--font-mono)",
  sans: "var(--font-sans)",
};

/** A font's name as a CSS family, falling back to the app's own font of the same kind. */
export function fontFamily(name: string | undefined): string {
  if (!name) return FALLBACKS.sans;
  return `"${officeFontName(name).replace(/["\\]/g, "")}", ${FALLBACKS[fontKind(name)]}`;
}

/** Points as CSS pixels, to two places. */
const pixels = (points: number) => `${Math.round(((points * 4) / 3) * 100) / 100}px`;

/** A font as CSS: only what it sets. */
export function fontCss(font: FontStyle): CSSProperties {
  const css: CSSProperties = {};
  if (font.name) css.fontFamily = fontFamily(font.name);
  if (font.size) css.fontSize = pixels(font.size);
  if (font.bold) css.fontWeight = 700;
  if (font.italic) css.fontStyle = "italic";
  const lines = [font.underline ? "underline" : "", font.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  if (lines) css.textDecorationLine = lines;
  if (font.underline === "double") css.textDecorationStyle = "double";
  if (font.color) css.color = font.color;
  if (font.vertAlign) {
    css.verticalAlign = font.vertAlign === "superscript" ? "super" : "sub";
    css.fontSize = font.size ? pixels(font.size * 0.7) : "0.7em";
  }
  return css;
}

const LINES: Readonly<Record<string, [number, string]>> = {
  thin: [1, "solid"],
  medium: [2, "solid"],
  thick: [3, "solid"],
  double: [3, "double"],
  dashed: [1, "dashed"],
  dotted: [1, "dotted"],
  hair: [1, "dotted"],
  mediumDashed: [2, "dashed"],
  dashDot: [1, "dashed"],
  mediumDashDot: [2, "dashed"],
  dashDotDot: [1, "dotted"],
  mediumDashDotDot: [2, "dotted"],
  slantDashDot: [2, "dashed"],
};

/** An Excel border edge as a CSS border. */
export function borderCss(edge: BorderEdge): string {
  const [width, style] = LINES[edge.style] ?? [1, "solid"];
  return `${width}px ${style} ${edge.color}`;
}

/** The width an edge takes. */
export const borderWidth = (edge: BorderEdge): number => (LINES[edge.style] ?? [1])[0];

/** What is drawn on one edge of a cell: a border, Excel's light gridline, or nothing. */
export type Edge = BorderEdge | "grid" | null;

/**
 * The right and bottom edges of a cell, each drawn once for the two cells it
 * is between: a border either of them sets, else a gridline (when the sheet
 * shows them) unless a fill on either side covers it.
 */
export function cellEdges(
  self: CellStyle | undefined,
  right: CellStyle | undefined,
  below: CellStyle | undefined,
  gridlines: boolean,
): { right: Edge; bottom: Edge } {
  const filled = (style: CellStyle | undefined) => style?.fill !== undefined;
  const grid = (other: CellStyle | undefined): Edge =>
    gridlines && !filled(self) && !filled(other) ? "grid" : null;
  return {
    right: self?.border.right ?? right?.border.left ?? grid(right),
    bottom: self?.border.bottom ?? below?.border.top ?? grid(below),
  };
}
