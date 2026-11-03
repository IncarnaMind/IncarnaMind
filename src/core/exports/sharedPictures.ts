/**
 * A shared page's pictures come from the page saved when a Citation was made (../citedPages),
 * never from the Document's file: a PDF's page or a scan is cropped to at most a third of the
 * page around the quote, and a slide is shown whole. A saved page's long edge is 1,600 px, about
 * twice a card's width, so the crop stays sharp on a high-density screen.
 */
import type * as Y from "yjs";
import { type DrawnPage, type PageBox, type PageText, quoteBoxes } from "../../shared/citedPage";
import { anchorsOf, type UnitText } from "../../shared/units";
import type { CitationAttributes, CitationCheck } from "../api";
import { citedPageKey } from "../citedPages";
import startPictureWorker from "./pictureWorker?nodeWorker";

const MAX_WIDTH = 1600;
const WORKER_TIMEOUT_MS = 120_000;

/**
 * About what a picture weighs as WebP at the worker's quality, so the sheet can say the file's
 * size without drawing: per pixel, by how much of it text covers (measured on text pages from
 * sparse to dense); where the page has more than text, by its share of the saved picture's bytes.
 * A scan's grain makes its picture weigh about what its share of the saved page does.
 */
const BYTES_PER_PIXEL = { blank: 0.01, text: 0.34 };
const WEBP_SHARE: Readonly<Record<DrawnPage["type"], number>> = {
  "image/jpeg": 0.55,
  "image/png": 0.35,
};
const SCAN_SHARE = 1.1;

/** What the worker draws: part of a saved page, its quote washed or, contradicted, outlined. */
export interface PictureJob {
  image: Uint8Array;
  /** In the saved page's pixels. */
  area: PageBox;
  width: number;
  height: number;
  marks: PageBox[];
  tone: "wash" | "outline";
}

/** A picture the worker drew, or why it couldn't. */
export type PictureDrawn = { data: Uint8Array } | { failed: string };

export interface PicturePlan extends PictureJob {
  /** Citations whose plans share a key share a picture. */
  key: string;
  slide: boolean;
  /** About what the picture adds to the file, base64 included, in bytes. */
  bytes: number;
}

/** A Location shown as a picture: a PDF's page (a scan's too) or a slide. */
export const picturedKind = (attributes: Partial<CitationAttributes>): "page" | "slide" | null => {
  const kind = attributes.location?.kind;
  return kind === "page" || kind === "slide" ? kind : null;
};

/**
 * The picture a Citation's card shows, from its saved page; null where its quote can't be found
 * on a page, which then stays text. `units` are the cited Units, whose lines say where a scan's
 * text is, as its picture has none.
 */
export function planPicture(
  page: DrawnPage,
  attributes: Partial<CitationAttributes>,
  check: CitationCheck,
  units: readonly UnitText[],
): PicturePlan | null {
  const kind = picturedKind(attributes);
  if (!kind || check === "not-found") return null;
  const read = page.text.length > 0 ? page : { ...page, text: scannedText(page, units) };
  const marks = quoteBoxes(read, attributes.quote, attributes.location) ?? [];
  if (kind === "page" && marks.length === 0) return null;
  const area = kind === "slide" ? wholeOf(page) : cropAround(read, marks, pagesOf(attributes));
  const scale = Math.min(1, MAX_WIDTH / area.width);
  const width = Math.max(1, Math.round(area.width * scale));
  const height = Math.max(1, Math.round(area.height * scale));
  const tone = check === "contradicted" ? "outline" : "wash";
  const drawn = width * height;
  const covered = read.text.reduce((sum, run) => sum + overlap(run.box, area), 0);
  const byText = drawn * (BYTES_PER_PIXEL.blank + (BYTES_PER_PIXEL.text * covered) / areaOf(area));
  const saved = (page.data.length * drawn) / areaOf(wholeOf(page));
  const estimate =
    page.text.length === 0 ? saved * SCAN_SHARE : Math.max(byText, saved * WEBP_SHARE[page.type]);
  return {
    key: JSON.stringify([citedPageKey(attributes), area, marks, tone]),
    image: page.data,
    area,
    width,
    height,
    marks,
    tone,
    slide: kind === "slide",
    bytes: Math.ceil((estimate / 3) * 4),
  };
}

