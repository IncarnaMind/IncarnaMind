/**
 * A Mind as HTML to print as a PDF (#100): the body, and its footnotes apart, which the print
 * page puts at the foot of the page each marker lands on. Citations and the User's own
 * footnotes are numbered together as in the other exports: one note for each source and place,
 * a later Citation of it repeating its number (#2292); a citation style's notes take their
 * numbers too, and its in-text Citations and Bibliography are in the body. Maths is typeset
 * (MathML); what KaTeX can't read stays LaTeX. Everything
 * from the Mind is escaped: the page shows text, never markup it was given. The HTML export
 * (./html) is the same document, its markers are links to the notes (`linkNotes`).
 * Someone's changes from a Word file still waiting are marked as Word prints
 * them, inserted words underlined and deleted ones struck, each with a note of
 * who made it and when (#734).
 */
import { footnoteSubjectKey } from "../../shared/citations";
import { FootnoteNumbering } from "../../shared/footnoteNumbers";
import { cssString } from "../../shared/mindStyle";
import { paragraphFormatDeclarations } from "../../shared/paragraphFormat";
import type { ParagraphFormat, StyledRun } from "../api";
import {
  type Block,
  type Footnote,
  type HeadingEntry,
  headingEntries,
  type Inline,
  type Marks,
  tableLayout,
} from "../mindText";
import { changedContent, changeEnding, changeSpans } from "../shownChanges";
import type { ExportLabels } from "./labels";
import { latexToMathMl } from "./math";
import { noteChecks } from "./noteChecks";

export type PrintLabels = ExportLabels;

export interface PrintHtml {
  body: string;
  notes: string[];
  /** The notes printed with the page, the User's own and changes' included: what the Saved line says (#2193). */
  footnotes: number;
}

