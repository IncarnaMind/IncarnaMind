/**
 * Extracts a Document's text as Units (ADR-0011): a PDF's pages with pdf.js,
 * every other kind with our own readers (./formats). Runs in the processing
 * worker: parsing a large PDF takes seconds. A PDF's scanned pages are read
 * from their pictures (#397), when reading is given.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { readPdfPageText } from "../../shared/pdfFormText";
import { CJK } from "../../shared/text";
import type { Anchor, TextUnit } from "../../shared/units";
import type { LogFields, PagePicture, PictureRead, RecognizedLine } from "../adapters";
import type { DocumentKind, UnreadParts } from "../api";
import { isRecord } from "../errors";
import { ExtractionError, extractUnits } from "./formats";
import { type FigureReading, readWebPage, webUnits } from "./formats/web";
import { extractXlsx, unreadPartsOf } from "./formats/xlsx";
import { passwordProblem } from "./pdfPasswords";
import { printedPageNames } from "./printedPages";
import { scannedUnit } from "./scan/layout";
import { type CanvasFactory, isScanned, pagePicture } from "./scan/pages";
import { anchorsBack, readWithQuarterTurn } from "./scan/rotation";
import { findTables, type TableGrid, textItemOf, textLayerRows } from "./tables";
import { unreadMessage } from "./unreadMessage";
import { PICTURE_LIMITS, pictureSize, pictureType } from "./web/pictures";

export { ExtractionError };

/** Reading a PDF's scanned pages (#397), as the processing worker is given it. */
export interface PageReading {
  /** What reads them now (`UnitScan.reader`). */
  reader: string;
  /** Pages of this version read already, used as they are, by page number. */
  keep: ReadonlyMap<number, TextUnit>;
  /** The lines on a page's picture. Rejects with `ReadingUnavailable` when no page can be read now. */
  read(page: number, picture: PagePicture): Promise<RecognizedLine[]>;
  /** As `read`, for a picture file, decoded where the model runs. */
  readFile(page: number, file: Uint8Array): Promise<PictureRead>;
  /** Logs in the core, with the Document's id: the worker's own console reaches no log. */
  log(event: string, fields: LogFields): void;
  /** `read` of `of` scanned pages are read; `unit` is the one just read. */
  progress(read: number, of: number, unit: TextUnit | null): void;
  /** Aborted when the job is stopped: no further page is read. */
  signal: AbortSignal;
}

/** No scanned page can be read now: the text recognition model can't be downloaded or started. */
export class ReadingUnavailable extends Error {
  override name = "ReadingUnavailable";
}

export interface ExtractedText {
  /** PDFs only. */
  pageCount: number | null;
  units: TextUnit[];
  /** PDF pages with unread content, and why; null when all could be read. */
  unread: { pages: number[]; message: string; forms?: true } | null;
  /** What of the file wasn't read when the rest was (#740): a workbook's hidden sheets and rows; null when all was. */
  parts: UnreadParts | null;
}

/**
 * `password`: what opens a locked PDF, from ./pdfPasswords (#763).
 * `readPicture`: a saved web page's picture, by its path in the snapshot,
 * whose text is read when `reading` is given.
 */
export async function extractText(
  kind: DocumentKind,
  bytes: Uint8Array,
  reading: PageReading | null = null,
  password?: string,
  readPicture: ((src: string) => Promise<Uint8Array>) | null = null,
): Promise<ExtractedText> {
  if (kind === "pdf") return extractPdf(bytes, reading, password);
  if (kind === "web" && reading && readPicture) {
    return {
      pageCount: null,
      units: await extractWeb(bytes, reading, readPicture),
      unread: null,
      parts: null,
    };
  }
  if (kind === "xlsx") {
    const { units, workbook } = await extractXlsx(bytes);
    return { pageCount: null, units, unread: null, parts: unreadPartsOf(workbook) };
  }
  return { pageCount: null, units: await extractUnits(kind, bytes), unread: null, parts: null };
}

/**
 * A web page's Units with its saved pictures' text read. A picture that
 * isn't one to read, or that fails to decode or read, keeps its description
 * alone; once the model can't be had, the pictures left are marked unread.
 */
