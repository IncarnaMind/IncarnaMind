/**
 * The text a drawn slide shows, as pieces a Citation's quote is looked for
 * in with the check's own matcher (`findQuoteInPieces`), so the highlight
 * and the check agree. Each run of text is a piece, keyed by where the
 * renderer draws it; a paragraph, a cell or a line break ends a line.
 *
 * Only the slide's own text counts (its layout's and master's text isn't in
 * the slide's Unit), in the Unit's order: the title, the other shapes in
 * z-order (into groups), then tables, row by row.
 */
import type { Item, SlideDrawing, TextBody } from "../../../../core/documents/formats/pptxDrawing";
import { findQuoteInPieces, type TextPiece, type TextRange } from "../../../../shared/quoteMatch";

/** Where the renderer draws a run: the item's path, the paragraph's index and the run's. */
export const runKey = (path: string, paragraph: number, run: number): string =>
  `${path}:${paragraph}:${run}`;

/** A table cell's path, under its table's. */
export const cellPath = (path: string, row: number, column: number): string =>
  `${path}/${row}.${column}`;

/** A group's child's path, under its group's. */
export const childPath = (path: string, index: number): string => `${path}.${index}`;

interface KeyedPiece extends TextPiece {
  key: string;
}

function bodyPieces(body: TextBody, path: string, into: KeyedPiece[]): void {
  for (const [p, paragraph] of body.paragraphs.entries()) {
    let last: KeyedPiece | undefined;
    for (const [r, run] of paragraph.runs.entries()) {
      if (run.lineBreak) {
        if (last) last.breakAfter = true;
        continue;
      }
      if (!run.text) continue;
      last = { key: runKey(path, p, r), text: run.text, breakAfter: false };
      into.push(last);
    }
    if (last) last.breakAfter = true;
  }
}

function collect(
  items: readonly Item[],
  prefix: string | null,
  into: { titles: KeyedPiece[]; shapes: KeyedPiece[]; tables: KeyedPiece[] },
): void {
  for (const [index, item] of items.entries()) {
    if (item.origin !== "slide") continue;
    const path = prefix === null ? String(index) : childPath(prefix, index);
    switch (item.kind) {
      case "shape":
        if (item.text) bodyPieces(item.text, path, item.title ? into.titles : into.shapes);
        break;
      case "group":
        collect(item.children, path, into);
        break;
      case "table":
        for (const [r, row] of item.rows.entries()) {
          for (const [c, cell] of row.cells.entries()) {
            if (!cell.merged) bodyPieces(cell.text, cellPath(path, r, c), into.tables);
          }
        }
        break;
    }
  }
}

/** A slide's pieces, in the Unit's order. */
export function slidePieces(slide: SlideDrawing): KeyedPiece[] {
  const into = { titles: [], shapes: [], tables: [] } as {
    titles: KeyedPiece[];
    shapes: KeyedPiece[];
    tables: KeyedPiece[];
  };
  collect(slide.items, null, into);
  return [...into.titles, ...into.shapes, ...into.tables];
}

/** Where a quote is in a drawn slide: its highlighted parts, by run key; null if it isn't there. */
export function findInDrawing(slide: SlideDrawing, quote: string): Map<string, TextRange[]> | null {
  return rangesByKey(slidePieces(slide), quote);
}

/**
 * Where a quote is in pieces with keys: its parts, by key; null if it isn't
 * there. Its figures are matched as the check matches a slide's, however
 * their thousands are written when the quote isn't found as it is.
 */
export function rangesByKey(
  pieces: readonly KeyedPiece[],
  quote: string,
): Map<string, TextRange[]> | null {
  if (pieces.length === 0) return null;
  const found = findQuoteInPieces(pieces, quote, { numbers: "if-needed" });
  if (!found || found.length === 0) return null;
  const byKey = new Map<string, TextRange[]>();
  for (const part of found) {
    const key = (pieces[part.piece] as KeyedPiece).key;
    byKey.set(key, [...(byKey.get(key) ?? []), { start: part.start, end: part.end }]);
  }
  return byKey;
}

/** The package parts of every picture a drawing shows, its backgrounds' and fills' too. */
export function pictureParts(slide: SlideDrawing): string[] {
  const parts: string[] = [];
  if (slide.background.kind === "image") parts.push(slide.background.part);
  const walk = (items: readonly Item[]) => {
    for (const item of items) {
      if (item.kind === "picture" && item.part) parts.push(item.part);
      if (item.kind === "shape" && item.fill.kind === "image") parts.push(item.fill.part);
      if (item.kind === "group") walk(item.children);
      if (item.kind === "table") {
        for (const row of item.rows) {
          for (const cell of row.cells) if (cell.fill.kind === "image") parts.push(cell.fill.part);
        }
      }
    }
  };
  walk(slide.items);
  return parts;
}
