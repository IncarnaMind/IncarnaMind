/**
 * A saved .html file → text with its headings (#762). Our own small, tolerant
 * reader: pages in the wild leave tags unclosed, use a doctype, and put the
 * text inside anything; a browser still reads them, and so does this. Scripts,
 * styles and the page's `head` are left out, the body is read as Markdown
 * (headings as `#`s, a paragraph or list item its own block, a table's rows
 * one line each), and `markdownUnits` then cuts it into sections, as it does
 * a Markdown file. Pure: the worker indexes with it and the viewer shows what
 * it made.
 */
import { decodeText } from "../decode";
import { ExtractionError } from "./errors";
import { decodeHtmlEntities } from "./htmlEntities";

/** The most of a page this reads: past it the file is refused, not walked, at every open. */
const MAX_HTML_BYTES = 64 * 1024 * 1024;

/** Elements whose content is never read as the page's text. */
const SILENT = new Set(["script", "style", "noscript", "template", "svg", "head"]);

/** The elements that belong in a page's `head`: anything else closes it, as a browser does. */
const IN_HEAD = new Set([
  "title",
  "meta",
  "link",
  "base",
  "style",
  "script",
  "noscript",
  "template",
]);

/** Elements that start a block of their own. */
const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "html",
  "legend",
  "main",
  "nav",
  "p",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "ol",
]);

const HEADING = /^h([1-6])$/;

/** Elements whose content is raw text until their own end tag, never markup. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

/** Each raw-text element's end tag but a script's, case-insensitive, at a tag boundary. */
const RAW_ENDS: Readonly<Record<string, RegExp>> = {
  style: /<\/style(?=[\s/>])/gi,
  textarea: /<\/textarea(?=[\s/>])/gi,
  title: /<\/title(?=[\s/>])/gi,
};

/** Whether `name` starts at `at`, whatever its case, and ends at a tag boundary. */
function hasName(source: string, at: number, name: string): boolean {
  return (
    source.slice(at, at + name.length).toLowerCase() === name &&
    /[\s/>]/.test(source[at + name.length] ?? "")
  );
}

/**
 * Where a script's body ends. A `<!--` escapes it, and a `<script>` there
 * escapes it twice, where a `</script>` only leaves the twice state; the
 * script ends at the next `</script>` that neither state holds, as a
 * browser's tokenizer reads them (#2439).
 */
function scriptEnd(source: string, from: number): number {
  // 0: script data, 1: escaped, 2: double escaped.
  let escaped = 0;
  for (let at = from; at < source.length; at++) {
    if (escaped > 0 && source.startsWith("-->", at)) {
      escaped = 0;
      at += 2;
      continue;
    }
    if (escaped === 0 && source.startsWith("<!--", at)) {
      escaped = 1;
      at += 3;
      continue;
    }
    if (source[at] !== "<") continue;
    const closing = source[at + 1] === "/";
    const nameAt = at + (closing ? 2 : 1);
    if (!hasName(source, nameAt, "script")) continue;
    if (closing) {
      if (escaped < 2) return at;
      escaped = 1;
    } else if (escaped === 1) {
      escaped = 2;
    }
    at = nameAt + 5;
  }
  return -1;
}

/** Where a raw-text element's own end tag starts, or -1 when it has none. */
function rawEnd(source: string, from: number, name: string): number {
  if (name === "script") return scriptEnd(source, from);
  const pattern = RAW_ENDS[name];
  if (!pattern) return -1;
  pattern.lastIndex = from;
  return pattern.exec(source)?.index ?? -1;
}

/** A block being read: its Markdown form, and the text gathered for it. */
interface Block {
  kind: "paragraph" | "heading" | "listItem" | "pre";
  level: number;
  /** A table's cells gathered from its `td` and `th`. */
  cells?: string[];
}

/**
 * A saved .html file's text as Markdown, with its headings. Throws
 * `ExtractionError` when the bytes aren't text, or are too large to read here.
 */
export function htmlMarkdown(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_HTML_BYTES) {
    throw new ExtractionError("too-large", "Too large to open (limit 64 MB).");
  }
  const source = decodeHtml(bytes);
  if (source === null) {
    throw new ExtractionError("unreadable", "The file holds binary data, not text.");
  }
  return htmlTextToMarkdown(source);
}

/** The encoding a byte-order mark names, if there is one. */
function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

/**
 * A meta's charset label, with the spec's rule that a meta-declared UTF-16 is
 * UTF-8. The platform knows UTF-16 by more names than one (`unicode`,
 * `ucs-2`, `csunicode`), so the label is decoded before it is checked (#2439).
 */
function charsetLabel(label: string): string {
  try {
    return new TextDecoder(label).encoding.startsWith("utf-16") ? "utf-8" : label;
  } catch {
    return label;
  }
}

/**
 * The encoding the page says it is, from its first 1024 bytes: a `<meta
 * charset>` attribute, or a `Content-Type` meta whose content says so. A
 * description that happens to contain "charset=" names nothing. A browser
 * looks no further, and neither do we; a page without one is read as text is.
 */