async function extractWeb(
  bytes: Uint8Array,
  reading: PageReading,
  readPicture: (src: string) => Promise<Uint8Array>,
): Promise<TextUnit[]> {
  const source = new TextDecoder().decode(bytes);
  const readings = new Map<number, FigureReading>();
  const figures = readWebPage(source).blocks.flatMap((block) =>
    block.figure === undefined
      ? []
      : [{ number: block.figure, src: block.element.attrs.src ?? "" }],
  );
  const unread: FigureReading = { reader: reading.reader, text: "", lines: [], unread: true };
  let unavailable = false;
  if (figures.length > 0) reading.progress(0, figures.length, null);
  for (const [index, figure] of figures.entries()) {
    reading.signal.throwIfAborted();
    if (unavailable) {
      readings.set(figure.number, unread);
      continue;
    }
    try {
      const read = await readFigure(figure.number, figure.src, reading, readPicture);
      if (read) readings.set(figure.number, read);
    } catch (error) {
      reading.signal.throwIfAborted();
      if (error instanceof ReadingUnavailable) {
        unavailable = true;
        readings.set(figure.number, unread);
      } else {
        // Marked unread, it would be read again at every start, and fail again.
        reading.log("documents.pictureNotRead", {
          picture: figure.src,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    reading.progress(index + 1, figures.length, null);
  }
  return webUnits(source, readings);
}

async function readFigure(
  number: number,
  src: string,
  reading: PageReading,
  readPicture: (src: string) => Promise<Uint8Array>,
): Promise<FigureReading | null> {
  const file = await readPicture(src);
  const type = pictureType(file);
  const size = type && pictureSize(file, type);
  if (!size || size.width * size.height > PICTURE_LIMITS.maxPixels) {
    reading.log("documents.pictureNotRead", {
      picture: src,
      message: size ? `${size.width} × ${size.height} pixels` : "not a picture",
    });
    return null;
  }
  const picture = await reading.readFile(number, file);
  const read = scannedUnit(number, picture.lines, picture, reading.reader);
  const unsure = read.label?.scan?.unsure;
  return {
    reader: reading.reader,
    text: read.text,
    lines: (read.anchors ?? []).map(({ start, end, quad }) => ({ start, end, quad: quad ?? [] })),
    ...(unsure && { unsure }),
  };
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjs: Promise<PdfJs> | undefined;

/** pdf.js's Node-compatible ("legacy") build, loaded on first use. */
const loadPdfJs = () => {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
};

/**
 * pdf.js reads character maps (for CJK fonts), standard font data, and the
 * decoders a scan's pictures may need (JPEG 2000, JBIG2) from its package folder.
 */
function pdfjsDataUrls() {
  const packageDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  return {
    cMapUrl: `${join(packageDir, "cmaps")}/`,
    standardFontDataUrl: `${join(packageDir, "standard_fonts")}/`,
    wasmUrl: `${join(packageDir, "wasm")}/`,
  };
}

/** A scan's picture larger than this many pixels isn't drawn: reading it would take too much memory. */
const MAX_PICTURE_PIXELS = 50_000_000;

// Lines inside a paragraph of CJK text: a PDF breaks them anywhere, and the break isn't a space.
const CJK_LINE_WRAP = new RegExp(`([${CJK}])[^\\S\\n]*\\n[^\\S\\n]*(?=[${CJK}])`, "gu");

function pageText(items: readonly object[]): string {
  let text = "";
  for (const item of items) {
    // Marked-content boundaries carry no text.
    if (!("str" in item) || typeof item.str !== "string") continue;
    text += item.str;
    if ("hasEOL" in item && item.hasEOL === true) text += "\n";
  }
  return text.replaceAll("\u0000", "").replace(/\r\n?/g, "\n").replace(CJK_LINE_WRAP, "$1").trim();
}

/** A line of a page as printed, with its largest font size in points. */
export interface PageLine {
  text: string;
  size: number;
  /** How far down the page its baseline is, from 0 at the top to 1 at the foot. */
  top: number;
}

/**
 * A page's lines across it, in the order pdf.js reads them. Text set at an angle (arXiv's stamp
 * up the margin) is left out: it is no line of the page's own.
 */
function pageLines(items: readonly object[], height: number): PageLine[] {
  const lines: PageLine[] = [];
  let text = "";
  let size = 0;
  let baseline: number | null = null;
  const end = () => {
    const tidy = text.replaceAll("\u0000", "").replace(/\s+/g, " ").trim();
    if (tidy !== "" && size > 0 && baseline !== null) {
      const top = height > 0 ? Math.min(1, Math.max(0, 1 - baseline / height)) : 0;
      lines.push({ text: tidy, size, top });
    }
    text = "";
    size = 0;
    baseline = null;
  };
  for (const item of items) {
    const placed = textItemOf(item);
    if (!placed) continue;
    if (placed.level) {
      text += placed.str;
      if (placed.str.trim() !== "") {
        size = Math.max(size, Math.round(placed.fontSize * 10) / 10);
        baseline ??= placed.baseline;
      }
    }
    if (placed.eol) end();
  }
  end();
  return lines;
}

/** XMP's creation date, written as an element or as an attribute of its description. */
const XMP_CREATE_DATE = /xmp:CreateDate\s*(?:=\s*(["'])([^"'<>]*)\1|>([^<]*)<)/i;

/** What a PDF says of itself, as `pdfMetadata` reads it. */
export interface PdfMetadata {
  /** Its Info dictionary's CreationDate, a PDF date string. */
  info: string | null;
  /** Its XMP metadata's xmp:CreateDate, an ISO 8601 date. */
  xmp: string | null;
  /** Its Info dictionary's Title (#213). */
  title: string | null;
  /** Its Info dictionary's Author (#286). */
  author: string | null;
  /** Its XMP metadata packet, as written (#286). */
  xmpPacket: string | null;
  /** The text of its first `pages` pages, as extracted, running headers and all (#286). */
  firstPages: string[];
  /** Its first page's lines, where a title, its authors and a date are printed. */
  firstPageLines: PageLine[];
}

/**
 * A PDF's metadata as written: its document information dictionary's
 * CreationDate (#53), Title (#213) and Author, and its XMP metadata, whose
 * xmp:CreateDate is read here; never its ModDate. Its first page's lines, and
 * with `pages`, the text of its first pages too (#286: a DOI or an arXiv id is
 * printed there). Throws if the PDF can't be opened.
 */
export async function pdfMetadata(
  bytes: Uint8Array,
  pages = 0,
  password?: string,
): Promise<PdfMetadata> {
  const { getDocument } = await loadPdfJs();
  // pdf.js may take ownership of the buffer, so give it a copy.
  const task = getDocument({
    data: new Uint8Array(bytes),
    ...(password !== undefined && { password }),
    ...pdfjsDataUrls(),
    cMapPacked: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const { info, metadata } = await document.getMetadata();
    const raw = metadata ? String(metadata.getRaw()) : null;
    const xmp = raw ? XMP_CREATE_DATE.exec(raw) : null;
    const entry = (name: string) => {
      const value = isRecord(info) ? info[name] : undefined;
      return typeof value === "string" ? value : null;
    };
    const firstPages: string[] = [];
    let firstPageLines: PageLine[] = [];
    for (let number = 1; number <= Math.min(Math.max(pages, 1), document.numPages); number++) {
      const page = await document.getPage(number);
      const { items } = await page.getTextContent();
      if (number <= pages) firstPages.push(pageText(items));
      if (number === 1) firstPageLines = pageLines(items, page.getViewport({ scale: 1 }).height);
      page.cleanup();
    }
    return {
      info: entry("CreationDate"),
      xmp: xmp ? (xmp[2] ?? xmp[3] ?? null) : null,
      title: entry("Title"),
      author: entry("Author"),
      xmpPacket: raw,
      firstPages,
      firstPageLines,
    };
  } finally {
    await task.destroy();
  }
}

/** A part of a page as Verify lays it out (#1368): its text, or a table. */
export type PagePart = { kind: "text"; text: string } | { kind: "table"; grid: TableGrid };

/** A page's text around its tables, in reading order; null when it has none. */
export function textLayerParts(items: readonly object[]): PagePart[] | null {
  const rows = textLayerRows(items);
  const tables = findTables(rows);
  if (tables.length === 0) return null;
  const tableOf = new Map<object, (typeof tables)[number]>();
  tables.forEach((table) => {
    for (const row of rows.slice(table.first, table.last + 1)) {
      for (const item of row.items) tableOf.set(item, table);
    }
  });
  const parts: PagePart[] = [];
  const shown = new Set<(typeof tables)[number]>();
  let text: object[] = [];
  const flush = () => {
    const words = pageText(text);
    if (words !== "") parts.push({ kind: "text", text: words });
    text = [];
  };
  for (const item of items) {
    const table = tableOf.get(item);
    if (!table) {
      text.push(item);
      continue;
    }
    if (shown.has(table)) continue;
    flush();
    shown.add(table);
    parts.push({ kind: "table", grid: table.grid });
  }
  flush();
  return parts;
}

/** The pages of a PDF's text layer that hold a table, each as its parts. Throws if it can't be opened. */
export async function pdfTablePages(
  bytes: Uint8Array,
  password?: string,
): Promise<Map<number, PagePart[]>> {
  const { getDocument } = await loadPdfJs();
  const task = getDocument({
    data: new Uint8Array(bytes),
    ...(password !== undefined && { password }),
    ...pdfjsDataUrls(),
    cMapPacked: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const pages = new Map<number, PagePart[]>();
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const parts = textLayerParts((await page.getTextContent()).items);
      page.cleanup();
      if (parts) pages.set(number, parts);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/**
 * Whether `password` opens a PDF (#763); without one, whether it opens as it
 * is. False when it doesn't. Throws when the PDF can't be opened for another reason.
 */
export async function pdfOpensWith(bytes: Uint8Array, password?: string): Promise<boolean> {
  const { getDocument } = await loadPdfJs();
  // pdf.js may take ownership of the buffer, so give it a copy.
  const task = getDocument({
    data: new Uint8Array(bytes),
    ...(password !== undefined && { password }),
    verbosity: 0,
  });
  try {
    await task.promise;
    return true;
  } catch (error) {
    if (passwordProblem(error)) return false;
    throw error;
  } finally {
    await task.destroy();
  }
}

/** Whether a PDF needs a password to open (#763). */
export const pdfIsLocked = async (bytes: Uint8Array): Promise<boolean> =>
  !(await pdfOpensWith(bytes));

async function extractPdf(
  bytes: Uint8Array,
  reading: PageReading | null,
  password: string | undefined,
): Promise<ExtractedText> {
  const { getDocument, OPS } = await loadPdfJs();
  const task = getDocument({
    // pdf.js may take ownership of the buffer, so give it a copy.
    data: new Uint8Array(bytes),
    ...(password !== undefined && { password }),
    ...pdfjsDataUrls(),
    cMapPacked: true,
    disableFontFace: true,
    useSystemFonts: false,
    maxImageSize: MAX_PICTURE_PIXELS,
    verbosity: 0, // errors only
  });
  try {
    const document = await task.promise;
    const pages: TextUnit[] = [];
    const scanned: number[] = [];
    const scanFields = new Map<number, { text: string; anchors: Anchor[] }>();
    const unreadForms: number[] = [];
    const metadata = await document.getMetadata();
    const xfa = isRecord(metadata.info) && metadata.info.IsXFAPresent === true;
    const signatures = await document.getSignatures();
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const {
        content,
        source,
        fields,
        unread: formUnread,
      } = await readPdfPageText(page, signatures);
      if (formUnread || xfa) unreadForms.push(number);
      const text = pageText(content.items);
      pages.push({ page: number, kind: "page", label: null, text, anchors: null });
      if (reading && (await isScanned(page, pageText(source.items), OPS))) {
        scanned.push(number);
        if (fields.length > 0) scanFields.set(number, scannedFormFields(page, fields));
      }
      page.cleanup();
    }
    const unreadScans =
      reading && scanned.length > 0
        ? await readScannedPages(document, pages, scanned, reading, scanFields)
        : null;
    const unread =
      unreadForms.length > 0
        ? {
            pages: [...new Set([...unreadForms, ...(unreadScans?.pages ?? [])])],
            message: [
              "Some PDF form fields could not be read. Print to PDF in the app that created it, then add that copy.",
              ...(unreadScans ? [unreadMessage(unreadScans)] : []),
            ].join(" "),
            forms: true as const,
          }
        : unreadScans;
    const names = printedPageNames(
      await document.getPageLabels(),
      pages.map((unit) => unit.text),
    );
    const units = pages.map((unit, index) => withPrintedName(unit, names[index] ?? null));
    return { pageCount: pages.length, units, unread, parts: null };
  } catch (error) {
    if (reading?.signal.aborted) throw reading.signal.reason;
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "PasswordException") {
      throw new ExtractionError("password-protected", `The PDF needs a password: ${message}`);
    }
    throw new ExtractionError("unreadable", `The PDF couldn't be read: ${message}`);
  } finally {
    await task.destroy();
  }
}

function withPrintedName(unit: TextUnit, name: string | null): TextUnit {
  // A scanned page kept from an earlier read has the name that read gave it.
  const { printed: _earlier, ...label } = unit.label ?? {};
  const named = name === null ? label : { ...label, printed: name };
  return { ...unit, label: Object.keys(named).length > 0 ? named : null };
}

/**
 * Reads the scanned pages of a PDF into `pages`, in order: each kept page as
 * it was, the others from their pictures. A page that can't be read keeps
 * its text layer, marked unread; once the model can't be had, neither can
 * the pages after. Throws the signal's reason when the job is stopped.
 */
async function readScannedPages(
  document: Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>,
  pages: TextUnit[],
  scanned: readonly number[],
  reading: PageReading,
  fields: ReadonlyMap<number, { text: string; anchors: Anchor[] }>,
): Promise<ExtractedText["unread"]> {
  const factory = document.canvasFactory as CanvasFactory;
  const unread: number[] = [];
  let message: string | null = null;
  let unavailable = false;
  reading.progress(0, scanned.length, null);
  for (const [index, number] of scanned.entries()) {
    reading.signal.throwIfAborted();
    const at = number - 1;
    const layer = pages[at] as TextUnit;
    let unit = reading.keep.get(number) ?? null;
    if (!unit && !unavailable) {
      const page = await document.getPage(number);
      try {
        const picture = await pagePicture(page, factory);
        const oriented = await readWithQuarterTurn(picture, page.rotate, async (readingPicture) => {
          // The core answers no read for a job it has told to stop, so a read asked for now would wait for ever.
          reading.signal.throwIfAborted();
          return reading.read(number, readingPicture);
        });
        const scanned = scannedUnit(
          number,
          oriented.lines,
          oriented.picture,
          reading.reader,
          oriented.turn,
        );
        unit = {
          ...scanned,
          anchors: scanned.anchors ? anchorsBack(scanned.anchors, oriented.turn) : null,
        };
      } catch (error) {
        reading.signal.throwIfAborted();
        message ??= error instanceof Error ? error.message : String(error);
        if (error instanceof ReadingUnavailable) unavailable = true;
      } finally {
        page.cleanup();
      }
    }
    if (unit) unit = withFormFields(unit, fields.get(number));
    else {
      unread.push(number);
      unit = { ...layer, label: { scan: { reader: reading.reader, unread: true } } };
    }
    pages[at] = unit;
    reading.progress(index + 1, scanned.length, unit);
  }
  return unread.length > 0 ? { pages: unread, message: message ?? "" } : null;
}

function withFormFields(unit: TextUnit, form: { text: string; anchors: Anchor[] } | undefined) {
  if (!form || unit.anchors?.some((anchor) => anchor.target.startsWith("form"))) return unit;
  const offset = unit.text.length + 1;
  return {
    ...unit,
    text: `${unit.text}\n${form.text}`,
    anchors: [
      ...(unit.anchors ?? []),
      ...form.anchors.map((anchor) => ({
        ...anchor,
        start: anchor.start + offset,
        end: anchor.end + offset,
      })),
    ],
  };
}

function scannedFormFields(page: PDFPageProxy, fields: readonly TextItem[]) {
  const viewport = page.getViewport({ scale: 1 });
  let text = "";
  const anchors: Anchor[] = [];
  for (const [index, field] of fields.entries()) {
    if (text) text += "\n";
    const start = text.length;
    text += pageText([field]);
    const left = Number(field.transform[4]);
    const bottom = Number(field.transform[5]) - field.height * 0.2;
    const quad = [
      [left, bottom + field.height],
      [left + field.width, bottom + field.height],
      [left + field.width, bottom],
      [left, bottom],
    ].flatMap(([x = 0, y = 0]) => {
      const [px = 0, py = 0] = viewport.convertToViewportPoint(x, y);
      return [px / viewport.width, py / viewport.height];
    });
    anchors.push({ start, end: text.length, target: `form${index + 1}`, quad });
  }
  return { text, anchors };
}