export interface CitationWriter {
  note(footnote: Footnote): string;
  marker(footnote: Footnote, number: number): string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

type LinkTest = (href: string | null | undefined) => href is string;

/** Only links a PDF reader can follow without running anything. */
export const safeLink: LinkTest = (href): href is string =>
  typeof href === "string" && /^(https?:|mailto:)/i.test(href);

export const webLink: LinkTest = (href): href is string =>
  typeof href === "string" && /^https?:/i.test(href);

/** Where a page break was: the print page starts a new page there, and so does a browser printing it. */
const PAGE_BREAK = '<div class="page-break"></div>';

export function renderPrintHtml(
  blocks: readonly Block[],
  labels: PrintLabels,
  {
    linkNotes = false,
    citations = null,
    isLink = safeLink,
  }: { linkNotes?: boolean; citations?: CitationWriter | null; isLink?: LinkTest } = {},
): PrintHtml {
  const notes: string[] = [];
  const writer = new PrintWriter(
    labels,
    notes,
    linkNotes,
    citations,
    isLink,
    headingEntries(blocks),
    noteChecks(blocks),
  );
  const body = writer.finish(writer.blocks(blocks));
  return { body, notes, footnotes: notes.length };
}

/** A table of contents as the page draws it: its heading, then the Note's headings indented. */
function tocHtml(entries: readonly HeadingEntry[], labels: PrintLabels): string {
  if (entries.length === 0) return "";
  const lowest = Math.min(...entries.map((entry) => entry.level));
  const items = entries
    .map(
      (entry) =>
        `<li class="toc-entry toc-level-${entry.level}" style="padding-left:${(entry.level - lowest) * 16}px">${escapeHtml(entry.text)}</li>`,
    )
    .join("");
  return `<nav class="toc"><p class="toc-title">${escapeHtml(labels.contents)}</p><ul>${items}</ul></nav>`;
}

/** A style's formatted runs: italics, bold, small capitals, underlining, raised text and links. */
function runsHtml(runs: readonly StyledRun[], isLink: LinkTest): string {
  return runs
    .map((run) => {
      if (run.text === "") return "";
      let html = escapeHtml(run.text);
      if (run.script) html = `<${run.script}>${html}</${run.script}>`;
      if (run.smallCaps) html = `<span class="small-caps">${html}</span>`;
      if (run.underline) html = `<u>${html}</u>`;
      if (run.bold) html = `<b>${html}</b>`;
      if (run.italic) html = `<i>${html}</i>`;
      if (isLink(run.link)) html = `<a href="${escapeHtml(run.link)}">${html}</a>`;
      return html;
    })
    .join("");
}

/** The words of an unverified Citation's marker, after its source. */
const unverifiedHtml = (labels: PrintLabels) =>
  ` <span class="unverified">${escapeHtml(labels.unverified)}</span>`;

export const checkedHtml = (lines: readonly string[] | undefined): string =>
  (lines ?? []).map((line) => `<br><span class="checked-by">${escapeHtml(line)}</span>`).join("");

/** A Citation's source, as its footnote says it; a web page's address is a link. */
export function sourceHtml(
  footnote: Footnote,
  labels: PrintLabels,
  isLink: LinkTest = safeLink,
): string {
  const link = footnote.link;
  let html = escapeHtml(footnote.source);
  if (isLink(link) && footnote.source.includes(link)) {
    const at = footnote.source.lastIndexOf(link);
    html =
      escapeHtml(footnote.source.slice(0, at)) +
      `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>` +
      escapeHtml(footnote.source.slice(at + link.length));
  }
  return footnote.unverified ? html + unverifiedHtml(labels) : html;
}

function mathHtml(latex: string, display: boolean): string {
  const mathml = latexToMathMl(latex, display);
  if (mathml) return display ? `<div class="math-display">${mathml}</div>` : mathml;
  const source = display ? latex : `$${latex}$`;
  return display
    ? `<pre class="math-source">${escapeHtml(source)}</pre>`
    : `<code class="math-source">${escapeHtml(source)}</code>`;
}

function imageHtml(src: string, alt: string): string {
  // Only pictures held in the Mind: the print page fetches nothing.
  if (src.startsWith("data:image/"))
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
  return alt ? `<span class="image-missing">[${escapeHtml(alt)}]</span>` : "";
}

/** A point in proportion to the page's text, which is 11 pt in the Mind as in Word export. */
const pointLength = (points: number) => `calc(1.0625rem * ${points} / 11)`;

function formatStyle(format: ParagraphFormat | undefined): string {
  const declarations = format ? paragraphFormatDeclarations(format, pointLength) : [];
  return declarations.length > 0 ? ` style="${escapeHtml(declarations.join(";"))}"` : "";
}

/** Marks as HTML, outermost first. */
function wrap(text: string, marks: Marks, isLink: LinkTest): string {
  let html = escapeHtml(text);
  if (marks.vertical)
    html = marks.vertical === "superscript" ? `<sup>${html}</sup>` : `<sub>${html}</sub>`;
  const style = [
    marks.color ? `color:#${marks.color}` : "",
    marks.font ? `font-family:${cssString(marks.font)}` : "",
    marks.size ? `font-size:${pointLength(marks.size)}` : "",
  ].filter(Boolean);
  if (style.length > 0) html = `<span style="${escapeHtml(style.join(";"))}">${html}</span>`;
  if (marks.code) html = `<code>${html}</code>`;
  if (marks.highlight) html = `<mark>${html}</mark>`;
  if (marks.underline) html = `<u>${html}</u>`;
  if (marks.strike) html = `<s>${html}</s>`;
  if (marks.italic) html = `<em>${html}</em>`;
  if (marks.bold) html = `<strong>${html}</strong>`;
  if (isLink(marks.link)) html = `<a href="${escapeHtml(marks.link)}">${html}</a>`;
  return html;
}

class PrintWriter {
  /** The Mind's footnotes as every surface numbers them (#2292): one for each source and place. */
  private readonly numbering = new FootnoteNumbering();
  /** The notes whose first marker carries the id the note links back to. */
  private readonly linked = new Set<number>();
  /**
   * The notes that say who made a change: the page's own, numbered after the Citations' notes
   * so a change never moves a Citation's number away from the Note's (#2292).
   */
  private readonly changeNotes: string[] = [];

  constructor(
    private readonly labels: PrintLabels,
    /** The notes the page prints, in order: a note's number is its place here, from 1. */
    private readonly notes: string[],
    /** Markers link to their notes, and carry the id the note links back to. */
    private readonly linkNotes: boolean,
    private readonly citations: CitationWriter | null,
    private readonly isLink: LinkTest,
    private readonly headings: readonly HeadingEntry[] = [],
    /** The "Checked by" lines each note carries, by its key (see `noteChecks`). */
    private readonly checks: ReadonlyMap<string, readonly string[]> = new Map(),
  ) {}

  blocks(blocks: readonly Block[]): string {
    return blocks.map((block) => this.block(block)).join("");
  }

  /**
   * A paragraph's text, split where it has a page break (#746): the parts
   * apart, each in `wrap`, with a break between them that starts a new page.
   */
  private pages(content: readonly Inline[], wrap: (html: string) => string): string {
    if (!content.some((item) => item.kind === "pageBreak")) return wrap(this.inline(content));
    const parts: Inline[][] = [[]];
    for (const item of content) {
      if (item.kind === "pageBreak") parts.push([]);
      else parts.at(-1)?.push(item);
    }
    return parts.map((part) => (part.length > 0 ? wrap(this.inline(part)) : "")).join(PAGE_BREAK);
  }

  /** A footnote the page prints now: the User's own, a figure's note, or a citation style's. */
  private marker(note: string, adjacent = false): string {
    const number = this.numbering.footnote();
    this.notes.push(note);
    return this.markerAt(number, adjacent);
  }