/** A scan's lines, boxed in the saved picture's pixels: its Units' pages, one under the other. */
function scannedText(page: DrawnPage, units: readonly UnitText[]): PageText[] {
  const height = page.height / Math.max(1, units.length);
  return units.flatMap((unit, index) =>
    anchorsOf(unit).flatMap(({ start, end, quad }) => {
      if (quad?.length !== 8) return [];
      const xs = quad.filter((_, at) => at % 2 === 0);
      const ys = quad.filter((_, at) => at % 2 === 1);
      const [left, top] = [Math.min(...xs), Math.min(...ys)];
      return [
        {
          text: unit.text.slice(start, end),
          breakAfter: true,
          box: {
            x: left * page.width,
            y: index * height + top * height,
            width: (Math.max(...xs) - left) * page.width,
            height: (Math.max(...ys) - top) * height,
          },
        },
      ];
    }),
  );
}

const areaOf = (box: PageBox) => Math.max(1, box.width * box.height);

function overlap(a: PageBox, b: PageBox): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return Math.max(0, width) * Math.max(0, height);
}

const wholeOf = (page: DrawnPage): PageBox => ({
  x: 0,
  y: 0,
  width: page.width,
  height: page.height,
});

function pagesOf({ pageFrom, pageTo }: Partial<CitationAttributes>): number {
  if (typeof pageFrom !== "number") return 1;
  return Math.max(1, (typeof pageTo === "number" ? pageTo : pageFrom) - pageFrom + 1);
}

/**
 * A band around the quote, a few lines either side, at least a sixth of a page and never more
 * than a third (#72): a quote taller than that shows from its start. Across, it keeps to the text
 * in the band, with a margin, so the words are as large as the card allows.
 */
function cropAround(page: DrawnPage, marks: readonly PageBox[], pages: number): PageBox {
  const pageHeight = page.height / pages;
  const third = Math.floor(pageHeight / 3);
  const top = Math.min(...marks.map((box) => box.y));
  const bottom = Math.max(...marks.map((box) => box.y + box.height));
  const margin = pageHeight / 16;
  const height = Math.min(third, Math.round(Math.max(bottom - top + 2 * margin, pageHeight / 6)));
  const wanted = bottom - top + 2 * margin > height ? top - margin : (top + bottom - height) / 2;
  const y = Math.round(Math.min(Math.max(wanted, 0), Math.max(page.height - height, 0)));
  const inBand = page.text
    .map((run) => run.box)
    .filter((box) => box.y + box.height > y && box.y < y + height)
    .concat(marks);
  const across = page.width / 32;
  const left = Math.max(0, Math.floor(Math.min(...inBand.map((box) => box.x)) - across));
  const right = Math.min(
    page.width,
    Math.ceil(Math.max(...inBand.map((box) => box.x + box.width)) + across),
  );
  return { x: left, y, width: right - left, height: Math.min(height, page.height) };
}

/** Draws the pictures in a worker, off the main thread, in order; one that fails says why. */
export function drawPictures(jobs: readonly PictureJob[]): Promise<PictureDrawn[]> {
  if (jobs.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const worker = startPictureWorker({ name: "incarnamind-share-pictures", workerData: jobs });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Drawing the shared page's pictures took too long."));
    }, WORKER_TIMEOUT_MS);
    worker.once("message", (result: { pictures?: PictureDrawn[] }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (result.pictures?.length === jobs.length) resolve(result.pictures);
      else reject(new Error("The shared page's picture worker gave back too few pictures."));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const TEXT_ONLY = "sharePageTextOnly";

export function textOnlyDocuments(settings: Y.Map<unknown>): string[] {
  const value = settings.get(TEXT_ONLY);
  return Array.isArray(value)
    ? value.filter((each): each is string => typeof each === "string")
    : [];
}

export function setTextOnlyDocuments(settings: Y.Map<unknown>, documentIds: readonly string[]) {
  if (documentIds.length > 0) settings.set(TEXT_ONLY, [...new Set(documentIds)]);
  else if (settings.has(TEXT_ONLY)) settings.delete(TEXT_ONLY);
}
