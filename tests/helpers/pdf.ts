import { deflateSync } from "node:zlib";

/**
 * Builds tiny, valid PDFs for tests, so fixtures stay readable and small
 * instead of being committed as binaries.
 */

export interface PdfPage {
  /** Lines of text drawn top to bottom in Helvetica. Latin-1 characters only. */
  lines?: readonly string[];
  /**
   * Lines of Chinese text drawn with STSong-Light, a CJK font PDF readers
   * supply themselves, so extracting it needs pdf.js's CMap files.
   */
  chineseLines?: readonly string[];
  /**
   * Lines drawn first, each at its own size in points (11 if not given), as a
   * cover or a paper's first page sets its title large: in Helvetica, or in
   * STSong-Light when a line has characters beyond Latin-1.
   */
  printed?: readonly { text: string; size?: number }[];
  /** Text drawn where each says, in Helvetica at 10 points: a table's cells. Latin-1 characters only. */
  placed?: readonly { text: string; x: number; y: number }[];
  /** Draws a small greyscale image, like a scanned page. */
  image?: boolean;
  /** A valid compressed raster for exercising oversized-image limits. */
  imageDimensions?: readonly [number, number];
  /**
   * A scanned page (#397): this JPEG picture filling an A4 page, under any
   * lines, as a scanner makes it.
   */
  scan?: Uint8Array;
}

/** A JPEG's width, height and number of colour components, from its frame header. */
export function jpegSize(jpeg: Uint8Array): { width: number; height: number; components: number } {
  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) throw new Error("Not a JPEG.");
    const marker = jpeg[at + 1] as number;
    const length = ((jpeg[at + 2] as number) << 8) | (jpeg[at + 3] as number);
    // Start of frame (baseline, extended, progressive or lossless), not a table.
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: ((jpeg[at + 5] as number) << 8) | (jpeg[at + 6] as number),
        width: ((jpeg[at + 7] as number) << 8) | (jpeg[at + 8] as number),
        components: jpeg[at + 9] as number,
      };
    }
    at += 2 + length;
  }
  throw new Error("The JPEG has no frame header.");
}

/** An entry of a PDF's outline (its bookmarks). */
export interface PdfOutlineEntry {
  title: string;
  /** The page it goes to, from 1. */
  page?: number;
  /**
   * How it says where it goes: an explicit destination (`[page /XYZ …]`, the
   * default), a named destination looked up in the catalog's `/Dests`, a
   * GoTo action, or a web link (`url`) instead of a page.
   */
  via?: "explicit" | "named" | "action";
  url?: string;
  /** Shown expanded at first (a positive `/Count`). */
  open?: boolean;
  items?: readonly PdfOutlineEntry[];
}

/** A range of a PDF's page labels, from its first page: "r" gives i, ii, iii…, "D" gives 1, 2, 3…. */
export interface PdfPageLabelRange {
  /** The page the range starts at, from 1. */
  page: number;
  /** D, R, r, A or a; anything else is a malformed label. */
  style?: string;
  prefix?: string;
  /** What the first page of the range is numbered, from 1. */
  start?: number;
}

export interface PdfOptions {
  outline?: readonly PdfOutlineEntry[];
  pageLabels?: readonly PdfPageLabelRange[];
  /**
   * The document information dictionary (the trailer's /Info), each entry
   * written as a literal string: `{ CreationDate: "D:20190304103000Z" }`. A
   * value with characters outside Latin-1 (a Chinese title) is written as
   * UTF-16BE with its byte order mark, as PDF writers do.
   */
  info?: Readonly<Record<string, string>>;
  /** The /Info object as written, in place of `info`: for malformed files. */
  rawInfo?: string;
  /** An XMP metadata stream, as written, for the catalog's /Metadata. Stored as UTF-8. */
  xmp?: string;
}

const LINE_HEIGHT = 14;
const TOP = 760;

const escapeLatin = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);

