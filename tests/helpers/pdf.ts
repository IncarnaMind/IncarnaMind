import { deflateSync } from "node:zlib";

/**
 * Builds tiny, valid PDFs for tests, so fixtures stay readable and small
 * instead of being committed as binaries. The sample PDFs in `data/` are built
 * with it too (`scripts/sampleDocuments`), so what the app reads is the same
 * kind of file the tests do.
 */

/**
 * A glyph of the standard font that a character in the text stands for, drawn
 * under a code of its own: a ligature, which pdf.js reads as "f" in some PDFs
 * (see `lostLigatures`), or a symbol WinAnsi lacks.
 */
export interface PdfSymbol {
  /** The characters in the text it stands for, matched longest first. */
  as: string;
  /** The standard font's glyph name to draw. */
  glyph: string;
  /** The text a reader extracts for it. */
  text: string;
}

/** A rule, or a filled rectangle: a chart's bar or a table's shading. Drawn before text. */
export type PdfDrawing =
  | { rule: readonly [number, number, number, number]; width?: number; gray?: number }
  | { rectangle: readonly [number, number, number, number]; gray?: number };

export interface PdfPage {
  fields?: readonly {
    dictionary: string;
    appearance: string | Readonly<Record<string, string>> | null;
    parent?: string;
  }[];
  /** Lines of text drawn top to bottom in Helvetica: WinAnsi's characters, and the options' symbols. */
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
  /** Text drawn where each says, in Helvetica at 10 points: a table's cells. */
  placed?: readonly { text: string; x: number; y: number }[];
  /** Rules and filled rectangles, drawn before the text. */
  drawn?: readonly PdfDrawing[];
  /** Draws a small greyscale image, like a scanned page. */
  image?: boolean;
  /** A valid compressed raster for exercising oversized-image limits. */
  imageDimensions?: readonly [number, number];
  /**
   * A scanned page (#397): this JPEG picture filling an A4 page, under any
   * lines, as a scanner makes it.
   */
  scan?: Uint8Array;
  /** A landscape A4 scan, for a sideways source picture on an unrotated page. */
  landscape?: boolean;
  /** The page's /Rotate value in degrees, as a PDF viewer applies it. */
  rotation?: number;
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
  xfa?: string;
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
  /** Glyphs the text stands for, each drawn under a code of its own (see `PdfSymbol`). */
  symbols?: readonly PdfSymbol[];
}

const LINE_HEIGHT = 14;
const TOP = 760;

const escapeLatin = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);

/** WinAnsiEncoding's bytes for the characters it adds to Latin-1. */
const WIN_ANSI: Readonly<Record<string, number>> = {
  "€": 0x80,
  "‚": 0x82,
  ƒ: 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  ˆ: 0x88,
  "‰": 0x89,
  Š: 0x8a,
  "‹": 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "˜": 0x98,
  "™": 0x99,
  š: 0x9a,
  "›": 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/** The character a WinAnsi byte draws, where Latin-1's own byte isn't it. */
const WIN_ANSI_CHARS: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(WIN_ANSI).map(([char, code]) => [code, char]),
);

/** The byte a symbol is drawn under: a control code WinAnsi text never uses. */
const symbolByte = (index: number) => index + 1;

/**
 * A line of text as the standard font's bytes: WinAnsi's, and each symbol's
 * own code. A character neither has is an error, never a silent "?".
 */
function encode(text: string, symbols: readonly PdfSymbol[]): string {
  const ordered = [...symbols].sort((a, b) => b.as.length - a.as.length);
  let out = "";
  for (let at = 0; at < text.length; ) {
    const symbol = ordered.find((each) => text.startsWith(each.as, at));
    if (symbol) {
      out += String.fromCharCode(symbolByte(symbols.indexOf(symbol)));
      at += symbol.as.length;
      continue;
    }
    const char = text[at] as string;
    const code = char.codePointAt(0) as number;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += char;
    } else if (WIN_ANSI[char] !== undefined) {
      out += String.fromCharCode(WIN_ANSI[char] as number);
    } else {
      throw new Error(`Not WinAnsi, and no symbol to draw it: ${JSON.stringify(char)}`);
    }
    at += 1;
  }
  return out;
}

