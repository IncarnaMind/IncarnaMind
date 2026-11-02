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
import { decodeEntities } from "./xml";

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

/** A block being read: its Markdown form, and the text gathered for it. */
interface Block {
  kind: "paragraph" | "heading" | "listItem" | "pre";
  level: number;
  /** A table's cells gathered from its `td` and `th`. */
  cells?: string[];
}

/**
 * A saved .html file's text as Markdown, with its headings. Throws
 * `ExtractionError` when the bytes aren't text.
 */
export function htmlMarkdown(bytes: Uint8Array): string {
  const source = decodeText(bytes);
  if (source === null) {
    throw new ExtractionError("unreadable", "The file holds binary data, not text.");
  }
  return htmlTextToMarkdown(source);
}

/** As `htmlMarkdown`, from text already decoded. */
export function htmlTextToMarkdown(source: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let block: Block | null = null;
  let text = "";
  let silent = 0;
  let pre = "";
  let inPre = 0;
  let row: string[] | null = null;
  let cell: string | null = null;

  const flushBlock = () => {
    const value = text.replace(/[ \t\n]+/g, " ").trim();
    text = "";
    const current = block;
    block = null;
    if (!current || value === "") return;
    if (current.kind === "heading") {
      out.push(`${"#".repeat(Math.min(6, Math.max(1, current.level)))} ${value}`);
      return;
    }
    if (current.kind === "listItem") {
      out.push(`- ${value}`);
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
    // A fence longer than any run of backticks in it, as Markdown needs.
    const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    out.push(`${fence}\n${value}\n${fence}`);
  };

  const endCell = () => {
    if (cell === null || row === null) return;
    row.push(cell.replace(/[ \t\n]+/g, " ").trim());
    cell = null;
  };
  const endRow = () => {
    endCell();
    if (row === null) return;
    const cells = row;
    row = null;
    if (cells.some(Boolean)) out.push(cells.join(" | "));
  };

  const closeUntil = (name: string) => {
    for (let at = open.length - 1; at >= 0; at--) {
      if (open[at] !== name) continue;
      for (let pop = open.length - 1; pop >= at; pop--) {
        const closed = open[pop] as string;
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
      }
      open.length = at;
      return;
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
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const end = source.indexOf(">", lt + 1);
      at = end < 0 ? source.length : end + 1;
      continue;
    }
    const gt = source.indexOf(">", lt + 1);
    if (gt < 0) break;
    const tag = source.slice(lt + 1, gt);
    at = gt + 1;
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim().toLowerCase().split(/\s/)[0] ?? "";
      if (SILENT.has(name) && open.includes(name)) closeUntil(name);
      else closeTag(name);
      continue;
    }
    const name = /^[a-zA-Z][^\s/>]*/.exec(tag)?.[0].toLowerCase() ?? "";
    if (name === "") continue;
    startTag(name, tag, tag.endsWith("/"));
  }

  function textAfter(raw: string) {
    const value = decodeEntities(raw);
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
    if (silent > 0 && open.includes("head") && name !== "head" && !IN_HEAD.has(name)) {
      closeUntil("head");
    }
    if (name === "br") {
      if (silent > 0) return;
      if (inPre > 0) pre += "\n";
      else if (block) text += "\n";
      return;
    }
    if (!selfClosing) open.push(name);
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
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const value = decodeEntities(alt?.[1] ?? alt?.[2] ?? "").trim();
      if (value !== "") textAfter(value);
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

/** A page's title as its `head` says, or null. */
export function htmlTitle(source: string): string | null {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  if (!title) return null;
  const text = decodeEntities((title[1] ?? "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text;
}
