/**
 * The pictures an outside agent puts in a Note it writes or changes (#3413): `![alt](…)` on a line
 * of its own, a file on this computer by its full path, read by the host's reader of the files an
 * agent names (as a Canvas's are, #3406) only when named in that call, or inline as a `data:` URL
 * for an agent whose files are elsewhere. A picture is kept in the Note as a `data:` URL, as a
 * pasted one is, its type told by its bytes whatever its name says. One that can't be kept stays
 * a line that says why. An SVG is kept as a PNG drawn from it, by the drawer that draws a chart for
 * Word: a picture saved out of the Note and opened in a browser runs nothing it held.
 */
import type { NamedFile, Pictures } from "../adapters";
import { canvasFileType } from "../canvases/fileTypes";
import { dataUrlOf } from "../documents/formats/images";

export const NOTE_PICTURE_LIMITS = {
  /** One picture's bytes: in a `data:` URL, under what a pasted picture is kept at (#1937). */
  bytes: 1024 * 1024,
  /** Pictures one call adds. */
  pictures: 10,
} as const;

const PICTURE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** A picture as the agent wrote it: `raw` is `![alt](source)`. */
export interface NamedPicture {
  alt: string;
  source: string;
  raw: string;
}

export type PictureRefusal =
  | "unreadable"
  | "too-large"
  | "type"
  | "network"
  | "where"
  | "too-many"
  | "own-line"
  | "svg";

/** A picture as the Note keeps it: a `data:` URL, with its size in pixels where it was drawn. */
export type ReadPicture =
  | { src: string; width?: number; height?: number }
  | { refused: PictureRefusal };

/** Where a picture stood while its Markdown is read: characters no reading makes or takes. */
export const HELD_PICTURE = /(\d{1,4})/g;
export const HOLDING_PICTURES = /[]/g;
const heldPicture = (n: number) => `${n}`;

/** The source between `![alt](` and its `)`, as `at` starts it; null when the line ends first. */
function sourceAt(text: string, at: number): { source: string; end: number } | null {
  if (text[at] === "<") {
    const close = text.indexOf(">", at);
    const line = text.indexOf("\n", at);
    if (close < 0 || (line >= 0 && line < close)) return null;
    let end = close + 1;
    while (text[end] === " " || text[end] === "\t") end++;
    return text[end] === ")" ? { source: text.slice(at + 1, close).trim(), end } : null;
  }
  let depth = 1;
  for (let index = at; index < text.length; index++) {
    const char = text[index];
    if (char === "\n") return null;
    if (char === "\\") index++;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) {
      const written = text.slice(at, index).trim();
      // A title after a path, as Markdown allows one; a data: URL keeps what it holds.
      const source = written.startsWith("data:")
        ? written
        : written.replace(/\s+(?:"[^"\n]*"|'[^'\n]*')$/, "");
      return { source, end: index };
    }
  }
  return null;
}

/**
 * `text` with each picture `![alt](source)` in it held by a marker, and the pictures in their
 * order. Scanned by hand: a source may hold brackets, parentheses and spaces (an SVG inline).
 */
export function holdPictures(text: string): { text: string; pictures: NamedPicture[] } {
  const pictures: NamedPicture[] = [];
  let out = "";
  let from = 0;
  let at = text.indexOf("![");
  while (at >= 0) {
    const close = text.indexOf("]", at + 2);
    const line = text.indexOf("\n", at);
    const found =
      text[at - 1] !== "\\" && close >= 0 && (line < 0 || close < line) && text[close + 1] === "("
        ? sourceAt(text, close + 2)
        : null;
    if (found) {
      out += text.slice(from, at) + heldPicture(pictures.length);
      pictures.push({
        alt: text.slice(at + 2, close).trim(),
        source: found.source,
        raw: text.slice(at, found.end + 1),
      });
      from = found.end + 1;
    }
    at = text.indexOf("![", found ? from : at + 2);
  }
  return { text: out + text.slice(from), pictures };
}

