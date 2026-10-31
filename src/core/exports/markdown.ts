/**
 * A Mind as Markdown (CommonMark, with GitHub's tables and footnotes), for an
 * archive: Notes and Answers as Markdown, Questions marked as Questions, math
 * as `$…$` and `$$…$$`, highlights as `==…==` (as Obsidian, Typora and
 * markdown-it-mark read them), and each Citation and each footnote the User
 * wrote as a footnote, numbered together in the order they appear. A Citation
 * inside the User's footnote is written into its text, as its source.
 * Someone's changes from a Word file still waiting are CriticMarkup, each with
 * who made it and when: "{--by cheque--}{>>Deleted by Priya Nair, 2 Oct 2026<<}" (#734).
 */
import { createHash } from "node:crypto";
import type { TableAlign } from "../../shared/markdownTables";
import type { StyledRun } from "../api";
import {
  type Block,
  type Footnote,
  type HeadingEntry,
  headingEntries,
  type Image,
  type Inline,
  type Marks,
  tableLayout,
} from "../mindText";
import { changedContent, changeEnding, changeSpans } from "../shownChanges";
import type { ExportLabels } from "./labels";

export type MarkdownLabels = ExportLabels;

interface Context {
  /** Inside a table cell, where "|" must be escaped and lines can't break. */
  table: boolean;
  /** Inside the text of a footnote the User wrote. */
  note?: boolean;
}

/**
 * A footnote as written at the end: a Citation's source, or the text of the User's own, or a
 * citation style's note (#289), already Markdown.
 */
type Written = { kind: "citation"; footnote: Footnote } | { kind: "note"; text: string };

/** A picture written beside a Markdown export, which the text links by `name`. */
export interface MarkdownPicture {
  name: string;
  mediaType: string;
  data: Uint8Array;
}

/** A Markdown export: its text, and the pictures written beside it. */
export interface MarkdownExport {
  text: string;
  pictures: MarkdownPicture[];
}

export interface MarkdownOptions {
  /**
   * Whether a picture kept in the Note's data is written as a file beside the
   * text (an export) or read as its alt text (an outside agent that can open no
   * file).
   */
  pictures?: boolean;
}

export function renderMarkdown(
  title: string,
  blocks: readonly Block[],
  labels: MarkdownLabels,
  options: MarkdownOptions = {},
): MarkdownExport {
  const footnotes: Written[] = [];
  const pictures: MarkdownPicture[] = [];
  const writer = new MarkdownWriter(
    labels,
    (footnote) => {
      footnotes.push(footnote);
      return footnotes.length;
    },
    headingEntries(blocks),
    options.pictures === false ? null : (image) => pictureFile(image, pictures),
  );
  const parts: string[] = [];
  if (title) parts.push(`# ${escapeText(title, false)}`);
  const body = writer.blocks(blocks, { table: false });
  if (body) parts.push(body);
  if (footnotes.length > 0) {
    parts.push(
      footnotes
        .map((footnote, index) => {
          // A line break in a footnote's text goes on, indented, under its first line.
          const text =
            footnote.kind === "note"
              ? footnote.text.replace(/\n/g, "\n    ")
              : citationSource(footnote.footnote, labels);
          return `[^${index + 1}]: ${text}`;
        })
        .join("\n"),
    );
  }
  return { text: `${parts.join("\n\n")}\n`, pictures };
}

/**
 * Where a picture stands in the text: a data URL becomes a file beside the .md,
 * named after its bytes so the same picture is never written twice and a name
 * never changes; a picture from the web keeps its address.
 */
function pictureFile(
  image: Image,
  pictures: MarkdownPicture[],
): { src: string; alt?: string } | null {
  if (!image.src.startsWith("data:")) return image.src ? { src: image.src } : null;
  const decoded = decodeDataUrl(image.src);
  if (!decoded) return null;
  const name = `picture-${createHash("sha256").update(decoded.data).digest("hex").slice(0, 12)}.${decoded.extension}`;
  if (!pictures.some((each) => each.name === name)) {
    pictures.push({ name, mediaType: decoded.mediaType, data: decoded.data });
  }
  return { src: name, alt: image.alt };
}