  /**
   * A Citation's marker: its source and place's footnote number. The first Citation of a source
   * and place writes the note, and a later one points at it and shows its number (#1381); a
   * Citation a change still waiting adds or removes stands for itself, as its own note (#107).
   */
  private citationMarker(item: Extract<Inline, { kind: "citation" }>, adjacent: boolean): string {
    const subject = {
      documentId: item.work.documentId,
      contentHash: item.work.contentHash ?? null,
      location: item.work.location,
      unverified: item.footnote.unverified,
      link: item.footnote.link ?? null,
    };
    const shared = item.inserted === undefined && item.deleted === undefined;
    const key = shared ? footnoteSubjectKey(subject) : null;
    const numbered =
      key === null
        ? { number: this.numbering.footnote(), first: true }
        : this.numbering.citation(subject);
    if (numbered.first) {
      // A note stands for every Citation of its source and place, so it says a person's check
      // only where all of them carry it (`noteChecks`).
      const lines = key === null ? (item.footnote.checked ?? []) : (this.checks.get(key) ?? []);
      this.notes.push(sourceHtml(item.footnote, this.labels, this.isLink) + checkedHtml(lines));
    }
    return this.markerAt(numbered.number, adjacent);
  }
  /**
   * A marker: its note's number, and with links, the note's way back to the first marker that
   * shows it. A later Citation of the same note shows the same number, without a second id.
   */
  private markerAt(number: number, adjacent = false, classes = ""): string {
    const separator = adjacent ? "," : "";
    const style = `note-ref${classes}`;
    if (this.linkNotes) {
      const first = !this.linked.has(number);
      this.linked.add(number);
      return `<sup class="${style}"${first ? ` id="ref-${number}"` : ""}>${separator}<a href="#note-${number}">${number}</a></sup>`;
    }
    return `<sup class="${style}" data-note="${number}">${separator}${number}</sup>`;
  }

  /**
   * Where a change's note goes in the text, filled in by `finish` once the Citations' are
   * numbered; `adjacent` is the comma a marker right after another note shows.
   */
  private changeMarker(note: string, adjacent: boolean): string {
    const id = this.changeNotes.length;
    this.changeNotes.push(note);
    const after = adjacent ? ' data-adjacent="1"' : "";
    return `<sup class="note-ref change-note" data-change="${id}"${after}></sup>`;
  }

  /** The body with each change's marker numbered, and their notes after the Citations' notes. */
  finish(body: string): string {
    const base = this.notes.length;
    for (const note of this.changeNotes) this.notes.push(note);
    return body.replace(
      /<sup class="note-ref change-note" data-change="(\d+)"(?: data-adjacent="1")?><\/sup>/g,
      (found, id: string) =>
        this.markerAt(base + Number(id) + 1, found.includes("data-adjacent"), " change-note"),
    );
  }

  private block(block: Block): string {
    switch (block.kind) {
      case "paragraph":
        return this.pages(
          changedContent(block),
          (html) => `<p${formatStyle(block.format)}>${html}</p>`,
        );
      case "heading": {
        const level = Math.min(block.level + 1, 6);
        return this.pages(
          changedContent(block),
          (html) => `<h${level}${formatStyle(block.format)}>${html}</h${level}>`,
        );
      }
      case "question":
        return `<p class="question"><span class="question-label">${escapeHtml(this.labels.question)}</span> ${this.inline(changedContent(block))}</p>`;
      case "code":
        return `<pre><code>${escapeHtml(block.code)}</code></pre>`;
      case "math":
        return mathHtml(block.latex, true);
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
        const items = block.items.map((item) => `<li>${this.blocks(item)}</li>`).join("");
        return `<${tag}${start}>${items}</${tag}>`;
      }
      case "quote":
        return `<blockquote>${this.blocks(block.content)}</blockquote>`;
      case "rule":
        return "<hr>";
      case "table":
        return this.table(block.rows);
      case "image": {
        const html = imageHtml(block.image.src, block.image.alt);
        return html ? `<p class="image">${html}</p>` : "";
      }
      case "chart":
        return this.chart(block);
      case "toc":
        return tocHtml(this.headings, this.labels);
      case "bibliography": {
        const entries = block.items
          .map((item) => {
            const label = item.label
              ? `<span class="label">${runsHtml(item.label, this.isLink)}</span> `
              : "";
            return `<p class="entry">${label}${runsHtml(item.runs, this.isLink)}${checkedHtml(item.checked)}</p>`;
          })
          .join("");
        const hanging = block.hangingIndent ? " hanging" : "";
        return `<section class="bibliography${hanging}"><h2>${escapeHtml(block.heading)}</h2>${entries}</section>`;
      }
    }
  }

