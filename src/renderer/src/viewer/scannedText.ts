/**
 * A PDF's scanned pages in the viewer (#397): the text read from each page's
 * picture, laid over the picture line by line as a text layer of transparent
 * runs, as pdf.js lays a page's own text, so the text can be selected and a
 * quote washed where it is on the page.
 */
import { useEffect, useState } from "react";
import type { Document } from "../../../core/api";
import type { TextPiece } from "../../../shared/quoteMatch";
import { core } from "../core";

/** One run of a scanned page's text layer: a line read, and where its box is on the page. */
export interface ScannedRun {
  /** Its text, with the space or tab that follows it in the line's row. */
  text: string;
  /** Its box's corners as fractions of the page: top-left, top-right, bottom-right, bottom-left (x, y). */
  quad: readonly number[];
  breakAfter: boolean;
}

export interface ScannedPage {
  runs: ScannedRun[];
  /** The runs as pieces of text, for finding a quote across them (see `findQuoteInPages`). */
  pieces: TextPiece[];
}

/** A page's stored text and its lines' anchors as runs and pieces, in reading order. */
export function scannedPage(
  text: string,
  anchors: readonly { start: number; end: number; quad?: number[] }[],
): ScannedPage {
  const runs: ScannedRun[] = [];
  const pieces: TextPiece[] = [];
  const lines = anchors.filter((anchor) => anchor.quad && anchor.quad.length === 8);
  lines.forEach((anchor, index) => {
    const next = lines[index + 1];
    const gap = text.slice(anchor.end, next ? next.start : text.length);
    const breakAfter = !next || gap.includes("\n");
    const run = text.slice(anchor.start, anchor.end) + (breakAfter ? "" : gap);
    runs.push({ text: run, quad: anchor.quad ?? [], breakAfter });
    pieces.push({ text: run, breakAfter });
  });
  return { runs, pieces };
}

/**
 * The scanned pages of the Document's current version, by page number:
 * read again when its version or status changes, as once its pages are read.
 */
export function useScannedPages(document: Document): ReadonlyMap<number, ScannedPage> {
  const [pages, setPages] = useState<ReadonlyMap<number, ScannedPage>>(() => new Map());
  const { id, contentHash, status } = document;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as its status changes, as when its pages have been read
  useEffect(() => {
    let current = true;
    core.readScannedText(id).then(
      (scanned) => {
        if (!current) return;
        // A PDF of text has none, and nothing to draw again.
        setPages((before) =>
          before.size === 0 && scanned.pages.length === 0
            ? before
            : new Map(
                scanned.pages.map(
                  (page) => [page.page, scannedPage(page.text, page.anchors)] as const,
                ),
              ),
        );
      },
      // Without its scanned text, a page shows its picture, as before it was read.
      (error: unknown) => console.error(error),
    );
    return () => {
      current = false;
    };
  }, [id, contentHash, status]);
  return pages;
}

let measuring: CanvasRenderingContext2D | null = null;

/** How wide `text` is at 100px in the sans-serif the runs are set in. */
function widthAt100(text: string): number {
  measuring ??= document.createElement("canvas").getContext("2d");
  if (!measuring) return text.length * 50;
  measuring.font = "100px sans-serif";
  return measuring.measureText(text).width || 1;
}

/**
 * The page's text layer for its scanned text: a `textLayer` of transparent
 * runs, each over its line's box, sized as pdf.js sizes its own (in the
 * page's units, scaled by the layer's `--scale-factor`), turned with the line.
 * `width` and `height` are the page's size at scale 1.
 */
export function scannedTextLayer(
  page: ScannedPage,
  width: number,
  height: number,
): { container: HTMLDivElement; divs: HTMLElement[]; strings: string[] } {
  const container = document.createElement("div");
  container.className = "textLayer";
  const divs: HTMLElement[] = [];
  const strings: string[] = [];
  for (const run of page.runs) {
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = run.quad;
    const length = Math.hypot((x1 - x0) * width, (y1 - y0) * height);
    const lineHeight = Math.max(1, Math.hypot((x3 - x0) * width, (y3 - y0) * height));
    const angle = Math.atan2((y1 - y0) * height, (x1 - x0) * width);
    const span = document.createElement("span");
    span.textContent = run.text;
    span.style.left = `${x0 * 100}%`;
    span.style.top = `${y0 * 100}%`;
    span.style.fontFamily = "sans-serif";
    span.style.setProperty("--font-height", `${lineHeight}px`);
    span.style.setProperty("--rotate", `${angle}rad`);
    span.style.setProperty(
      "--scale-x",
      String(length / ((widthAt100(run.text.trimEnd()) * lineHeight) / 100)),
    );
    container.append(span);
    // A line's end, as pdf.js marks it in its own layer: what the User selects reads as the page's text.
    if (run.breakAfter) container.append(document.createElement("br"));
    divs.push(span);
    strings.push(run.text);
  }
  return { container, divs, strings };
}