/** A `data:` URL's bytes and media type, and the extension Outlook and Word use for them. */
function decodeDataUrl(
  url: string,
): { data: Uint8Array; mediaType: string; extension: string } | null {
  const match = /^data:(image\/[\w.+-]+);base64,([\s\S]*)$/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  const extension = match[1].slice("image/".length).toLowerCase().replace("jpeg", "jpg");
  if (!/^(png|jpg|gif|webp)$/.test(extension)) return null;
  const data = new Uint8Array(Buffer.from(match[2], "base64"));
  return data.length > 0 ? { data, mediaType: match[1], extension } : null;
}

/**
 * Text a citation style formatted: italics, bold and links as Markdown has them, raised and
 * lowered text as HTML (`<sup>`), which CommonMark keeps; small capitals and underlining have
 * no Markdown and are left as text.
 */
function runsMarkdown(runs: readonly StyledRun[], table: boolean): string {
  return runs
    .map((run) => {
      if (run.text === "") return "";
      let text = escapeText(run.text, table);
      if (run.script) text = `<${run.script}>${text}</${run.script}>`;
      if (run.bold) text = `**${text}**`;
      if (run.italic) text = `*${text}*`;
      if (run.link && /^(https?:|mailto:)/i.test(run.link)) {
        text = `[${text}](${destination(run.link)})`;
      }
      return text;
    })
    .join("");
}

class MarkdownWriter {
  constructor(
    private readonly labels: MarkdownLabels,
    /** Numbers a footnote: 1, 2, 3… in the order they are written. */
    private readonly number: (footnote: Written) => number,
    private readonly headings: readonly HeadingEntry[] = [],
    /** Where a picture goes; null when the text reads the alt text instead. */
    private readonly picture:
      | ((image: Image) => { src: string; alt?: string } | null)
      | null = null,
  ) {}

  blocks(blocks: readonly Block[], context: Context): string {
    return blocks
      .map((block) => this.block(block, context))
      .filter((text) => text.trim() !== "")
      .join("\n\n");
  }

  private block(block: Block, context: Context): string {
    switch (block.kind) {
      case "paragraph":
        return this.inline(changedContent(block), context)
          .split("\n")
          .map(escapeLineStart)
          .join("\n");
      case "heading": {
        const text = this.inline(changedContent(block), context).replace(/\\\n/g, " ");
        return text ? `${"#".repeat(block.level)} ${text}` : "";
      }
      case "question": {
        const text = this.inline(changedContent(block), context);
        return `**${this.labels.question}**${text ? ` ${text}` : ""}`;
      }
      case "code": {
        const longest = Math.max(0, ...(block.code.match(/`+/g) ?? []).map((run) => run.length));
        const fence = "`".repeat(Math.max(3, longest + 1));
        return `${fence}${block.language.replace(/[`\s]/g, "")}\n${block.code}\n${fence}`;
      }
      case "math":
        return `$$\n${block.latex}\n$$`;
      case "list":
        return this.list(block, context);
      case "quote":
        return this.blocks(block.content, context)
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n");
      case "rule":
        return "---";
      case "table":
        return this.table(block.rows);
      case "chart":
        return this.chart(block);
      case "image":
        return this.image(block.image, context, true);
      case "toc": {
        if (this.headings.length === 0) return "";
        const lowest = Math.min(...this.headings.map((entry) => entry.level));
        return [
          `**${this.labels.contents}**`,
          ...this.headings.map(
            (entry) => `${"  ".repeat(entry.level - lowest)}- ${escapeText(entry.text, false)}`,
          ),
        ].join("\n");
      }
      case "bibliography":
        return [
          `## ${escapeText(block.heading, false)}`,
          ...block.items.map((item) => {
            const label = item.label ? `${runsMarkdown(item.label, false)} ` : "";
            return escapeLineStart(label + runsMarkdown(item.runs, false));
          }),
        ].join("\n\n");
    }
  }

