/**
 * A Mind as HTML to print as a PDF (#100): the body, and its footnotes apart, which the print
 * page puts at the foot of the page each marker lands on. Citations and the User's own
 * footnotes are numbered together in the order they appear, as in the other exports; a
 * citation style's notes take their numbers too, and its in-text Citations and Bibliography
 * are in the body. Maths is typeset (MathML); what KaTeX can't read stays LaTeX. Everything
 * from the Mind is escaped: the page shows text, never markup it was given. The HTML export
 * (./html) is the same document, its markers are links to the notes (`linkNotes`).
 * Someone's changes from a Word file still waiting are marked as Word prints
 * them, inserted words underlined and deleted ones struck, each with a note of
 * who made it and when (#734).
 */
import { cssString } from "../../shared/mindStyle";
import { paragraphFormatDeclarations } from "../../shared/paragraphFormat";
import type { ParagraphFormat, StyledRun } from "../api";
import { type Block, type Footnote, type Inline, type Marks, tableLayout } from "../mindText";
import { changedContent, changeEnding, changeSpans } from "../shownChanges";
import type { ExportLabels } from "./labels";
import { latexToMathMl } from "./math";

export type PrintLabels = ExportLabels;

export interface PrintHtml {
  body: string;
  notes: string[];
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
    (note) => {
      notes.push(note);
      return notes.length;
    },
    linkNotes,
    citations,
    isLink,
  );
  return { body: writer.blocks(blocks), notes };
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

/** People's own checks of a source, a line each under it (#1933). */
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
  constructor(
    private readonly labels: PrintLabels,
    /** Numbers a footnote, given as HTML: 1, 2, 3… in the order they are written. */
    private readonly number: (note: string) => number,
    /** Markers link to their notes, and carry the id the note links back to. */
    private readonly linkNotes: boolean,
    private readonly citations: CitationWriter | null,
    private readonly isLink: LinkTest,
  ) {}

  blocks(blocks: readonly Block[]): string {
    return blocks.map((block) => this.block(block)).join("");
  }

  private marker(note: string, adjacent = false): string {
    const number = this.number(note);
    const separator = adjacent ? "," : "";
    if (this.linkNotes) {
      return `<sup class="note-ref" id="ref-${number}">${separator}<a href="#note-${number}">${number}</a></sup>`;
    }
    return `<sup class="note-ref" data-note="${number}">${separator}${number}</sup>`;
  }

  private block(block: Block): string {
    switch (block.kind) {
      case "paragraph":
        return `<p${formatStyle(block.format)}>${this.inline(changedContent(block))}</p>`;
      case "heading": {
        const level = Math.min(block.level + 1, 6);
        return `<h${level}${formatStyle(block.format)}>${this.inline(changedContent(block))}</h${level}>`;
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
        const marker = this.marker(note, state.lastWasNote);
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
            const number = this.number(this.citations.note(item.footnote));
            html += this.citations.marker(item.footnote, number);
          } else {
            html += this.marker(
              sourceHtml(item.footnote, this.labels, this.isLink) +
                checkedHtml(item.footnote.checked),
              state.lastWasNote,
            );
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
            html += this.marker(runsHtml(item.runs, this.isLink) + marker, state.lastWasNote);
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
