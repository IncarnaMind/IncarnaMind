/**
 * RTF (a Word 97–2003 file, or anything else that saves as RTF) → text with
 * its headings (#762). Our own small reader: control words, groups and the
 * text between them, with no dependency. Its headings are the ones the file
 * says a paragraph has (`\outlinelevel`, or a style called "Heading 1" and
 * the like), the same headings Word shows, and the text is Markdown so the
 * viewer renders it with its headings and the sections are cited by them.
 *
 * A group that holds no text (a font table, a picture, a header) is skipped.
 * Text is decoded as the file says: its `\ansicpg` code page for `\'hh`
 * bytes, and `\uN` for characters it writes whole. Pure.
 */
import { ExtractionError } from "./errors";

const SKIPPED_DESTINATIONS = new Set([
  "annotation",
  "atnauthor",
  "atnid",
  "bkmkend",
  "bkmkstart",
  "colorschememapping",
  "colortbl",
  "comment",
  "datastore",
  "filetbl",
  "fldinst",
  "fonttbl",
  "footer",
  "footerf",
  "footerl",
  "footerr",
  "footnote",
  "generator",
  "header",
  "headerf",
  "headerl",
  "headerr",
  "info",
  "latentstyles",
  "listoverridetable",
  "listtable",
  "mmath",
  "mmathPr",
  "nonshppict",
  "object",
  "pict",
  "pn",
  "pntext",
  "pntxta",
  "pntxtb",
  "revtbl",
  "rsidtbl",
  "shp",
  "shpinst",
  "shppict",
  "shprslt",
  "sp",
  "stylesheet",
  "themedata",
  "xmlnstbl",
  "xe",
]);

/** Control words that stand for a character, as they read. */
const SYMBOLS: Readonly<Record<string, string>> = {
  bullet: "•",
  emdash: "—",
  emspace: " ",
  endash: "–",
  enspace: " ",
  ldblquote: "“",
  lquote: "‘",
  rdblquote: "”",
  rquote: "’",
  qmspace: "?",
};

/** The code page an `\ansicpg` number means, for a `\'hh` byte. */
function codePageOf(cp: number): string {
  if (cp === 65001) return "utf-8";
  if (cp === 936 || cp === 54936) return "gb18030";
  if (cp === 950) return "big5";
  if (cp === 932) return "shift_jis";
  if (cp === 949) return "euc-kr";
  return "windows-1252";
}

/** Bytes as Latin-1: control words are ASCII, and each `\'hh` is one byte. */
function latin1(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
  }
  return parts.join("");
}

interface Style {
  /** Its outline level as the file writes it, from 0; null when it names none. */
  outline: number | null;
  name: string;
}