  private list(block: Extract<Block, { kind: "list" }>, context: Context): string {
    let number = block.start;
    return block.items
      .map((item, at) => {
        const marker = block.ordered ? `${number++}.` : "-";
        const checked = block.checked?.[at];
        const prefix = checked === undefined ? marker : `${marker} [${checked ? "x" : " "}]`;
        const indent = " ".repeat(marker.length + 1);
        // A list right under the item's text stays tight; other Blocks are a paragraph apart.
        let body = "";
        let started = false;
        for (const child of item) {
          const text = this.block(child, context);
          if (!text.trim()) {
            if (checked !== undefined && child.kind === "paragraph") started = true;
            continue;
          }
          if (started) body += child.kind === "list" ? "\n" : "\n\n";
          body += text;
          started = true;
        }
        if (!body) return checked === undefined ? prefix : `${prefix} `;
        return body
          .split("\n")
          .map((line, index) => (index === 0 ? `${prefix} ${line}` : line ? indent + line : ""))
          .join("\n");
      })
      .join("\n");
  }

  private chart(block: Extract<Block, { kind: "chart" }>): string {
    const parts = [`*${escapeText(this.labels.chart(block.chart.title), false)}*`];
    const table = this.table(block.table);
    if (table) parts.push(table);
    const sources: string[] = [];
    const cited = this.inline(block.sources, { table: false }).trim();
    if (cited) sources.push(`${escapeText(this.labels.chartSources, false)}${cited}`);
    if (block.calculated > 0)
      sources.push(escapeText(this.labels.chartCalculated(block.calculated), false));
    if (block.uncited > 0) sources.push(escapeText(this.labels.chartUncited(block.uncited), false));
    const { rows, cutFrom } = block.chart.data;
    if (cutFrom !== null)
      sources.push(escapeText(this.labels.chartCut(rows.length, cutFrom), false));
    if (sources.length > 0) parts.push(sources.join(" "));
    return parts.join("\n\n");
  }

  /**
   * A picture: a link to the file written beside the .md, or, for a reader that
   * can open none, its description as words. `block`: it stands on a line of
   * its own.
   */
  private image(image: Image, context: Context, block: boolean): string {
    const placed = this.picture?.(image) ?? null;
    if (!placed) {
      const description = escapeText(image.alt, context.table);
      return description ? (block ? description : ` ${description} `) : "";
    }
    const alt = placed.alt ?? image.alt;
    return placed.src ? `![${escapeText(alt, context.table)}](${destination(placed.src)})` : "";
  }

  /**
   * A GitHub table: its first row is the header row, as GitHub requires one,
   * and each column is aligned as its first row's cell is. A cell over
   * several columns or rows fills the first; the rest are left empty.
   */
  private table(rows: Extract<Block, { kind: "table" }>["rows"]): string {
    const layout = tableLayout(rows);
    const { columns } = layout;
    const align: TableAlign[] = [];
    const lines = layout.rows.map((row, index) => {
      const cells: string[] = [];
      for (const { cell, continued } of row) {
        if (index === 0) align.push(cell?.align ?? null);
        cells.push(
          cell && !continued
            ? this.blocks(cell.content, { table: true }).replace(/\n+/g, "<br>")
            : "",
        );
        for (let more = 1; more < (cell?.colspan ?? 1); more++) {
          if (index === 0) align.push(null);
          cells.push("");
        }
      }
      while (cells.length < columns) cells.push("");
      return `| ${cells.join(" | ")} |`;
    });
    if (lines.length === 0) return "";
    const delimiters = Array.from({ length: columns }, (_, column) => delimiter(align[column]));
    lines.splice(1, 0, `|${delimiters.map((each) => ` ${each} |`).join("")}`);
    return lines.join("\n");
  }