/** Helvetica's width per 1000 units of the font size, for the characters the samples use. */
const HELVETICA: Readonly<Record<string, number>> = {
  " ": 278,
  "!": 278,
  '"': 355,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 667,
  "'": 191,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  ":": 278,
  ";": 278,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 556,
  "@": 1015,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  "[": 278,
  "\\": 278,
  "]": 278,
  "^": 469,
  _: 556,
  "`": 333,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  "{": 334,
  "|": 260,
  "}": 334,
  "~": 584,
  "•": 350,
  "–": 556,
  "—": 1000,
  "‘": 333,
  "’": 333,
  "“": 333,
  "”": 333,
  "£": 556,
};

/** How wide a text is at a font size, in points, in Helvetica. */
export function widthOf(text: string, size: number): number {
  let units = 0;
  for (const char of text) units += HELVETICA[char] ?? 500;
  return (units * size) / 1000;
}

/** A symbol's own width, per 1000 units: the letters it stands for, as Helvetica sets them. */
const SYMBOL_WIDTH: Readonly<Record<string, number>> = {
  fi: 500,
  fl: 500,
  ff: 556,
  ffi: 778,
  ffl: 778,
  epsilon: 500,
  carriagereturn: 500,
};

/** The font's /ToUnicode stream: each symbol's code as the text a reader extracts for it. */
function toUnicode(symbols: readonly PdfSymbol[]): string {
  const entries = symbols
    .map((symbol, index) => {
      const code = symbolByte(index).toString(16).padStart(2, "0");
      const text = [...symbol.text]
        .map((char) => (char.codePointAt(0) as number).toString(16).padStart(4, "0"))
        .join("");
      return `<${code}> <${text}>`;
    })
    .join("\n");
  return `beginbfchar\n${entries}\nendbfchar\n`;
}

/** A text string for /Info: literal for Latin-1, else UTF-16BE hex with its byte order mark. */
export const pdfString = (text: string) =>
  /[^\x20-\xff]/.test(text) ? `<FEFF${toUcs2Hex(text)}>` : `(${escapeLatin(text)})`;

const toUcs2Hex = (text: string) =>
  [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code > 0xffff) throw new Error("Only Basic Multilingual Plane characters are supported.");
      return code.toString(16).padStart(4, "0");
    })
    .join("");

export function pdfAppearance(text: string): string {
  const chinese = /[^\x20-\xff]/.test(text);
  const shown = chinese ? `<${toUcs2Hex(text)}>` : `(${escapeLatin(text)})`;
  return `BT /${chinese ? "F2" : "F1"} 11 Tf 2 6 Td ${shown} Tj ET`;
}