  /**
   * A chart as Word has it (#436): its picture, or with none (a host that can't draw one) the
   * table of its values; its caption; and its sources, each a numbered footnote in the Mind's
   * citation style. The picture and the caption keep with what follows them across a page break.
   */
  private chart(block: Extract<Block, { kind: "chart" }>): string {
    const { labels } = this;
    const picture = block.picture ? imageHtml(block.picture.src, block.picture.alt) : "";
    const shown = picture
      ? `<p class="image chart-picture keep-next">${picture}</p>`
      : this.table(block.table);
    const sources: string[] = [];
    const cited = this.inline(block.sources);
    if (cited) sources.push(escapeHtml(labels.chartSources) + cited);
    if (block.calculated > 0) sources.push(escapeHtml(labels.chartCalculated(block.calculated)));
    if (block.uncited > 0) sources.push(escapeHtml(labels.chartUncited(block.uncited)));
    const { rows, cutFrom } = block.chart.data;
    if (cutFrom !== null) sources.push(escapeHtml(labels.chartCut(rows.length, cutFrom)));
    const keep = sources.length > 0 ? " keep-next" : "";
    const caption = `<p class="caption${keep}">${escapeHtml(labels.chart(block.chart.title))}</p>`;
    const line =
      sources.length > 0 ? `<p class="caption chart-sources">${sources.join(" ")}</p>` : "";
    return shown + caption + line;
  }

  /** A table as laid out for Word and Markdown, its cells spanning as in the Mind. */
  private table(rows: Extract<Block, { kind: "table" }>["rows"]): string {
    const layout = tableLayout(rows);
    const body = layout.rows
      .map((row) => {
        const cells = row
          .filter((slot) => slot.cell && !slot.continued)
          .map(({ cell }) => {
            if (!cell) return "";
            const tag = cell.header ? "th" : "td";
            const spans =
              (cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "") +
              (cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "");
            const align = cell.align ? ` class="align-${cell.align}"` : "";
            return `<${tag}${spans}${align}>${this.blocks(cell.content)}</${tag}>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");
    return `<table>${body}</table>`;
  }

  /** Inline content, someone's changes in it marked, each with a note of who made it and when. */
  inline(content: readonly Inline[], inNote = false): string {
    const spans = changeSpans(content);
    const state = { lastWasNote: false };
    return spans
      .map(({ change, content: part }, at) => {
        const html = this.marked(part, inNote, state);
        if (!change) return html;
        const tag = change.kind === "insert" ? "ins" : "del";
        const marked = `<${tag} class="change">${html}</${tag}>`;
        const ended = changeEnding(spans, at);
        if (!ended) return marked;
        const note = escapeHtml(this.labels.change(ended));
        if (inNote) {
          state.lastWasNote = false;
          return `${marked} (${note})`;
        }
        const marker = this.changeMarker(note, state.lastWasNote);
        state.lastWasNote = true;
        return marked + marker;
      })
      .join("");
  }

  /** Inline content: text with its marks, maths, footnote markers and breaks. */
  private marked(
    content: readonly Inline[],
    inNote: boolean,
    state: { lastWasNote: boolean },
  ): string {
    let html = "";
    for (const item of content) {
      const before = html.length;
      let lastWasNote = false;
      switch (item.kind) {
        case "text":
          html += wrap(item.text, item.marks, this.isLink);
          break;
        case "break":
          html += "<br>";
          break;
        case "math":
          html += mathHtml(item.latex, false);
          break;
        case "figure":
          html += escapeHtml(item.figure.shown);
          break;
        case "image":
          html += imageHtml(item.image.src, item.image.alt);
          break;
        case "citation":
          // In the User's footnote, a Citation is its source, a word of the note's text.
          if (inNote) {
            if (/\S$/.test(html)) html += " ";
            html += sourceHtml(item.footnote, this.labels, this.isLink);
          } else if (this.citations) {
            const number = this.numbering.footnote();
            this.notes.push(this.citations.note(item.footnote));
            html += this.citations.marker(item.footnote, number);
          } else {
            html += this.citationMarker(item, state.lastWasNote);
            lastWasNote = true;
          }
          break;
        case "footnote":
          html += this.marker(this.inline(item.content, true), state.lastWasNote);
          lastWasNote = true;
          break;
        case "cite": {
          const marker = item.unverified ? unverifiedHtml(this.labels) : "";
          if (item.note && !inNote) {
            html += this.marker(
              runsHtml(item.runs, this.isLink) + marker + checkedHtml(item.checked),
              state.lastWasNote,
            );
            lastWasNote = true;
          } else html += runsHtml(item.runs, this.isLink) + marker;
          break;
        }
      }
      if (html.length !== before) state.lastWasNote = lastWasNote;
    }
    return html;
  }
}