function declaredCharset(bytes: Uint8Array): string | null {
  // A comment is not a tag: a commented-out `<meta charset>` names nothing.
  const head = String.fromCharCode(...bytes.subarray(0, 1024)).replace(
    /<!--[\s\S]*?(?:-->|$)/g,
    "",
  );
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[0].matchAll(
      /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    )) {
      attributes.set(
        (attribute[1] as string).toLowerCase(),
        attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
      );
    }
    const charset = attributes.get("charset");
    if (charset) return charsetLabel(charset.trim().toLowerCase());
    if ((attributes.get("http-equiv") ?? "").toLowerCase() === "content-type") {
      const inside = /charset\s*=\s*["']?\s*([a-zA-Z0-9_:.+-]+)/i.exec(
        attributes.get("content") ?? "",
      )?.[1];
      if (inside) return charsetLabel(inside.toLowerCase());
    }
  }
  return null;
}

/**
 * A page's bytes as its own encoding says: a byte-order mark, else the
 * `<meta charset>` (Big5, GBK, Shift_JIS, windows-1252, and the labels the
 * platform knows), else the UTF-8 or GB18030 a text file is read as. An
 * unknown label falls back the same way. Null when the bytes are binary.
 */
function decodeHtml(bytes: Uint8Array): string | null {
  const label = bomCharset(bytes) ?? declaredCharset(bytes);
  let text: string | null = null;
  if (label !== null) {
    try {
      text = new TextDecoder(label).decode(bytes);
    } catch {
      text = null;
    }
  }
  const decoded = text ?? decodeText(bytes);
  if (decoded === null || decoded.includes("\u0000")) return null;
  return decoded.replace(/\r\n?/g, "\n");
}

/**
 * The `>` that ends the tag starting at `lt`, skipping a quoted attribute's
 * own `>`; -1 at the end. A quote starts a value only after `=`, so the
 * apostrophe in `class=it's` is the value's, as a browser reads it.
 */
function tagEnd(source: string, lt: number): number {
  let quote = "";
  let equals = false;
  for (let at = lt + 1; at < source.length; at++) {
    const char = source[at] as string;
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === ">") return at;
    if (char === '"' || char === "'") {
      if (equals) {
        quote = char;
        equals = false;
      }
      continue;
    }
    if (char === "=") {
      equals = true;
      continue;
    }
    if (equals && !/\s/.test(char)) equals = false;
  }
  return -1;
}