/** The most characters a call's inline pictures take: each picture's limit, in base64. */
const INLINE_CHARS =
  NOTE_PICTURE_LIMITS.pictures * (Math.ceil(NOTE_PICTURE_LIMITS.bytes / 3) * 4 + 1024);

/** How many characters of `text` are pictures written inline: a draft's limit counts the rest. */
export function inlinePictureChars(text: string): number {
  const inline = holdPictures(text)
    .pictures.filter((picture) => picture.source.startsWith("data:"))
    .reduce((sum, picture) => sum + picture.raw.length, 0);
  return Math.min(inline, INLINE_CHARS);
}

/** A data: URL's bytes; null when it isn't one, too-large before decoding past the limit. */
function inlineBytes(source: string): Uint8Array | null | "too-large" {
  const comma = source.indexOf(",");
  if (comma < 0) return null;
  const body = source.slice(comma + 1);
  try {
    if (/;base64$/i.test(source.slice(0, comma))) {
      const data = body.replace(/\s+/g, "");
      if ((data.length * 3) / 4 > NOTE_PICTURE_LIMITS.bytes + 2) return "too-large";
      return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    }
    const bytes = new TextEncoder().encode(decodeURIComponent(body));
    return bytes.byteLength > NOTE_PICTURE_LIMITS.bytes ? "too-large" : bytes;
  } catch {
    return null;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** An SVG drawn as a PNG, at its own size; refused where there is no drawer or it can't be drawn. */
async function drawn(svg: Uint8Array, draw: Pictures | undefined): Promise<ReadPicture> {
  if (!draw) return { refused: "svg" };
  try {
    const png = await draw.png(new TextDecoder().decode(svg));
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    if (png.byteLength < 24 || !PNG_SIGNATURE.every((byte, at) => png[at] === byte)) {
      return { refused: "svg" };
    }
    return {
      src: dataUrlOf(png, "image/png"),
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  } catch {
    return { refused: "svg" };
  }
}

const isFullPath = (source: string) =>
  source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("\\\\");

async function readOne(
  source: string,
  read: ((path: string, maxBytes: number) => Promise<NamedFile>) | undefined,
  draw: Pictures | undefined,
): Promise<ReadPicture> {
  let bytes: Uint8Array;
  if (source.startsWith("data:")) {
    const inline = inlineBytes(source);
    if (inline === "too-large") return { refused: "too-large" };
    if (inline === null) return { refused: "type" };
    bytes = inline;
  } else if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(source) && !/^file:/i.test(source)) {
    return { refused: "network" };
  } else if (!isFullPath(source)) {
    return { refused: "where" };
  } else {
    const named = read ? await read(source, NOTE_PICTURE_LIMITS.bytes) : null;
    if (!named || named.kind === "unreadable") return { refused: "unreadable" };
    if (named.kind === "too-large") return { refused: "too-large" };
    bytes = named.bytes;
  }
  const type = canvasFileType("", bytes);
  if (type === "image/svg+xml") return drawn(bytes, draw);
  return type && PICTURE_TYPES.has(type) ? { src: dataUrlOf(bytes, type) } : { refused: "type" };
}

/**
 * Each picture's source read once, in order: a path with `read`, the host's reader of the files an
 * agent names, which is all that reads a file, and an SVG drawn with `draw`; past the call's limit,
 * none is read.
 */
export async function readPictures(
  pictures: readonly NamedPicture[],
  read: ((path: string, maxBytes: number) => Promise<NamedFile>) | undefined,
  draw: Pictures | undefined,
): Promise<Map<string, ReadPicture>> {
  const found = new Map<string, ReadPicture>();
  for (const { source } of pictures) {
    if (found.has(source)) continue;
    found.set(
      source,
      found.size < NOTE_PICTURE_LIMITS.pictures
        ? await readOne(source, read, draw)
        : { refused: "too-many" },
    );
  }
  return found;
}

/** What a picture is called in a line about it: its alt text, else its file's name. */
export function pictureName(picture: NamedPicture): string {
  if (picture.alt !== "") return picture.alt;
  if (picture.source.startsWith("data:")) return "";
  return picture.source.split(/[\\/]/).at(-1) ?? picture.source;
}