  /** Inline content, someone's changes in it as CriticMarkup with who made each and when. */
  inline(content: readonly Inline[], context: Context): string {
    const spans = changeSpans(content);
    return spans
      .map(({ change, content: part }, at) => {
        const text = notCriticMarkup(this.marked(part, context));
        if (!change) return text;
        const marked = change.kind === "insert" ? `{++${text}++}` : `{--${text}--}`;
        const ended = changeEnding(spans, at);
        if (!ended) return marked;
        const note = notCriticMarkup(escapeText(this.labels.change(ended), context.table));
        return `${marked}{>>${note}<<}`;
      })
      .join("");
  }

  /**
   * Inline content with its marks: **bold**, *italic*, ~~strike~~,
   * ==highlight==, `code` and [links](…), properly nested; $math$; footnote
   * references; hard breaks.
   */
  private marked(content: readonly Inline[], context: Context): string {
    let out = "";
    /** Marks open at this point, outermost first. */
    let open: OpenMark[] = [];

    /** Closes the open marks from `from` up; whitespace before them moves after them, as CommonMark needs. */
    const closeFrom = (from: number) => {
      if (from >= open.length) return;
      const trailing = /[ \t]*$/.exec(out)?.[0] ?? "";
      out = out.slice(0, out.length - trailing.length);
      for (const mark of open.slice(from).reverse()) out += closingDelimiter(mark);
      out += trailing;
      open = open.slice(0, from);
    };

    for (const item of content) {
      if (item.kind === "break") {
        closeFrom(0);
        out += context.table ? "<br>" : "\\\n";
        continue;
      }
      if (item.kind !== "text") {
        // A Citation in a footnote's text is a word of it, apart from the one before.
        if (item.kind === "citation" && context.note && /\S$/.test(out)) out += " ";
        out += this.atom(item, context);
        continue;
      }
      const wanted = wantedMarks(item.marks);
      const keep = open.findIndex((mark) => !wanted.some((want) => sameMark(want, mark)));
      if (keep >= 0) closeFrom(keep);
      let text = item.text;
      const toOpen = wanted.filter((want) => !open.some((mark) => sameMark(want, mark)));
      if (toOpen.length > 0 && text.trim() !== "") {
        // Whitespace stays outside the delimiters.
        const leading = /^[ \t]*/.exec(text)?.[0] ?? "";
        out += leading;
        text = text.slice(leading.length);
        for (const mark of toOpen) out += openingDelimiter(mark);
        open = [...open, ...toOpen];
      }
      out += item.marks.code ? codeSpan(text, context) : escapeText(text, context.table);
    }
    closeFrom(0);
    return out;
  }

  private atom(item: Exclude<Inline, { kind: "text" | "break" }>, context: Context): string {
    switch (item.kind) {
      case "math":
        return `$${item.latex}$`;
      case "figure":
        return escapeText(item.figure.shown, context.table);
      case "citation":
        if (context.note) return citationSource(item.footnote, this.labels);
        return `[^${this.number({ kind: "citation", footnote: item.footnote })}]`;
      case "footnote":
        return `[^${this.number({ kind: "note", text: this.inline(item.content, { table: false, note: true }) })}]`;
      case "image":
        return this.image(item.image, context, false);
      case "cite": {
        // A style's note is a footnote of its own; in the text, or in a footnote's text, its words.
        if (item.note && !context.note) {
          const marker = item.unverified ? ` ${this.labels.unverified}` : "";
          return `[^${this.number({ kind: "note", text: runsMarkdown(item.runs, false) + marker })}]`;
        }
        const text = runsMarkdown(item.runs, context.table);
        return item.unverified
          ? `${text} ${escapeText(this.labels.unverified, context.table)}`
          : text;
      }
    }
  }
}