/** A text string for /Info: literal for Latin-1, else UTF-16BE hex with its byte order mark. */
const infoString = (text: string) =>
  /[^\x20-\xff]/.test(text) ? `<FEFF${toUcs2Hex(text)}>` : `(${escapeLatin(text)})`;

const toUcs2Hex = (text: string) =>
  [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code > 0xffff) throw new Error("Only Basic Multilingual Plane characters are supported.");
      return code.toString(16).padStart(4, "0");
    })
    .join("");

function contentStream(page: PdfPage): string {
  // A scan's picture first: any lines are written over it, as a stamp is.
  const parts: string[] = page.scan ? ["q 595 0 0 842 0 0 cm /Scan Do Q"] : [];
  let y = TOP;
  for (const { text, size = 11 } of page.printed ?? []) {
    const chinese = /[^\x20-\xff]/.test(text);
    const shown = chinese ? `<${toUcs2Hex(text)}>` : `(${escapeLatin(text)})`;
    parts.push(`BT /${chinese ? "F2" : "F1"} ${size} Tf 72 ${y} Td ${shown} Tj ET`);
    y -= Math.round(size * 1.6);
  }
  for (const line of page.lines ?? []) {
    if (/[^\x20-\xff]/.test(line)) throw new Error(`Not Latin-1: ${line}`);
    parts.push(`BT /F1 11 Tf 72 ${y} Td (${escapeLatin(line)}) Tj ET`);
    y -= LINE_HEIGHT;
  }
  for (const { text, x, y: at } of page.placed ?? []) {
    parts.push(`BT /F1 10 Tf ${x} ${at} Td (${escapeLatin(text)}) Tj ET`);
  }
  for (const line of page.chineseLines ?? []) {
    parts.push(`BT /F2 11 Tf 72 ${y} Td <${toUcs2Hex(line)}> Tj ET`);
    y -= LINE_HEIGHT;
  }
  if (page.image) {
    const [width, height] = page.imageDimensions ?? [2, 2];
    const data = page.imageDimensions
      ? deflateSync(Buffer.alloc(width * height, 128)).toString("latin1")
      : "\x00\xff\xff\x00";
    const filter = page.imageDimensions ? " /F /Fl" : "";
    // A 2×2 greyscale inline image, scaled up to 300pt square.
    parts.push(
      `q 300 0 0 300 150 300 cm BI /W ${width} /H ${height} /CS /G /BPC 8${filter} ID ${data} EI Q`,
    );
  }
  return parts.join("\n");
}

/**
 * Adds an outline's objects, numbered from `firstId`, and returns the
 * catalog's entries for it: `/Outlines` and, for named destinations, `/Dests`.
 */
function addOutline(
  objects: string[],
  firstId: number,
  outline: readonly PdfOutlineEntry[],
  pageRef: (page: number) => string,
): string {
  let nextId = firstId;
  const named: string[] = [];

  const destination = (entry: PdfOutlineEntry): string => {
    if (entry.url) return `/A << /S /URI /URI (${escapeLatin(entry.url)}) >>`;
    const explicit = `[${pageRef(entry.page ?? 1)} /XYZ 0 792 0]`;
    if (entry.via === "named") {
      const name = `section${named.length + 1}`;
      named.push(`/${name} ${explicit}`);
      return `/Dest (${name})`;
    }
    if (entry.via === "action") return `/A << /S /GoTo /D ${explicit} >>`;
    return `/Dest ${explicit}`;
  };

  /** The entries shown under an open entry: its children, and theirs if open. */
  const shown = (entries: readonly PdfOutlineEntry[]): number =>
    entries.reduce((count, entry) => count + 1 + (entry.open ? shown(entry.items ?? []) : 0), 0);

  const add = (entries: readonly PdfOutlineEntry[], parentId: number) => {
    const ids = entries.map(() => nextId++);
    entries.forEach((entry, index) => {
      const id = ids[index] as number;
      const children = entry.items ?? [];
      let object = `<< /Title (${escapeLatin(entry.title)}) /Parent ${parentId} 0 R ${destination(entry)}`;
      if (index > 0) object += ` /Prev ${ids[index - 1]} 0 R`;
      if (index < ids.length - 1) object += ` /Next ${ids[index + 1]} 0 R`;
      if (children.length > 0) {
        const range = add(children, id);
        const count = entry.open ? shown(children) : -children.length;
        object += ` /First ${range.first} 0 R /Last ${range.last} 0 R /Count ${count}`;
      }
      objects[id] = `${object} >>`;
    });
    return { first: ids[0], last: ids.at(-1) };
  };

  const rootId = nextId++;
  const range = add(outline, rootId);
  objects[rootId] =
    `<< /Type /Outlines /First ${range.first} 0 R /Last ${range.last} 0 R /Count ${shown(outline)} >>`;
  const dests = named.length > 0 ? ` /Dests << ${named.join(" ")} >>` : "";
  return ` /Outlines ${rootId} 0 R /PageMode /UseOutlines${dests}`;
}