/** As `htmlMarkdown`, from text already decoded. */
export function htmlTextToMarkdown(source: string): string {
  const out: string[] = [];
  const open: string[] = [];
  const counts = new Map<string, number>();
  let block: Block | null = null;
  let text = "";
  let silent = 0;
  let pre = "";
  let inPre = 0;
  let row: string[] | null = null;
  let cell: string | null = null;

  const push = (name: string) => {
    open.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const pop = (): string | undefined => {
    const name = open.pop();
    if (name === undefined) return undefined;
    const left = (counts.get(name) ?? 0) - 1;
    if (left > 0) counts.set(name, left);
    else counts.delete(name);
    return name;
  };
  const isOpen = (name: string) => (counts.get(name) ?? 0) > 0;

  const flushBlock = () => {
    const value = text.replace(/[ \t\n]+/g, " ").trim();
    text = "";
    const current = block;
    block = null;
    if (!current || value === "") return;
    if (current.kind === "heading") {
      out.push(`${"#".repeat(Math.min(6, Math.max(1, current.level)))}\t${value}`);
      return;
    }
    out.push(value);
  };

  const flushPre = () => {
    const value = pre
      .replace(/^\r?\n/, "")
      .replace(/\r\n?/g, "\n")
      .trimEnd();
    pre = "";
    if (value === "") return;
    out.push(value);
  };

  const endCell = () => {
    if (cell === null || row === null) return;
    row.push(cell.replace(/[ \t]+/g, " ").trim());
    cell = null;
  };
  const endRow = () => {
    endCell();
    if (row === null) return;
    const cells = row;
    row = null;
    if (cells.some(Boolean)) out.push(cells.join(" | "));
  };

  // Each element is pushed once and popped at most once, so a page of a
  // hundred thousand unclosed tags stays linear (#762).
  const closeUntil = (name: string) => {
    if (!isOpen(name)) return;
    while (open.length > 0) {
      const closed = pop();
      if (closed === undefined) return;
      if (SILENT.has(closed)) silent = Math.max(0, silent - 1);
      if (closed === "pre") {
        inPre = Math.max(0, inPre - 1);
        if (inPre === 0) {
          flushPre();
          block = null;
          text = "";
        }
      }
      if (closed === "tr") endRow();
      if (closed === "td" || closed === "th") endCell();
      if (closed === name) return;
    }
  };

  /** A block starts: whatever was being read ends first. */
  const startBlock = (kind: Block["kind"], level = 1) => {
    if (block) flushBlock();
    block = { kind, level };
  };

  let at = 0;
  while (at < source.length) {
    const lt = source.indexOf("<", at);
    if (lt < 0) {
      textAfter(source.slice(at));
      break;
    }
    if (lt > at) textAfter(source.slice(at, lt));
    // A `<` that starts no tag is the page's own character: "a < b" is text, as in a browser.
    if (!/[a-zA-Z/!?]/.test(source[lt + 1] ?? "")) {
      textAfter("<");
      at = lt + 1;
      continue;
    }
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const end = tagEnd(source, lt);
      at = end < 0 ? source.length : end + 1;
      continue;
    }
    const gt = tagEnd(source, lt);
    // A tag still open at the end of the file is left out, as a browser leaves it out.
    if (gt < 0) break;
    const tag = source.slice(lt + 1, gt);
    at = gt + 1;
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim().toLowerCase().split(/\s/)[0] ?? "";
      if (SILENT.has(name) && isOpen(name)) closeUntil(name);
      else closeTag(name);
      continue;
    }
    const name = /^[a-zA-Z][^\s/>]*/.exec(tag)?.[0].toLowerCase() ?? "";
    if (name === "") continue;
    const selfClosing = /\/\s*$/.test(tag);
    startTag(name, tag, selfClosing);
    // A script, style, textarea or title is raw text until its own end tag: a "<" in it
    // is not markup, and "a<b&&c>d" must not open or close elements (#762). Inside svg or
    // math only a title is not raw text, and an unclosed one must not swallow the page (#2439).
    if (
      !selfClosing &&
      RAW_TEXT.has(name) &&
      !(name === "title" && (isOpen("svg") || isOpen("math")))
    ) {
      const end = rawEnd(source, at, name);
      const raw = source.slice(at, end < 0 ? source.length : end);
      if (name === "textarea" || name === "title") textAfter(raw);
      at = end < 0 ? source.length : end;
    }
  }

  function textAfter(raw: string, decoded = false) {
    const value = decoded ? raw : decodeHtmlEntities(raw);
    // A `head` a page never closes is closed by the first words of its body, as a browser does.
    if (silent > 0) {
      // Only the head's own text closes it; a title's or a style's is the head's.
      if (open.at(-1) === "head" && value.trim() !== "") closeUntil("head");
      else return;
    }
    if (inPre > 0) {
      pre += value;
      return;
    }
    if (cell !== null) cell += value;
    else if (block) text += value;
    else if (value.trim() !== "") {
      startBlock("paragraph");
      text += value;
    }
  }

  function startTag(name: string, tag: string, selfClosing: boolean) {
    // A `head` a page never closes is closed by the first element that isn't its own, as a browser does.
    if (silent > 0 && isOpen("head") && name !== "head" && !IN_HEAD.has(name)) {
      closeUntil("head");
    }
    if (name === "br") {
      if (silent > 0) return;
      if (inPre > 0) pre += "\n";
      else if (cell !== null) cell += "\n";
      else if (block) text += "\n";
      return;
    }
    if (!selfClosing) push(name);
    if (SILENT.has(name)) {
      if (!selfClosing) silent++;
      return;
    }
    if (silent > 0) return;
    if (name === "pre") {
      inPre++;
      if (inPre === 1) startBlock("pre");
      return;
    }
    const heading = HEADING.exec(name);
    if (heading) {
      startBlock("heading", Number(heading[1]));
      return;
    }
    if (name === "tr") {
      flushBlock();
      endRow();
      row = [];
      return;
    }
    if (name === "td" || name === "th") {
      endCell();
      if (row === null) row = [];
      cell = "";
      return;
    }
    if (name === "li") {
      startBlock("listItem");
      return;
    }
    if (name === "dt" || name === "dd") {
      startBlock("paragraph");
      return;
    }
    if (BLOCKS.has(name)) {
      startBlock("paragraph");
      return;
    }
    if (name === "img") {
      const alt = /(?:^|\s)alt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const value = decodeHtmlEntities(alt?.[1] ?? alt?.[2] ?? "", { attribute: true }).trim();
      // Already read as an attribute: the text must not read its legacy names again.
      if (value !== "") textAfter(value, true);
    }
  }

  function closeTag(name: string) {
    // An end tag ends its block whether or not the element was opened (HTML leaves tags out);
    // closing up the stack also restores the silence a closed `head`, `style` or `script` had.
    if (HEADING.test(name) || name === "li" || BLOCKS.has(name)) flushBlock();
    closeUntil(name);
  }

  flushBlock();
  if (inPre > 0) flushPre();
  endRow();
  const markdown = out.join("\n\n").replace(/[ \t]+$/gm, "");
  return markdown === "" ? "" : `${markdown}\n`;
}

/** A saved .html file's title, from bytes decoded as the page says it is. */
export function htmlTitleOf(bytes: Uint8Array): string | null {
  const source = decodeHtml(bytes);
  return source === null ? null : htmlTitle(source);
}

/** A page's title as its `head` says, or null. */
export function htmlTitle(source: string): string | null {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  if (!title) return null;
  const text = decodeHtmlEntities((title[1] ?? "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text;
}
