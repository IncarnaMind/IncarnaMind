/**
 * A cited page, as the core saves it (#133), and what the main process and
 * the hidden window that draws one say to each other: the channels, and the
 * bridge the window's preload gives its page.
 */
import type { CitationLocation, Document } from "../core/api";
import {
  findQuoteInPieces,
  type MatchOptions,
  type PieceRange,
  type TextPiece,
} from "./quoteMatch";

/** A box on a cited page's picture, from its top left corner. */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A run of the text drawn on a cited page, and where it is drawn. */
export interface PageText extends TextPiece {
  box: PageBox;
}

/** A cited page as drawn, to save. */
export interface DrawnPage {
  /** The picture: JPEG for a PDF's pages, PNG for a page a viewer drew. */
  data: Uint8Array;
  type: "image/jpeg" | "image/png";
  /** Its size, in pixels. */
  width: number;
  height: number;
  /** The text drawn on it, in reading order, boxed in its pixels: where a quote is found, to highlight it. */
  text: PageText[];
}

/** How a Location's text is matched: number formatting is normalised in sheets and, if needed, slides. */
function matchOptions(location: CitationLocation | null): MatchOptions {
  return {
    numbers: location?.kind === "rows" ? true : location?.kind === "slide" ? "if-needed" : false,
  };
}

const sameLine = (a: PageBox, b: PageBox) =>
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > Math.min(a.height, b.height) / 2;

/** The boxes of the parts of the text's runs a quote covers, one for each line. */
function boxesOf(text: DrawnPage["text"], ranges: readonly PieceRange[]): PageBox[] {
  const lines: PageBox[] = [];
  for (const { piece, start, end } of ranges) {
    const run = text[piece];
    if (!run || run.text.length === 0) continue;
    const { box } = run;
    const part = {
      x: box.x + (box.width * start) / run.text.length,
      y: box.y,
      width: (box.width * (end - start)) / run.text.length,
      height: box.height,
    };
    const last = lines.at(-1);
    if (last && sameLine(last, part)) {
      const x = Math.min(last.x, part.x);
      const y = Math.min(last.y, part.y);
      lines[lines.length - 1] = {
        x,
        y,
        width: Math.max(last.x + last.width, part.x + part.width) - x,
        height: Math.max(last.y + last.height, part.y + part.height) - y,
      };
    } else {
      lines.push(part);
    }
  }
  return lines;
}

/**
 * Where a Citation's quote is on its saved page, from the text drawn on it, in
 * the page's pixels: one box for each line. Null where the quote isn't found
 * there (a scan, or a page drawn without its text).
 */
export function quoteBoxes(
  page: DrawnPage,
  quote: string | null | undefined,
  location: CitationLocation | null | undefined,
): PageBox[] | null {
  if (!quote) return null;
  const options = matchOptions(location ?? null);
  const ranges =
    findQuoteInPieces(page.text, quote, options) ??
    findQuoteInPieces(page.text, quote, { ...options, lostLigatures: true });
  const boxes = ranges ? boxesOf(page.text, ranges) : [];
  return boxes.length > 0 ? boxes : null;
}

/**
 * What a cited page shows of its Units: the rows a sheet's Citation covers,
 * or all of them, for every other kind of Location.
 */
export type PageArea =
  | { kind: "rows"; sheet: string | null; from: number; to: number }
  | { kind: "page" | "slide" | "section" | "lines" | "time" };

/** A cited page to draw: the cited Units of a Document, as its file is now. */
export interface PageCaptureRequest {
  document: Document;
  /** The cited Units, from 1. */
  pageFrom: number;
  pageTo: number;
  area: PageArea;
}

/**
 * The hidden window shares the app's preload, which gives it the core and
 * `window.incarnamindCitedPage` for this argument, in place of the file helpers.
 */
export const CITED_PAGE_ARGUMENT = "--incarnamind-cited-page";
export const CITED_PAGE_BRIDGE_KEY = "incarnamindCitedPage";

export const CITED_PAGE_CHANNELS = {
  /** Page → main: what to draw (`PageCaptureRequest`). */
  request: "citedPage:request",
  /** Page → main: make the page this tall, in CSS pixels; resolves with the height it gets. */
  resize: "citedPage:resize",
  /** Page → main: the cited area is drawn (`CitedPageLayout`). */
  drawn: "citedPage:drawn",
  /** Page → main: it can't be drawn, and why. */
  failed: "citedPage:failed",
} as const;

/** Where the cited area is drawn, in CSS pixels of the page, with the text in it, boxed from its corner. */
export interface CitedPageLayout {
  rect: PageBox;
  text: PageText[];
}

export interface CitedPageBridge {
  request(): Promise<PageCaptureRequest>;
  resize(height: number): Promise<number>;
  drawn(layout: CitedPageLayout): void;
  failed(reason: string): void;
}
