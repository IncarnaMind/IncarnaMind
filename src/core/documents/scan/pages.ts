/**
 * Which pages of a PDF are scans, and their pictures (#397). Runs in the
 * processing worker, on the PDF pdf.js has open for its text.
 *
 * A page is read from its picture when it has too little text for its size
 * and pictures cover most of it: a scan, or a scan with a stamp or a page
 * number on it. A page of text is left as it is; so is a blank page, or a
 * drawing with no picture in it. A scan that already has a text layer
 * (scanned and recognised by the scanner) is a page of text.
 */
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import type { PagePicture } from "../../adapters";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** Fewer characters than this on an A4 page (in proportion on others) is too little text. */
export const MIN_PAGE_TEXT = 100;
/** Pictures must cover at least this share of a page for it to be read as a scan. */
export const MIN_PICTURE_SHARE = 0.5;
/** Pages are drawn for reading at this resolution, in dots per inch… */
export const READING_DPI = 200;
/** …but no larger than this on their longer side, in pixels. */
export const MAX_PICTURE_SIDE = 3000;

/** An A4 page's area, in PDF points. */
const A4_AREA = 595 * 842;

type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: readonly number[]): Matrix => {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = n;
  return [
    a * m[0] + b * m[2],
    a * m[1] + b * m[3],
    c * m[0] + d * m[2],
    c * m[1] + d * m[3],
    e * m[0] + f * m[2] + m[4],
    e * m[1] + f * m[3] + m[5],
  ];
};

/** The area a picture covers, drawn through this matrix: it fills the unit square. */
const area = (m: Matrix) => Math.abs(m[0] * m[3] - m[1] * m[2]);