/** A Citation's source, as its footnote says it, e.g. "Tides, p. 2 [unverified]". */
function citationSource(footnote: Footnote, labels: MarkdownLabels): string {
  const marker = footnote.unverified ? ` ${labels.unverified}` : "";
  return `${escapeText(footnote.source, false)}${marker}`;
}

/** A column's cell in a table's delimiter row, which says how the column is aligned. */
function delimiter(align: TableAlign | undefined): string {
  switch (align) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

type OpenMark =
  | { kind: "link"; href: string }
  | { kind: "bold" | "italic" | "strike" | "highlight" };

/** The marks Markdown can write, outermost first. Underline has no Markdown. */
function wantedMarks(marks: Marks): OpenMark[] {
  const wanted: OpenMark[] = [];
  if (marks.link) wanted.push({ kind: "link", href: marks.link });
  if (marks.bold) wanted.push({ kind: "bold" });
  if (marks.italic) wanted.push({ kind: "italic" });
  if (marks.strike) wanted.push({ kind: "strike" });
  if (marks.highlight) wanted.push({ kind: "highlight" });
  return wanted;
}

const sameMark = (a: OpenMark, b: OpenMark) =>
  a.kind === b.kind && (a.kind !== "link" || (b.kind === "link" && a.href === b.href));

function openingDelimiter(mark: OpenMark): string {
  switch (mark.kind) {
    case "link":
      return "[";
    case "bold":
      return "**";
    case "italic":
      return "*";
    case "strike":
      return "~~";
    case "highlight":
      return "==";
  }
}

function closingDelimiter(mark: OpenMark): string {
  return mark.kind === "link" ? `](${destination(mark.href)})` : openingDelimiter(mark);
}

/** A link or image destination: spaces and parentheses would end it early. */
const destination = (url: string) => url.replace(/[ ()<>]/g, (char) => encodeURIComponent(char));

/**
 * Escapes what Markdown would read as formatting: emphasis, code, links, math,
 * HTML, entities, and the "==" of a highlight. A "=" is escaped only where it
 * could make one: before another, or at either end of the text, which a
 * highlight's "==" may be written next to.
 */
/** Text with CriticMarkup's delimiters escaped, so only the writer opens or closes a change or its note. */
const notCriticMarkup = (text: string) =>
  text.replace(/\{(?=\+\+|--|>>|~~|==)/g, "\\{").replace(/(\+\+|--|<<|~~|==)\}/g, "$1\\}");

function escapeText(text: string, table: boolean): string {
  const escaped = text
    .replace(/[\\`*_~[\]$<]/g, "\\$&")
    .replace(/&(?=#?\w+;)/g, "\\&")
    .replace(/^=|=(?==|[ \t]*$)/g, "\\=");
  return table ? escaped.replace(/\|/g, "\\|") : escaped;
}

function codeSpan(text: string, context: Context): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  const code = context.table ? text.replace(/\|/g, "\\|") : text;
  return `${fence}${pad}${code}${pad}${fence}`;
}

/**
 * Escapes what would start a heading, a quote, a list or a thematic break at
 * the start of a line of a paragraph.
 */
function escapeLineStart(line: string): string {
  const indent = /^ {0,3}/.exec(line)?.[0] ?? "";
  const rest = line.slice(indent.length);
  // "#" headings, ">" quotes, "-" and "+" list items.
  if (/^(#{1,6}|[+-])([ \t]|$)/.test(rest) || rest.startsWith(">")) return `${indent}\\${rest}`;
  // A line of "-" or "=" under a paragraph's text makes it a heading, or a thematic break.
  if (/^(-+|=+)[ \t]*$/.test(rest)) return `${indent}\\${rest}`;
  // "1." and "1)" ordered list items.
  const ordered = /^(\d{1,9})[.)]([ \t]|$)/.exec(rest);
  if (ordered?.[1]) return `${indent}${ordered[1]}\\${rest.slice(ordered[1].length)}`;
  return line;
}