/** Returns the bytes of a PDF with one page per entry, and the outline and metadata given. */
export function buildPdf(pages: readonly PdfPage[], options: PdfOptions = {}): Uint8Array {
  // Objects 1–5 are fixed; each page then adds a page object and a content stream.
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 6 + index * 2);
  const outline =
    options.outline && options.outline.length > 0
      ? addOutline(objects, 6 + pages.length * 2, options.outline, (page) => {
          const id = pageIds[page - 1];
          if (id === undefined) throw new Error(`There is no page ${page}.`);
          return `${id} 0 R`;
        })
      : "";
  // The metadata, if any, after every other object.
  let nextId = Math.max(objects.length, 6 + pages.length * 2);
  let info = "";
  if (options.info || options.rawInfo !== undefined) {
    const id = nextId++;
    objects[id] =
      options.rawInfo ??
      `<< ${Object.entries(options.info ?? {})
        .map(([key, value]) => `/${key} ${infoString(value)}`)
        .join(" ")} >>`;
    info = ` /Info ${id} 0 R`;
  }
  let metadata = "";
  if (options.xmp !== undefined) {
    const id = nextId++;
    // Its UTF-8 bytes, one character each, as the rest of the file is built in Latin-1.
    const xmp = Buffer.from(options.xmp, "utf8").toString("latin1");
    objects[id] =
      `<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>\n` + `stream\n${xmp}\nendstream`;
    metadata = ` /Metadata ${id} 0 R`;
  }
  const labels = options.pageLabels
    ? ` /PageLabels << /Nums [${options.pageLabels
        .map(
          ({ page, style, prefix, start }) =>
            `${page - 1} << ${style ? `/S /${style} ` : ""}${prefix ? `/P (${escapeLatin(prefix)}) ` : ""}${start ? `/St ${start} ` : ""}>>`,
        )
        .join(" ")}] >>`
    : "";
  objects[1] = `<< /Type /Catalog /Pages 2 0 R${outline}${metadata}${labels} >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H " +
    "/DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light " +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 5 0 R >>] >>";
  objects[5] =
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] " +
    "/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>";
  pages.forEach((page, index) => {
    const pageId = 6 + index * 2;
    const content = contentStream(page);
    let scan = "";
    if (page.scan) {
      const id = nextId++;
      const { width, height, components } = jpegSize(page.scan);
      const data = Buffer.from(page.scan).toString("latin1");
      objects[id] =
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /${components === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${data.length} >>\nstream\n${data}\nendstream`;
      scan = ` /XObject << /Scan ${id} 0 R >>`;
    }
    const size = page.scan ? "595 842" : "612 792";
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${scan} >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  // Latin-1 throughout, so string length equals byte length for the xref offsets.
  let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R${info} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(pdf, "latin1"));
}