/** The transforms of a grouped picture's entries, each drawn as its own picture. */
const entryTransforms = (entries: unknown): number[][] =>
  Array.isArray(entries)
    ? entries.flatMap((entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "transform" in entry &&
        Array.isArray(entry.transform)
          ? [entry.transform as number[]]
          : [],
      )
    : [];

/** The placements of a repeated picture: its matrix at each position (x, y pairs). */
const placements = (scale: number[], positions: unknown): number[][] => {
  if (!positions || typeof positions !== "object" || !("length" in positions)) return [];
  const xy = Array.from(positions as ArrayLike<number>);
  const out: number[][] = [];
  for (let i = 0; i + 1 < xy.length; i += 2) out.push([...scale, xy[i] ?? 0, xy[i + 1] ?? 0]);
  return out;
};

/** How much of the page its pictures cover, from 0 to 1, as they are drawn (overlaps counted twice). */
export async function pictureShare(
  page: Pick<PDFPageProxy, "view" | "getOperatorList">,
  ops: PdfJs["OPS"],
): Promise<number> {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
  const pageArea = Math.abs((x1 - x0) * (y1 - y0));
  if (pageArea === 0) return 0;
  const { fnArray, argsArray } = await page.getOperatorList();
  const stack: Matrix[] = [];
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  let covered = 0;
  const pictures = new Set<number>([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
  ]);
  fnArray.forEach((op, index) => {
    const args = argsArray[index] as unknown[] | null;
    // pdf.js draws runs of small pictures as one group, and one picture drawn again and
    // again as a repeat: a scan in strips comes this way, so each is counted where it's drawn.
    let drawn: number[][] = [];
    if (op === ops.save) stack.push(matrix);
    else if (op === ops.restore) matrix = stack.pop() ?? matrix;
    else if (op === ops.transform && Array.isArray(args))
      matrix = multiply(matrix, args as number[]);
    else if (op === ops.paintFormXObjectBegin) {
      stack.push(matrix);
      const formMatrix = Array.isArray(args) ? args[0] : null;
      if (Array.isArray(formMatrix)) matrix = multiply(matrix, formMatrix as number[]);
    } else if (op === ops.paintFormXObjectEnd) matrix = stack.pop() ?? matrix;
    else if (pictures.has(op)) covered += area(matrix);
    else if (op === ops.paintInlineImageXObjectGroup && Array.isArray(args))
      drawn = entryTransforms(args[1]);
    else if (op === ops.paintImageMaskXObjectGroup && Array.isArray(args))
      drawn = entryTransforms(args[0]);
    else if (op === ops.paintImageXObjectRepeat && Array.isArray(args)) {
      const [, scaleX = 1, scaleY = 1, positions] = args as [unknown, number, number, unknown];
      drawn = placements([scaleX, 0, 0, scaleY], positions);
    } else if (op === ops.paintImageMaskXObjectRepeat && Array.isArray(args)) {
      const [, a = 1, b = 0, c = 0, d = 1, positions] = args as [
        unknown,
        number,
        number,
        number,
        number,
        unknown,
      ];
      drawn = placements([a, b, c, d], positions);
    }
    for (const transform of drawn) covered += area(multiply(matrix, transform));
  });
  return Math.min(1, covered / pageArea);
}

/** How many characters of text a page has, spaces aside. */
const characters = (text: string) => text.replace(/\s+/g, "").length;

/** Whether a page is a scan to read (see the module comment). */
export async function isScanned(
  page: PDFPageProxy,
  text: string,
  ops: PdfJs["OPS"],
): Promise<boolean> {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
  const size = Math.abs((x1 - x0) * (y1 - y0));
  if (characters(text) >= MIN_PAGE_TEXT * Math.max(size / A4_AREA, 0.25)) return false;
  return (await pictureShare(page, ops)) >= MIN_PICTURE_SHARE;
}

/** Whether the page draws its text invisibly (mode 3), as a recognizer's searchable layer does. */
export async function invisibleText(
  page: Pick<PDFPageProxy, "getOperatorList">,
  ops: PdfJs["OPS"],
): Promise<boolean> {
  const { fnArray, argsArray } = await page.getOperatorList();
  const shows = new Set([
    ops.showText,
    ops.showSpacedText,
    ops.nextLineShowText,
    ops.nextLineSetSpacingShowText,
  ]);
  let mode = 0;
  for (let index = 0; index < fnArray.length; index++) {
    const op = fnArray[index] ?? 0;
    const args = argsArray[index] as unknown[] | null;
    if (op === ops.setTextRenderingMode && Array.isArray(args)) mode = Number(args[0]);
    else if (shows.has(op) && mode === 3) return true;
  }
  return false;
}

/** pdf.js's Node canvas (@napi-rs/canvas), as much of it as reading needs. */
type Canvas = NonNullable<Parameters<PDFPageProxy["render"]>[0]["canvas"]> & {
  getContext(kind: "2d"): {
    getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
  };
};

/** The PDF document's own canvas factory (`PDFDocumentProxy.canvasFactory`). */
export interface CanvasFactory {
  create(width: number, height: number): { canvas: Canvas };
  destroy(surface: { canvas: Canvas }): void;
}

/** A page drawn as it shows, turned as the PDF says, in shades of grey, for reading. */
export async function pagePicture(
  page: PDFPageProxy,
  factory: CanvasFactory,
): Promise<PagePicture> {
  const natural = page.getViewport({ scale: 1 });
  const scale = Math.min(
    READING_DPI / 72,
    MAX_PICTURE_SIDE / Math.max(natural.width, natural.height, 1),
  );
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const surface = factory.create(width, height);
  try {
    await page.render({ canvas: surface.canvas, viewport, background: "white" }).promise;
    const context = surface.canvas.getContext("2d");
    if (!context) throw new Error("The page couldn't be drawn.");
    const { data } = context.getImageData(0, 0, width, height);
    return { width, height, pixels: greys(data) };
  } finally {
    factory.destroy(surface);
  }
}

export function greys(data: Uint8ClampedArray): Uint8Array {
  const pixels = new Uint8Array(data.length / 4);
  for (let index = 0; index < pixels.length; index++) {
    pixels[index] = Math.round(
      0.299 * (data[index * 4] as number) +
        0.587 * (data[index * 4 + 1] as number) +
        0.114 * (data[index * 4 + 2] as number),
    );
  }
  return pixels;
}