/** The style definitions of a file's `\stylesheet` group, by their number. */
export function rtfStyles(source: string): Map<number, Style> {
  const styles = new Map<number, Style>();
  // Definitions are {\s1\outlinelevel0\sbasedon0\snext0 heading 1;}
  for (const match of source.matchAll(/\{\\s(\d+)\b([^{}]*);/g)) {
    const number = Number(match[1]);
    const body = match[2] ?? "";
    const outline = /\\outlinelevel(\d+)/.exec(body);
    // What is left after the control words is the style's name ("heading 1").
    const name = body
      .replace(/\\[a-z]+-?\d*\s?/gi, "")
      .replace(/[{}]/g, "")
      .trim();
    styles.set(number, {
      outline: outline ? Number(outline[1]) : null,
      name,
    });
  }
  return styles;
}

/** The heading level a style names, from 1; null when it isn't a heading's. */
function headingOfStyle(style: Style | undefined): number | null {
  if (!style) return null;
  if (style.outline !== null) return Math.min(6, Math.max(1, style.outline + 1));
  const named = /^heading\s*([1-9])$/i.exec(style.name);
  return named ? Math.min(6, Number(named[1])) : null;
}

/**
 * Escapes the characters that would make Markdown show something else than
 * the file's text. `markdownUnits` reads the escapes back, so a heading of
 * the text never turns into a heading of the Document.
 */
export function escapeMarkdownLine(text: string): string {
  let line = text.replace(/\\/g, "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  line = line.replace(/^([ \t]*)([#>+\-*])/, "$1\\$2");
  line = line.replace(/^([ \t]*\d+)([.)])(?=[ \t])/, "$1\\$2");
  line = line.replace(/^( {0,3})(`{3,}|~{3,})/, "$1\\$2");
  return line.trimEnd();
}

/**
 * An RTF file as Markdown: each paragraph its own block, a heading as `#`s
 * (its level) and its text, and the file's unread groups left out. Throws
 * `ExtractionError` when the file isn't RTF.
 */
export function rtfMarkdown(bytes: Uint8Array): string {
  const source = latin1(bytes);
  if (!/^\s*\{\\rtf/.test(source)) {
    throw new ExtractionError("unreadable", "This isn't an RTF file.");
  }
  const styles = rtfStyles(source);
  const out: string[] = [];
  /** Text of the paragraph being read. */
  let chunks: string[] = [];
  let raw: number[] = [];
  let decoder = new TextDecoder(codePageOf(1252));
  let codePage = 1252;
  let uc = 1;
  /** Characters of a \uN fallback to skip. */
  let fallback = 0;
  let heading: number | null = null;
  let writing = 0;
  /** Whether the group being read belongs to a destination that holds no text. */
  const groups: { skip: boolean; uc: number }[] = [];

  const skipped = () => writing > 0;

  const flushRaw = () => {
    if (raw.length === 0) return;
    chunks.push(decoder.decode(new Uint8Array(raw)));
    raw = [];
  };
  const text = (value: string) => {
    if (skipped() || value === "") return;
    flushRaw();
    chunks.push(value);
  };
  const byte = (value: number) => {
    if (skipped()) return;
    raw.push(value);
  };
  const endParagraph = () => {
    flushRaw();
    const value = chunks
      .join("")
      .replace(/[ \t]+$/g, "")
      .trim();
    chunks = [];
    if (value === "") return;
    const line = escapeMarkdownLine(value.replace(/[ \t]*\n[ \t]*/g, " "));
    if (line !== "") out.push(heading === null ? line : `${"#".repeat(heading)} ${line}`);
    heading = null;
  };

  let at = 0;
  while (at < source.length) {
    const char = source[at] as string;
    if (char === "{") {
      groups.push({ skip: false, uc });
      at++;
      continue;
    }
    if (char === "}") {
      const ended = groups.pop();
      if (ended) {
        uc = ended.uc;
        if (ended.skip) writing = Math.max(0, writing - 1);
      }
      at++;
      continue;
    }
    if (char !== "\\") {
      if (fallback > 0) fallback--;
      else text(char === "\r" || char === "\n" ? "" : char);
      at++;
      continue;
    }
    const next = source[at + 1] ?? "";
    if (next === "") {
      at++;
      continue;
    }
    // \\, \{ and \} are the characters themselves.
    if (next === "\\" || next === "{" || next === "}") {
      if (fallback > 0) fallback--;
      else text(next);
      at += 2;
      continue;
    }
    if (next === "'") {
      const hex = source.slice(at + 2, at + 4);
      if (fallback > 0) fallback--;
      else if (/^[0-9a-f]{2}$/i.test(hex)) byte(Number.parseInt(hex, 16));
      at += 4;
      continue;
    }
    if (next === "*") {
      const group = groups.at(-1);
      if (group && !group.skip) {
        group.skip = true;
        writing++;
      }
      at += 2;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      const symbol = ({ "~": " ", _: "-" } as Record<string, string>)[next];
      if (symbol !== undefined) text(symbol);
      at += 2;
      continue;
    }
    // A control word: its name, an optional number, and one space that ends it.
    const match = /^([a-zA-Z]+)(-?\d+)? ?/.exec(source.slice(at + 1));
    if (!match) {
      at++;
      continue;
    }
    at += 1 + match[0].length;
    const word = match[1] as string;
    const value = match[2] === undefined ? null : Number(match[2]);
    if (skipped()) continue;
    if (fallback > 0) {
      fallback--;
      continue;
    }
    if (SKIPPED_DESTINATIONS.has(word)) {
      const group = groups.at(-1);
      if (group && !group.skip) {
        group.skip = true;
        writing++;
      }
      continue;
    }
    switch (word) {
      case "ansicpg":
        if (value !== null && value !== codePage) {
          flushRaw();
          codePage = value;
          decoder = new TextDecoder(codePageOf(codePage));
        }
        break;
      case "uc":
        if (value !== null) uc = Math.max(0, value);
        break;
      case "u":
        if (value !== null) {
          flushRaw();
          chunks.push(String.fromCodePoint(value < 0 ? value + 65536 : value));
          fallback = uc;
        }
        break;
      case "par":
      case "row":
        endParagraph();
        break;
      case "line":
        text("\n");
        break;
      case "tab":
      case "cell":
        text("\t");
        break;
      case "pard":
        heading = null;
        break;
      case "plain":
        break;
      case "s":
        if (value !== null) heading = headingOfStyle(styles.get(value));
        break;
      case "outlinelevel":
        if (value !== null) heading = Math.min(6, Math.max(1, value + 1));
        break;
      default:
        if (SYMBOLS[word] !== undefined) text(SYMBOLS[word] as string);
        break;
    }
  }
  endParagraph();
  const markdown = out.join("\n\n");
  return markdown === "" ? "" : `${markdown}\n`;
}