function contentStream(page: PdfPage, symbols: readonly PdfSymbol[]): string {
  // A scan's picture first: any lines are written over it, as a stamp is.
  const parts: string[] = page.scan
    ? [`q ${page.landscape ? "842 0 0 595" : "595 0 0 842"} 0 0 cm /Scan Do Q`]
    : [];
  for (const drawing of page.drawn ?? []) {
    if ("rule" in drawing) {
      const [x1, y1, x2, y2] = drawing.rule;
      parts.push(`${drawing.gray ?? 0} G ${drawing.width ?? 1} w ${x1} ${y1} m ${x2} ${y2} l S`);
    } else {
      const [x, y, width, height] = drawing.rectangle;
      parts.push(`${drawing.gray ?? 0.8} g ${x} ${y} ${width} ${height} re f`);
    }
  }
  let y = TOP;
  for (const { text, size = 11 } of page.printed ?? []) {
    const chinese = /\p{Script=Han}/u.test(text);
    const shown = chinese ? `<${toUcs2Hex(text)}>` : `(${escapeLatin(encode(text, symbols))})`;
    parts.push(`BT /${chinese ? "F2" : "F1"} ${size} Tf 72 ${y} Td ${shown} Tj ET`);
    y -= Math.round(size * 1.6);
  }
  for (const line of page.lines ?? []) {
    parts.push(`BT /F1 11 Tf 72 ${y} Td (${escapeLatin(encode(line, symbols))}) Tj ET`);
    y -= LINE_HEIGHT;
  }
  for (const { text, x, y: at } of page.placed ?? []) {
    const chinese = /\p{Script=Han}/u.test(text);
    const shown = chinese ? `<${toUcs2Hex(text)}>` : `(${escapeLatin(encode(text, symbols))})`;
    parts.push(`BT /${chinese ? "F2" : "F1"} 10 Tf ${x} ${at} Td ${shown} Tj ET`);
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
        .map(([key, value]) => `/${key} ${pdfString(value)}`)
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
  const fields: number[] = [];
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  const symbols = options.symbols ?? [];
  let fontEncoding = "/Encoding /WinAnsiEncoding";
  if (symbols.length > 0) {
    const differences = symbols
      .map((symbol, index) => `${symbolByte(index)} /${symbol.glyph}`)
      .join(" ");
    const toUnicodeId = nextId++;
    const map = toUnicode(symbols);
    objects[toUnicodeId] = `<< /Length ${map.length} >>\nstream\n${map}\nendstream`;
    // A base-14 font's widths come from its own metrics, which know no symbol:
    // without these, pdf.js reads the symbol and the letters after it apart.
    const widths = Array.from({ length: 256 }, (_, code) => {
      const symbol = symbols[code - 1];
      if (symbol) return SYMBOL_WIDTH[symbol.glyph] ?? 500;
      const latin = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
      const char = WIN_ANSI_CHARS[code] ?? (latin ? String.fromCharCode(code) : undefined);
      return char === undefined ? 500 : (HELVETICA[char] ?? 500);
    });
    fontEncoding =
      ` /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [${differences}] >> ` +
      `/ToUnicode ${toUnicodeId} 0 R /FirstChar 0 /LastChar 255 /Widths [${widths.join(" ")}]`;
  }
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica${fontEncoding} >>`;
  objects[4] =
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H " +
    "/DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light " +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 5 0 R >>] >>";
  objects[5] =
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] " +
    "/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>";
  pages.forEach((page, index) => {
    const pageId = 6 + index * 2;
    const content = contentStream(page, symbols);
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
    const size = page.scan ? (page.landscape ? "842 595" : "595 842") : "612 792";
    const annotations = (page.fields ?? []).map((field) => {
      const id = nextId++;
      const appearance = (value: string) => {
        const appearanceId = nextId++;
        objects[appearanceId] =
          `<< /Type /XObject /Subtype /Form /BBox [0 0 300 24] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Length ${value.length} >>\nstream\n${value}\nendstream`;
        return `${appearanceId} 0 R`;
      };
      const normal =
        field.appearance === null
          ? null
          : typeof field.appearance === "string"
            ? appearance(field.appearance)
            : `<< ${Object.entries(field.appearance)
                .map(([state, value]) => `/${state} ${appearance(value)}`)
                .join(" ")} >>`;
      let parent = "";
      if (field.parent) {
        const parentId = nextId++;
        fields.push(parentId);
        objects[parentId] = `<< ${field.parent} /Kids [${id} 0 R] >>`;
        parent = ` /Parent ${parentId} 0 R`;
      } else fields.push(id);
      objects[id] =
        `<< /Type /Annot /Subtype /Widget /P ${pageId} 0 R ${field.dictionary}${parent}${normal === null ? "" : ` /AP << /N ${normal} >>`} >>`;
      return `${id} 0 R`;
    });
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size}] ` +
      `${page.rotation === undefined ? "" : `/Rotate ${page.rotation} `}` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${scan} >> /Contents ${pageId + 1} 0 R${annotations.length > 0 ? ` /Annots [${annotations.join(" ")}]` : ""} >>`;
    objects[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let xfa = "";
  if (options.xfa !== undefined) {
    const id = nextId++;
    const data = Buffer.from(options.xfa, "utf8").toString("latin1");
    objects[id] = `<< /Length ${data.length} >>\nstream\n${data}\nendstream`;
    xfa = ` /XFA ${id} 0 R`;
  }
  const hasSignatures = pages.some((page) =>
    (page.fields ?? []).some((field) => field.dictionary.includes("/FT /Sig")),
  );
  const form =
    fields.length > 0 || xfa
      ? ` /AcroForm << /Fields [${fields.map((id) => `${id} 0 R`).join(" ")}]${xfa}${hasSignatures ? " /SigFlags 1" : ""} /DA (/F1 11 Tf 0 g) /DR << /Font << /F1 3 0 R >> >> >>`
      : "";
  objects[1] = `<< /Type /Catalog /Pages 2 0 R${outline}${metadata}${labels}${form} >>`;

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
