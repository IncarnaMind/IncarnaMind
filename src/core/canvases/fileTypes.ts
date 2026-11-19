/**
 * What a Canvas's file is, told by its bytes (#3406): a picture, a font, or text a page loads (a
 * style sheet, a script, data). A file is served as the type its bytes show, whatever its name
 * says; only text, which has no mark of its own, takes its type from its name, once its bytes are
 * shown to be text. Anything else is refused, and so is a page of HTML: a Canvas is one page.
 */

const starts = (bytes: Uint8Array, mark: readonly number[], at = 0) =>
  bytes.length >= at + mark.length && mark.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string) => [...text].map((each) => each.charCodeAt(0));

const BINARY: readonly { type: string; test: (bytes: Uint8Array) => boolean }[] = [
  { type: "image/png", test: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: "image/jpeg", test: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { type: "image/gif", test: (b) => starts(b, ascii("GIF87a")) || starts(b, ascii("GIF89a")) },
  { type: "image/webp", test: (b) => starts(b, ascii("RIFF")) && starts(b, ascii("WEBP"), 8) },
  {
    type: "image/avif",
    test: (b) => starts(b, ascii("ftypavif"), 4) || starts(b, ascii("ftypavis"), 4),
  },
  { type: "font/woff2", test: (b) => starts(b, ascii("wOF2")) },
  { type: "font/woff", test: (b) => starts(b, ascii("wOFF")) },
  { type: "font/otf", test: (b) => starts(b, ascii("OTTO")) },
  { type: "font/ttf", test: (b) => starts(b, [0x00, 0x01, 0x00, 0x00]) },
];

const TEXT_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The text a file holds, if it is UTF-8 text with no NUL in it; null for anything else. */
function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Whether text is an SVG picture: its first element, after any prolog and comments, is `<svg`. */
function isSvg(text: string): boolean {
  const start = text
    .replace(/^﻿/, "")
    .slice(0, 4096)
    .replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/gi, "")
    .trimStart();
  return /^<svg[\s>]/i.test(start);
}

/** The media type a Canvas's file is served as; null when it is none a Canvas may use. */
export function canvasFileType(name: string, bytes: Uint8Array): string | null {
  const binary = BINARY.find((each) => each.test(bytes));
  if (binary) return binary.type;
  const text = textOf(bytes);
  if (text === null) return null;
  if (isSvg(text)) return "image/svg+xml";
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return TEXT_TYPES[extension] ?? null;
}
