/**
 * A Mind as a Word document (.docx), the deliverable: Office Open XML
 * WordprocessingML, written here rather than with the `docx` package. The
 * export needs a fixed, small part of the format (styles, headings, lists,
 * tables, images and footnotes), and the package would bring five more
 * packages (jszip, xml-js, …) and about 17 MB for it. The ZIP container is
 * written by the one ZIP module (../documents/formats/zip), deflated with
 * Node's zlib.
 *
 * Headings use Word's built-in heading styles, so they show in Word's
 * navigation pane; lists are Word lists; each Citation, and each footnote
 * the User wrote, is a real Word footnote, so Word numbers them together;
 * maths is Word's own equations (./math), or its LaTeX as text where it
 * can't be converted; code is monospaced paragraphs.
 */

import { deflateRawSync } from "node:zlib";
import type { TableAlign } from "../../shared/markdownTables";
import type { ParagraphFormat, StyledRun } from "../api";
import { writeZip } from "../documents/formats/zip";
import {
  type Block,
  type FailedSentence,
  type Footnote,
  type Image,
  type Inline,
  type Marks,
  type Pendings,
  type TableCell,
  tableLayout,
} from "../mindText";
import { HEADER_AND_FOOTER_DISTANCE, MARGIN, PAPER } from "../pageDefaults";
import { changeKey } from "./citations";
import type { ExportLabels } from "./labels";
import { latexToOmml, MATH_NAMESPACE } from "./math";
import { changedElement, formatChanges } from "./paragraphFormat";
import {
  bookmarked,
  COMMENTS_CONTENT_TYPE,
  COMMENTS_RELATIONSHIP,
  type CommentStyles,
  commentsPart,
  escapeXml,
  type FootnoteStyles,
  footnote,
  footnoteReference,
  footnotesPart,
  noteBookmark,
  noteNumber,
  R_NAMESPACE,
  type RunFormat,
  run,
  W_NAMESPACE,
  WordIds,
  XML_DECLARATION,
} from "./wordml";
import { type Piece, Review, type ReviewChoices, trackBlocks, trackInline } from "./wordReview";

export interface DocxOptions {
  /** The Mind's name, as the file's Title property (`dc:title`); the page has no title line. Empty: none. */
  title: string;
  labels: ExportLabels;
  /** The language Word checks the text in, e.g. "en-US". */
  language: string;
  paper: "letter" | "a4";
  /** When the document was made, ISO 8601. */
  created: string;
  /** What the file says for review (#107); none: Blocks read for review are written as they read. */
  review?: ReviewChoices;
  /** The Mind's font by name, which the body is written in; null: Word's own body font. */
  font: string | null;
  /** The Mind's line spacing, a multiple of a single line; null: the export's own. */
  lineSpacing: number | null;
}

/** The prefixes the writer writes, and their namespaces. */
export const WRITER_NAMESPACES: ReadonlyMap<string, string> = new Map([
  ["w", W_NAMESPACE],
  ["r", R_NAMESPACE],
  ["wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"],
  ["a", "http://schemas.openxmlformats.org/drawingml/2006/main"],
  ["pic", "http://schemas.openxmlformats.org/drawingml/2006/picture"],
  ["m", MATH_NAMESPACE],
]);

const NS = {
  w: W_NAMESPACE,
  r: R_NAMESPACE,
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  m: MATH_NAMESPACE,
  packageRelationships: "http://schemas.openxmlformats.org/package/2006/relationships",
  contentTypes: "http://schemas.openxmlformats.org/package/2006/content-types",
} as const;

const RELATIONSHIP = {
  officeDocument: `${NS.r}/officeDocument`,
  coreProperties:
    "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  styles: `${NS.r}/styles`,
  settings: `${NS.r}/settings`,
  numbering: `${NS.r}/numbering`,
  footnotes: `${NS.r}/footnotes`,
  image: `${NS.r}/image`,
  hyperlink: `${NS.r}/hyperlink`,
} as const;

const MAIN_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml";

/**
 * Stand in for a cross-reference's number until `DocxWriter.finish` knows it. XML can't hold
 * these two characters, so `escapeXml` takes them out of the User's text: nothing they wrote can
 * look like a mark, and `finish` replaces nothing but its own.
 */
const NUMBER_OPEN = "\u0001";
const NUMBER_CLOSE = "\u0002";
const NUMBER_MARK = new RegExp(`${NUMBER_OPEN}(\\d+)${NUMBER_CLOSE}`, "g");
/** A note's mark in the text, as `footnoteReference` writes it. */
const NOTE_MARK =
  /<w:r><w:rPr><w:rStyle w:val="[^"]*"\/><\/w:rPr><w:footnoteReference w:id="(\d+)"\/><\/w:r>/g;

/** One level of a list, or of a quote, indents this much (half an inch). */
const INDENT = 720;
/** A list item's number or bullet hangs this far left of its text. */
const HANGING = 360;
/** A to-do's box is at the text edge, its text 28px in; a nested to-do steps in 24px, as in the editor. */
const TODO_TEXT = 420;
const TODO_STEP = 360;
/** Word has no to-do: one is a paragraph that starts with this box and a tab. */
const BOX = { open: "\u2610", done: "\u2612" } as const;
/** EMUs (DrawingML's unit) per twip, and per CSS pixel at 96 dpi. */
const EMU_PER_TWIP = 635;
const EMU_PER_PIXEL = 9525;

export function renderDocx(
  blocks: readonly Block[],
  options: DocxOptions,
): { data: Uint8Array; commented: FailedSentence[] } {
  const paper = PAPER[options.paper];
  const target = new NewDocxTarget();
  const review = options.review
    ? new Review(options.review, target.ids, options.labels, () => NEW_DOCUMENT_STYLES.comment)
    : null;
  review?.mark(piecesOf(blocks));
  const writer = new DocxWriter(options.labels, paper.width - 2 * MARGIN, target, review);
  const body = writer.body(blocks);

  const document = writer.finish(
    `${XML_DECLARATION}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:m="${NS.m}"><w:body>` +
      body +
      `<w:sectPr><w:pgSz w:w="${paper.width}" w:h="${paper.height}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="${HEADER_AND_FOOTER_DISTANCE}" w:footer="${HEADER_AND_FOOTER_DISTANCE}" w:gutter="0"/></w:sectPr>` +
      "</w:body></w:document>",
  );

  const comments = review?.comments ?? [];
  const relationships = [
    { id: "rIdStyles", type: RELATIONSHIP.styles, target: "styles.xml" },
    { id: "rIdSettings", type: RELATIONSHIP.settings, target: "settings.xml" },
    { id: "rIdNumbering", type: RELATIONSHIP.numbering, target: "numbering.xml" },
    { id: "rIdFootnotes", type: RELATIONSHIP.footnotes, target: "footnotes.xml" },
    ...(comments.length > 0
      ? [{ id: "rIdComments", type: COMMENTS_RELATIONSHIP, target: "comments.xml" }]
      : []),
    ...target.relationships,
  ];

  const data = writeZip(
    [
      { name: "[Content_Types].xml", data: contentTypes(comments.length > 0) },
      {
        name: "_rels/.rels",
        data: relationshipsXml([
          { id: "rIdDocument", type: RELATIONSHIP.officeDocument, target: "word/document.xml" },
          { id: "rIdCore", type: RELATIONSHIP.coreProperties, target: "docProps/core.xml" },
        ]),
      },
      { name: "docProps/core.xml", data: coreProperties(options) },
      { name: "word/document.xml", data: document },
      { name: "word/_rels/document.xml.rels", data: relationshipsXml(relationships) },
      {
        name: "word/styles.xml",
        data: styles(options.language, comments.length > 0, options.font, options.lineSpacing),
      },
      { name: "word/settings.xml", data: SETTINGS },
      { name: "word/numbering.xml", data: numbering(target.lists) },
      { name: "word/footnotes.xml", data: footnotesPart(writer.footnotes) },
      ...(comments.length > 0 ? [{ name: "word/comments.xml", data: commentsPart(comments) }] : []),
      // Links in footnotes are the footnotes part's own relationships.
      ...(target.noteRelationships.length > 0
        ? [
            {
              name: "word/_rels/footnotes.xml.rels",
              data: relationshipsXml(target.noteRelationships),
            },
          ]
        : []),
      ...target.media.map((file) => ({ name: `word/media/${file.name}`, data: file.data })),
    ],
    deflateRawSync,
  );
  return { data, commented: review?.commentedSentences() ?? [] };
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external?: boolean;
}

/**
 * The style ids Blocks are written in: a new document's own, or those an
 * imported document has for the same styles, which Word may name otherwise
 * (#105).
 */
export interface DocxStyles {
  heading(level: number): string;
  quote: string;
  question: string;
  listParagraph: string;
  code: string;
  codeChar: string;
  math: string;
  caption: string;
  hyperlink: string;
  tableGrid: string;
  footnote: FootnoteStyles;
  comment: CommentStyles;
}

export const NEW_DOCUMENT_STYLES: DocxStyles = {
  heading: (level) => `Heading${level}`,
  quote: "Quote",
  question: "Question",
  listParagraph: "ListParagraph",
  code: "Code",
  codeChar: "CodeChar",
  math: "Math",
  caption: "Caption",
  hyperlink: "Hyperlink",
  tableGrid: "TableGrid",
  footnote: { text: "FootnoteText", reference: "FootnoteReference" },
  comment: { text: "CommentText", reference: "CommentReference" },
};

/** A picture to add to the package. */
export interface NewPicture {
  data: Uint8Array;
  extension: DecodedImage["extension"];
}

/**
 * Where Blocks are written: a new document, or an imported one written back
 * into (#105), whose ids, relationships, pictures and lists are already
 * there and must not be handed out twice.
 */
export interface DocxTarget {
  readonly styles: DocxStyles;
  readonly ids: WordIds;
  /** A web link's relationship, from the document part or, `inNote`, the footnotes part. */
  link(href: string, inNote: boolean): string;
  /** A new picture's relationship from the document part, and its part's file name. */
  picture(picture: NewPicture): { id: string; name: string };
  /** A numbering instance for a list at `level` that starts at `start`: its numId. */
  list(ordered: boolean, level: number, start: number): number;
  /** The bookmark around a note's mark that later Citations refer to: a name the file doesn't have. */
  noteBookmark(note: number): string;
}

/** A new document: links, pictures and lists numbered from 1, in the order they are written. */
class NewDocxTarget implements DocxTarget {
  readonly styles = NEW_DOCUMENT_STYLES;
  /** The footnotes' and drawings' ids, each from 1. */
  readonly ids = new WordIds();
  readonly relationships: Relationship[] = [];
  /** The footnotes part's relationships: its links. */
  readonly noteRelationships: Relationship[] = [];
  readonly media: { name: string; data: Uint8Array }[] = [];
  /** Each list written: a Word numbering instance, numbered from 1. */
  readonly lists: List[] = [];
  private readonly links = new Map<string, string>();
  private readonly noteLinks = new Map<string, string>();

  link(href: string, inNote: boolean): string {
    const known = inNote ? this.noteLinks : this.links;
    let id = known.get(href);
    if (!id) {
      id = `${inNote ? "rIdNoteLink" : "rIdLink"}${known.size + 1}`;
      known.set(href, id);
      (inNote ? this.noteRelationships : this.relationships).push({
        id,
        type: RELATIONSHIP.hyperlink,
        target: href,
        external: true,
      });
    }
    return id;
  }

  picture(picture: NewPicture): { id: string; name: string } {
    const number = this.media.length + 1;
    const name = `image${number}.${picture.extension}`;
    const id = `rIdImage${number}`;
    this.media.push({ name, data: picture.data });
    this.relationships.push({ id, type: RELATIONSHIP.image, target: `media/${name}` });
    return { id, name };
  }

  list(ordered: boolean, level: number, start: number): number {
    this.lists.push({ ordered, level, start });
    return this.lists.length;
  }

  noteBookmark(note: number): string {
    return noteBookmark(note);
  }
}

/** Where Blocks are being written. */
interface Context {
  /** The left indent of their text, in twips. */
  indent: number;
  /** The paragraph style of their text: quotes and list items have their own. */
  style: string | null;
  /** How deep in lists they are, from 0. */
  listDepth: number;
  /** All their text is bold, e.g. in a table's header row. */
  bold: boolean;
  /** The width available, in twips. */
  width: number;
  /** How their paragraphs are aligned, e.g. in a table's cell; null: as the text flows. */
  align: TableAlign;
  /**
   * How far in to-dos they are, from 0: a nested to-do steps in 24px, where a list's levels step
   * in 48px, so the two are counted apart.
   */
  todo?: number;
  /** In a footnote's text, whose links are the footnotes part's. */
  note?: boolean;
  /** In a Block a change still waiting gives or takes away, whose Citations share no note. */
  pending?: boolean;
}

export interface List {
  ordered: boolean;
  level: number;
  start: number;
}

/** The context of a Block a change still waiting gives or takes away: its Citations share no note. */
function pendingContext(block: Block, context: Context): Context {
  return block.inserted || block.deleted ? { ...context, pending: true } : context;
}

/**
 * Writes Blocks as WordprocessingML into a target: a new document's body, or
 * Blocks added to an imported one (#105). The `<w:footnote>` of each Citation
 * and footnote it writes is in `footnotes`, in order.
 */
export class DocxWriter {
  readonly footnotes: string[] = [];
  private readonly styles: DocxStyles;
  private readonly notes = new Map<string, { id: number; text: string; reused: boolean }>();

  constructor(
    private readonly labels: ExportLabels,
    private readonly textWidth: number,
    private readonly target: DocxTarget,
    /** Changes still waiting, as tracked changes, and comments (#107); none: neither. */
    private readonly review: Review | null = null,
  ) {
    this.styles = target.styles;
  }

  /** XML written for content that changes still waiting add or remove: their tracked changes. */
  private tracked(xml: string, change: Pendings, blocks: boolean): string {
    const { review } = this;
    if (!review) return xml;
    const track = blocks ? trackBlocks : trackInline;
    let out = xml;
    if (change.deleted) out = track(out, review.pending("delete", change.deleted), this.target.ids);
    if (change.inserted)
      out = track(out, review.pending("insert", change.inserted), this.target.ids);
    return out;
  }

  body(blocks: readonly Block[]): string {
    const xml = this.render(blocks);
    // The body's last element before its section properties must be a paragraph.
    return xml.endsWith("</w:p>") ? xml : `${xml}<w:p/>`;
  }

  /** Blocks at the top of the text, at its full width. */
  render(blocks: readonly Block[]): string {
    return this.blocks(blocks, {
      indent: 0,
      style: null,
      listDepth: 0,
      bold: false,
      width: this.textWidth,
      align: null,
    });
  }

  /** Inline content in a paragraph of the text: runs, and a footnote's reference for each Citation. */
  inlineXml(content: readonly Inline[]): string {
    return this.inline(content, {
      indent: 0,
      style: null,
      listDepth: 0,
      bold: false,
      width: this.textWidth,
      align: null,
    });
  }

  private blocks(blocks: readonly Block[], context: Context): string {
    let xml = "";
    for (const block of blocks) {
      const next = this.tracked(this.block(block, pendingContext(block, context)), block, true);
      // Two tables in a row would merge into one.
      if (xml.endsWith("</w:tbl>") && next.startsWith("<w:tbl>")) xml += "<w:p/>";
      xml += next;
    }
    return xml;
  }

  private block(block: Block, context: Context): string {
    const { indent } = context;
    switch (block.kind) {
      case "paragraph":
        return paragraph(
          { style: context.style, indent, align: context.align, format: block.format },
          this.inline(block.content, context),
        );
      case "heading":
        return paragraph(
          {
            style: this.styles.heading(block.level),
            indent,
            align: context.align,
            format: block.format,
          },
          this.inline(block.content, context),
        );
      case "question":
        return paragraph(
          { style: this.styles.question, indent },
          run(`${this.labels.question} `, { bold: true }) + this.inline(block.content, context),
        );
      case "code": {
        const lines = block.code.split(/\r\n|\r|\n/);
        return lines
          .map((line, index) =>
            paragraph(
              {
                style: this.styles.code,
                indent,
                spacingAfter: index === lines.length - 1 ? 160 : undefined,
              },
              run(line),
            ),
          )
          .join("");
      }
      case "math": {
        // A display equation, or its LaTeX if it can't be one.
        const equation = latexToOmml(block.latex, true);
        return paragraph(
          { style: this.styles.math, indent },
          equation ? `<m:oMathPara>${equation}</m:oMathPara>` : run(`$$${block.latex}$$`),
        );
      }
      case "list":
        return this.list(block, context);
      case "quote":
        return this.blocks(block.content, {
          ...context,
          indent: indent + INDENT,
          style: this.styles.quote,
        });
      case "rule":
        return paragraph({ indent, bottomBorder: true }, "");
      case "table":
        return this.table(block.rows, context, block.widths);
      case "image":
        return paragraph({ style: context.style, indent }, this.image(block.image, context));
      case "chart":
        return this.chart(block, context);
      case "bibliography":
        return this.bibliography(block);
    }
  }

  /** With no picture (a host that can't draw one), the table of its values instead. */
  private chart(block: Extract<Block, { kind: "chart" }>, context: Context): string {
    const { indent } = context;
    const { labels } = this;
    const shown = block.picture
      ? paragraph({ indent, keepNext: true }, this.image(block.picture, context))
      : this.table(block.table, context);
    let sources = "";
    const cited = this.inline(block.sources, context);
    if (cited) sources += run(labels.chartSources) + cited;
    if (block.uncited > 0) {
      sources += run(`${sources ? " " : ""}${labels.chartUncited(block.uncited)}`);
    }
    const { rows, cutFrom } = block.chart.data;
    if (cutFrom !== null)
      sources += run(`${sources ? " " : ""}${labels.chartCut(rows.length, cutFrom)}`);
    return (
      shown +
      paragraph(
        { style: this.styles.caption, indent, keepNext: sources !== "" },
        run(labels.chart(block.chart.title)),
      ) +
      (sources ? paragraph({ style: this.styles.caption, indent }, sources) : "")
    );
  }

  /**
   * The Bibliography a citation style made (#289): its heading, then one paragraph per entry,
   * hanging if the style hangs them. A number the style sets apart ("[1]") sits in the hang,
   * with a tab before the entry's text.
   */
  private bibliography(block: Extract<Block, { kind: "bibliography" }>): string {
    const labelled = block.items.some((item) => item.label !== null);
    const hang = labelled || block.hangingIndent ? INDENT : undefined;
    return (
      paragraph({ style: this.styles.heading(1) }, run(block.heading)) +
      block.items
        .map((item) =>
          paragraph(
            { indent: hang, hanging: hang },
            (item.label ? `${this.styled(item.label)}<w:r><w:tab/></w:r>` : "") +
              this.styled(item.runs),
          ),
        )
        .join("")
    );
  }

  /**
   * Text a citation style formatted, run by run; its web addresses are links, the footnotes
   * part's own in a footnote (`inNote`).
   */
  private styled(runs: readonly StyledRun[], inNote = false): string {
    return runs
      .map((each) => {
        const format: RunFormat = {
          bold: each.bold,
          italic: each.italic,
          smallCaps: each.smallCaps,
          underline: each.underline,
          script:
            each.script === "sup" ? "superscript" : each.script === "sub" ? "subscript" : undefined,
        };
        if (each.link && isWebLink(each.link)) {
          const id = this.target.link(each.link, inNote);
          return `<w:hyperlink r:id="${id}" w:history="1">${run(each.text, { ...format, style: this.styles.hyperlink })}</w:hyperlink>`;
        }
        return run(each.text, format);
      })
      .join("");
  }

  /**
   * Citations in a citation style: in the text, or as a footnote in the style's form, which
   * Word numbers with the User's own. In a footnote's text, a note can only be its words.
   */
  private cite(item: Extract<Inline, { kind: "cite" }>, context: Context): string {
    const marker = item.unverified ? run(` ${this.labels.unverified}`, { bold: true }) : "";
    if (!item.note || context.note) return this.styled(item.runs, context.note) + marker;
    const shared = item.of !== undefined && !item.inserted && !item.deleted && !context.pending;
    const key = shared ? `style\n${item.of}` : null;
    const text = item.runs.map((each) => each.text).join("") + marker;
    const first = key === null ? undefined : this.notes.get(key);
    // A style's own form for a repeat ("Id.", a short note) differs from the first note's: it wins.
    if (first?.text === text) {
      first.reused = true;
      return this.noteNumber(first.id);
    }
    const id = this.target.ids.take("footnote");
    this.footnotes.push(
      footnote(id, run(" ") + this.styled(item.runs, true) + marker, this.styles.footnote),
    );
    if (key !== null && !first) this.notes.set(key, { id, text, reused: false });
    return footnoteReference(id, this.styles.footnote.reference);
  }

  /** A Word list: the first paragraph of each item carries its number or bullet. */
  private list(block: Extract<Block, { kind: "list" }>, context: Context): string {
    if (block.checked) return this.todos(block, block.checked, context);
    const level = Math.min(context.listDepth, 8);
    const numbering = { id: this.target.list(block.ordered, level, block.start), level };
    const textIndent = context.indent + INDENT * (level + 1);
    const numbered = (content: string) =>
      paragraph(
        { style: this.styles.listParagraph, numbering, indent: textIndent, hanging: HANGING },
        content,
      );

    let xml = "";
    for (const item of block.items) {
      const [first, ...rest] = item;
      if (first?.kind === "paragraph")
        xml += this.tracked(
          numbered(this.inline(first.content, pendingContext(first, context))),
          first,
          true,
        );
      else xml += numbered("");
      for (const child of first?.kind === "paragraph" ? rest : item) {
        xml += this.tracked(
          child.kind === "list"
            ? this.list(
                child,
                pendingContext(child, {
                  ...context,
                  listDepth: context.listDepth + 1,
                  // A checklist starts at the text of the bullet or number it hangs under.
                  ...(child.checked && { indent: textIndent }),
                }),
              )
            : this.block(
                child,
                pendingContext(child, {
                  ...context,
                  indent: textIndent,
                  style: this.styles.listParagraph,
                }),
              ),
          child,
          true,
        );
      }
    }
    return xml;
  }

  private todos(
    block: Extract<Block, { kind: "list" }>,
    checked: readonly boolean[],
    context: Context,
  ): string {
    const depth = context.todo ?? 0;
    const textAt = context.indent + TODO_STEP * depth + TODO_TEXT;
    const written = (content: string, at: number) =>
      paragraph(
        { style: this.styles.listParagraph, indent: textAt, hanging: TODO_TEXT },
        // A tab is a run of its own: the schema has no bare <w:tab/> under <w:p>.
        run(checked[at] ? BOX.done : BOX.open) + "<w:r><w:tab/></w:r>" + content,
      );

    let xml = "";
    block.items.forEach((item, at) => {
      const [first, ...rest] = item;
      if (first?.kind === "paragraph")
        xml += this.tracked(
          written(this.inline(first.content, pendingContext(first, context)), at),
          first,
          true,
        );
      else xml += written("", at);
      for (const child of first?.kind === "paragraph" ? rest : item) {
        xml += this.tracked(
          child.kind === "list" && child.checked
            ? this.todos(
                child,
                child.checked,
                pendingContext(child, { ...context, todo: depth + 1 }),
              )
            : child.kind === "list"
              ? this.list(
                  child,
                  pendingContext(child, {
                    ...context,
                    indent: textAt,
                    listDepth: 0,
                    todo: undefined,
                  }),
                )
              : this.block(
                  child,
                  pendingContext(child, {
                    ...context,
                    indent: textAt,
                    style: this.styles.listParagraph,
                  }),
                ),
          child,
          true,
        );
      }
    });
    return xml;
  }

  /**
   * A Word table on an even grid, or, given `widths`, with the columns at the
   * shares they have on the page. A cell over several rows is merged down
   * (`w:vMerge`): it starts in its first row and continues, empty, in the
   * others, as Word writes one.
   */
  private table(
    rows: readonly TableCell[][],
    context: Context,
    widths?: readonly number[],
  ): string {
    if (rows.length === 0) return "";
    const layout = tableLayout(rows);
    const { columns } = layout;
    const available = Math.max(1, Math.floor(context.width - context.indent));
    const shares =
      widths && widths.length === columns && widths.every((width) => width > 0) ? widths : null;
    const total = shares ? shares.reduce((sum, width) => sum + width, 0) : columns;
    const sizes = Array.from({ length: columns }, (_unused, at) =>
      Math.max(1, Math.floor((available * (shares?.[at] ?? 1)) / total)),
    );
    if (shares) {
      const used = sizes.reduce((sum, size) => sum + size, 0);
      sizes[columns - 1] = Math.max(1, (sizes[columns - 1] ?? 1) + available - used);
    }
    const tableWidth = sizes.reduce((sum, size) => sum + size, 0);
    const span = (at: number, colspan: number) =>
      sizes.slice(at, at + colspan).reduce((sum, size) => sum + size, 0);
    const cell = (content: string, colspan: number, header: boolean, merge: string, at: number) =>
      `<w:tc><w:tcPr><w:tcW w:w="${span(at, colspan)}" w:type="dxa"/>${colspan > 1 ? `<w:gridSpan w:val="${colspan}"/>` : ""}${merge}${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' : ""}</w:tcPr>${content}</w:tc>`;

    let xml = `<w:tbl><w:tblPr><w:tblStyle w:val="${escapeXml(this.styles.tableGrid)}"/><w:tblW w:w="${tableWidth}" w:type="dxa"/>${context.indent ? `<w:tblInd w:w="${context.indent}" w:type="dxa"/>` : ""}</w:tblPr>`;
    xml += `<w:tblGrid>${sizes.map((size) => `<w:gridCol w:w="${size}"/>`).join("")}</w:tblGrid>`;
    layout.rows.forEach((slots, index) => {
      const header = (rows[index] as TableCell[]).every((each) => each.header);
      xml += `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}`;
      let at = 0;
      for (const { cell: each, continued } of slots) {
        if (!each) {
          xml += cell("<w:p/>", 1, false, "", at);
          at++;
          continue;
        }
        const merge =
          each.rowspan > 1 ? (continued ? "<w:vMerge/>" : '<w:vMerge w:val="restart"/>') : "";
        const content = continued
          ? "<w:p/>"
          : this.blocks(each.content, {
              indent: 0,
              style: null,
              listDepth: 0,
              bold: each.header,
              width: span(at, each.colspan),
              align: each.align,
              pending: context.pending,
            });
        // A cell ends with a paragraph.
        xml += cell(
          content.endsWith("</w:p>") ? content : `${content}<w:p/>`,
          each.colspan,
          each.header,
          merge,
          at,
        );
        at += each.colspan;
      }
      for (; at < columns; at++) xml += cell("<w:p/>", 1, false, "", at);
      xml += "</w:tr>";
    });
    return `${xml}</w:tbl>`;
  }

  /** Inline content, each stretch that changes still waiting do the same to as its tracked change. */
  private inline(content: readonly Inline[], context: Context): string {
    let xml = "";
    for (let from = 0; from < content.length; ) {
      const key = changeKey(content[from]);
      let to = from + 1;
      while (to < content.length && changeKey(content[to]) === key) to++;
      xml += this.tracked(
        this.inlineRange(content, from, to, context),
        content[from] as Inline,
        false,
      );
      from = to;
    }
    return xml;
  }

  /** A run of text, with IncarnaMind's comment on AI text starting before it or ending after it. */
  private text(
    item: Extract<Inline, { kind: "text" }>,
    format: RunFormat,
    context: Context,
  ): string {
    const xml = run(item.text, format);
    if (!this.review || context.note) return xml;
    return this.review.before(item) + xml + this.review.after(item);
  }

  private inlineRange(
    content: readonly Inline[],
    from: number,
    to: number,
    context: Context,
  ): string {
    let xml = "";
    for (let index = from; index < to; index++) {
      const item = content[index] as Inline;
      if (item.kind === "text" && item.marks.link && isWebLink(item.marks.link)) {
        // Consecutive text with the same link is one hyperlink.
        const href = item.marks.link;
        let runs = "";
        for (; index < to; index++) {
          const next = content[index] as Inline;
          if (next.kind !== "text" || next.marks.link !== href) break;
          runs += this.text(
            next,
            formatOf(next.marks, context, this.styles, this.styles.hyperlink),
            context,
          );
        }
        index--;
        const id = this.target.link(href, context.note === true);
        xml += `<w:hyperlink r:id="${id}" w:history="1">${runs}</w:hyperlink>`;
        continue;
      }
      switch (item.kind) {
        case "text":
          xml += this.text(item, formatOf(item.marks, context, this.styles), context);
          break;
        case "math":
          xml += latexToOmml(item.latex, false) ?? run(`$${item.latex}$`, { bold: context.bold });
          break;
        case "break":
          xml += "<w:r><w:br/></w:r>";
          break;
        case "figure":
          xml += run(item.figure.shown, { bold: context.bold });
          break;
        case "citation":
          if (context.note) {
            // A word of the footnote's text, apart from the one before it.
            const before = content[index - 1];
            const apart = before?.kind === "text" && /\S$/.test(before.text);
            xml += this.source(item.footnote, apart ? " " : "");
          } else {
            const reference = this.footnote(
              item.footnote,
              !item.inserted && !item.deleted && !context.pending,
              item.work.documentId,
              item.work.contentHash ?? null,
            );
            xml += this.review ? this.review.failed(reference, [item.footnote]) : reference;
          }
          break;
        case "footnote":
          if (!context.note) xml += this.userFootnote(item.content);
          break;
        case "image":
          // A picture's relationship belongs to the document part, not to a footnote.
          xml += context.note ? run(item.image.alt) : this.image(item.image, context);
          break;
        case "cite": {
          const cited = this.cite(item, context);
          xml +=
            this.review && !context.note ? this.review.failed(cited, item.failed ?? []) : cited;
          break;
        }
      }
    }
    return xml;
  }

  private footnote(
    citation: Footnote,
    shared: boolean,
    documentId: string | null,
    version: string | null,
  ): string {
    const key = shared
      ? `numbered\n${documentId ?? ""}\n${version ?? ""}\n${citation.source}\n${citation.unverified}\n${citation.link ?? ""}`
      : null;
    const first = key === null ? undefined : this.notes.get(key);
    if (first) {
      first.reused = true;
      return this.noteNumber(first.id);
    }
    const id = this.target.ids.take("footnote");
    this.footnotes.push(footnote(id, this.source(citation, " "), this.styles.footnote));
    if (key !== null) this.notes.set(key, { id, text: "", reused: false });
    return footnoteReference(id, this.styles.footnote.reference);
  }

  private noteNumber(id: number): string {
    return noteNumber(
      this.target.noteBookmark(id),
      `${NUMBER_OPEN}${id}${NUMBER_CLOSE}`,
      this.styles.footnote.reference,
    );
  }

  /**
   * The document part once everything is written: the notes that later Citations refer to get
   * their bookmark, and each cross-reference shows its note's number in the text as Word will
   * count it. A note whose mark isn't in the document is an error: a reference to it would
   * show Word's "Error! Reference source not found."
   */
  finish(document: string): string {
    const reused = new Set<number>();
    for (const note of this.notes.values()) if (note.reused) reused.add(note.id);
    if (reused.size === 0) return document;
    const bookmarkedNotes = new Set<number>();
    const out = document.replace(NOTE_MARK, (found, id: string) => {
      const note = Number(id);
      if (!reused.has(note) || bookmarkedNotes.has(note)) return found;
      bookmarkedNotes.add(note);
      return bookmarked(this.target.ids.take("annotation"), this.target.noteBookmark(note), found);
    });
    for (const id of reused) {
      if (!bookmarkedNotes.has(id)) {
        throw new Error(`The footnote ${id} isn't in the document it is cited from.`);
      }
    }
    const numbers = new Map<number, number>();
    for (const found of out.matchAll(/<w:footnoteReference\b[^>]*\bw:id="(\d+)"/g)) {
      const id = Number(found[1]);
      if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
    }
    return out.replaceAll(NUMBER_MARK, (_, id: string) => String(numbers.get(Number(id)) ?? id));
  }

  /** A Citation's source, after `before`, e.g. "Tides, p. 2", and "[unverified]" in bold. */
  private source(citation: Footnote, before: string): string {
    const marker = citation.unverified ? run(` ${this.labels.unverified}`, { bold: true }) : "";
    return run(`${before}${citation.source}`) + marker;
  }

  /**
   * A footnote the User wrote, and the reference to it in the text: its text
   * with its marks and links, and any Citation in it as its source. It takes
   * its number from the same ids as Citations', so Word numbers them together.
   */
  private userFootnote(content: readonly Inline[]): string {
    const id = this.target.ids.take("footnote");
    const text = this.inline(content, {
      indent: 0,
      style: null,
      listDepth: 0,
      bold: false,
      width: this.textWidth,
      align: null,
      note: true,
    });
    this.footnotes.push(footnote(id, run(" ") + text, this.styles.footnote));
    return footnoteReference(id, this.styles.footnote.reference);
  }

  /** An image embedded in the document, or its description if it can't be. */
  private image(image: Image, context: Context): string {
    const decoded = decodeImage(image.src);
    if (!decoded) return run(image.alt || image.src);
    const { id, name } = this.target.picture(decoded);

    // Its size in pixels, shrunk to fit the width available.
    const maxWidth = Math.max(context.width - context.indent, INDENT) * EMU_PER_TWIP;
    let cx = decoded.width * EMU_PER_PIXEL;
    let cy = decoded.height * EMU_PER_PIXEL;
    if (cx > maxWidth) {
      cy = Math.round((cy * maxWidth) / cx);
      cx = maxWidth;
    }
    const drawing = this.target.ids.take("drawing");
    const description = escapeXml(image.alt);
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${drawing}" name="Picture ${drawing}" descr="${description}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawing}" name="${name}" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    );
  }
}

const isWebLink = (href: string) => /^(https?:|mailto:)/i.test(href);

/**
 * The pieces of text in Blocks, in the order the writer writes them, for
 * finding AI text's passages and the sentences to comment on (`Review.mark`):
 * text is the AI's or the User's; what a change still waiting adds, a
 * Citation, a chart's values and the Bibliography are neither.
 */
export function* piecesOf(blocks: readonly Block[]): Generator<Piece> {
  for (const block of blocks) {
    if (block.inserted) continue;
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "question":
        for (const inline of block.content) {
          if (inline.kind !== "text" || inline.inserted) continue;
          const authorship = inline.ai ? "ai" : inline.text.trim() === "" ? "neither" : "own";
          yield { key: inline, authorship, sentence: inline.sentenceCheck };
        }
        break;
      case "list":
        for (const item of block.items) yield* piecesOf(item);
        break;
      case "quote":
        yield* piecesOf(block.content);
        break;
      case "table":
        for (const row of block.rows) for (const cell of row) yield* piecesOf(cell.content);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Paragraphs and runs

interface ParagraphProperties {
  style?: string | null;
  keepNext?: boolean;
  numbering?: { id: number; level: number };
  bottomBorder?: boolean;
  spacingAfter?: number;
  /** The left indent, in twips. */
  indent?: number;
  /** How far the first line hangs left of `indent`, in twips. */
  hanging?: number;
  align?: TableAlign;
  /** The User's, over the rest; its left indent is from `indent`. */
  format?: ParagraphFormat;
}

function paragraph(properties: ParagraphProperties, content: string): string {
  const { style, keepNext, numbering, bottomBorder, spacingAfter, indent, hanging, align } =
    properties;
  const format = properties.format ?? {};
  const changes = formatChanges(
    { ...format, ...(format.left !== undefined && { left: format.left + (indent ?? 0) / 20 }) },
    {},
  );
  const spacing = changedElement(
    "w:spacing",
    spacingAfter !== undefined ? `<w:spacing w:after="${spacingAfter}"/>` : null,
    changes.spacing,
  );
  const ind = changedElement(
    "w:ind",
    indent ? `<w:ind w:left="${indent}"${hanging ? ` w:hanging="${hanging}"` : ""}/>` : null,
    changes.ind,
  );
  const jc = changes.jc ?? align;
  // In the order the schema requires.
  const pPr = [
    style ? `<w:pStyle w:val="${escapeXml(style)}"/>` : "",
    keepNext ? "<w:keepNext/>" : "",
    numbering
      ? `<w:numPr><w:ilvl w:val="${numbering.level}"/><w:numId w:val="${numbering.id}"/></w:numPr>`
      : "",
    bottomBorder
      ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>'
      : "",
    spacing ?? "",
    ind ?? "",
    jc ? `<w:jc w:val="${jc}"/>` : "",
  ].join("");
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${content}</w:p>`;
}

function formatOf(marks: Marks, context: Context, styles: DocxStyles, style?: string): RunFormat {
  return {
    style: style ?? (marks.code ? styles.codeChar : undefined),
    bold: marks.bold || context.bold,
    italic: marks.italic,
    strike: marks.strike,
    highlight: marks.highlight,
    underline: marks.underline,
    monospace: marks.code && style !== undefined,
    font: marks.font,
    size: marks.size,
    color: marks.color,
    script: marks.vertical,
  };
}

// ---------------------------------------------------------------------------
// Images

export interface DecodedImage {
  data: Uint8Array;
  extension: "png" | "jpeg" | "gif";
  /** In pixels. */
  width: number;
  height: number;
}

/**
 * A PNG, JPEG or GIF given as a data: URL, with its size. Images elsewhere
 * (on the web) aren't fetched: the export never goes online.
 */
export function decodeImage(src: string): DecodedImage | null {
  const match = /^data:image\/[\w.+-]+;base64,([\s\S]*)$/i.exec(src);
  if (!match?.[1]) return null;
  const data = Buffer.from(match[1], "base64");
  const size = imageSize(data);
  if (!size || size.width <= 0 || size.height <= 0) return null;
  return { data: new Uint8Array(data), ...size };
}

function imageSize(data: Buffer): Omit<DecodedImage, "data"> | null {
  // PNG: the IHDR chunk comes first.
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { extension: "png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && data.toString("latin1", 0, 4) === "GIF8") {
    return { extension: "gif", width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  // JPEG: the size is in the first start-of-frame segment.
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= data.length && data[offset] === 0xff) {
      const marker = data[offset + 1] as number;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) {
        return {
          extension: "jpeg",
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The package's other parts

function contentTypes(comments: boolean): string {
  const types = [
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
    `<Default Extension="png" ContentType="image/png"/>`,
    `<Default Extension="jpeg" ContentType="image/jpeg"/>`,
    `<Default Extension="gif" ContentType="image/gif"/>`,
    `<Override PartName="/word/document.xml" ContentType="${MAIN_CONTENT_TYPE}.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="${MAIN_CONTENT_TYPE}.styles+xml"/>`,
    `<Override PartName="/word/settings.xml" ContentType="${MAIN_CONTENT_TYPE}.settings+xml"/>`,
    `<Override PartName="/word/numbering.xml" ContentType="${MAIN_CONTENT_TYPE}.numbering+xml"/>`,
    `<Override PartName="/word/footnotes.xml" ContentType="${MAIN_CONTENT_TYPE}.footnotes+xml"/>`,
    ...(comments
      ? [`<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CONTENT_TYPE}"/>`]
      : []),
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
  ];
  return `${XML_DECLARATION}<Types xmlns="${NS.contentTypes}">${types.join("")}</Types>`;
}

function relationshipsXml(relationships: readonly Relationship[]): string {
  const items = relationships.map(
    ({ id, type, target, external }) =>
      `<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ""}/>`,
  );
  return `${XML_DECLARATION}<Relationships xmlns="${NS.packageRelationships}">${items.join("")}</Relationships>`;
}

function coreProperties({ title, created }: DocxOptions): string {
  const date = `${created.slice(0, 19)}Z`;
  return (
    `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    (title ? `<dc:title>${escapeXml(title)}</dc:title>` : "") +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

const SETTINGS =
  `${XML_DECLARATION}<w:settings xmlns:w="${NS.w}">` +
  '<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  "</w:settings>";

const BULLETS = ["•", "◦", "▪"];
const NUMBER_FORMATS = ["decimal", "lowerLetter", "lowerRoman"];

/** A list definition (`w:abstractNum`) of bullets, or of numbers. */
export function listDefinition(id: number, ordered: boolean): string {
  let levels = "";
  for (let level = 0; level < 9; level++) {
    const format = ordered ? NUMBER_FORMATS[level % 3] : "bullet";
    const text = ordered ? `%${level + 1}.` : BULLETS[level % 3];
    levels += `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${INDENT * (level + 1)}" w:hanging="${HANGING}"/></w:pPr></w:lvl>`;
  }
  return `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
}

/**
 * A list (`w:num`) of a definition: an ordered one starts at its own number,
 * rather than going on from the last list of the same definition.
 */
export function listInstance(numId: number, definition: number, list: List): string {
  return `<w:num w:numId="${numId}"><w:abstractNumId w:val="${definition}"/>${list.ordered ? `<w:lvlOverride w:ilvl="${list.level}"><w:startOverride w:val="${list.start}"/></w:lvlOverride>` : ""}</w:num>`;
}

/** Two list definitions, bullets (0) and numbers (1), and an instance of one for each list. */
function numbering(lists: readonly List[]): string {
  const instances = lists.map((list, index) => listInstance(index + 1, list.ordered ? 1 : 0, list));
  return `${XML_DECLARATION}<w:numbering xmlns:w="${NS.w}">${listDefinition(0, false)}${listDefinition(1, true)}${instances.join("")}</w:numbering>`;
}

const CODE_FONT = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';

/** A style the export writes in, by what it is for. */
export type StyleRole =
  | "title"
  | `heading${1 | 2 | 3 | 4 | 5 | 6}`
  | "quote"
  | "question"
  | "listParagraph"
  | "code"
  | "math"
  | "caption"
  | "footnoteText"
  | "footnoteReference"
  | "hyperlink"
  | "codeChar"
  | "tableGrid"
  | "commentText"
  | "commentReference";

/** The ids of the styles a document's styles are based on, where it has them. */
export interface StyleBases {
  paragraph: string | null;
  character: string | null;
  table: string | null;
}

/** A style the export writes in: Word's name for it, its kind, and its definition under an id. */
export interface StyleDefinition {
  /** Word's own name for a built-in style ("heading 1", "footnote text"), or ours. */
  name: string;
  type: "paragraph" | "character" | "table";
  xml(id: string, bases: StyleBases): string;
}

const basedOn = (id: string | null) => (id ? `<w:basedOn w:val="${escapeXml(id)}"/>` : "");

function paragraphStyle(
  name: string,
  { pPr = "", rPr = "", next = false }: { pPr?: string; rPr?: string; next?: boolean },
): StyleDefinition {
  return {
    name,
    type: "paragraph",
    xml: (id, bases) =>
      `<w:style w:type="paragraph" w:styleId="${escapeXml(id)}"><w:name w:val="${name}"/>${basedOn(bases.paragraph)}${next && bases.paragraph ? `<w:next w:val="${escapeXml(bases.paragraph)}"/>` : ""}<w:qFormat/>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}</w:style>`,
  };
}

const border = (color: string) =>
  `<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="${color}"/></w:pBdr>`;

const HEADING_SIZES = [32, 28, 26, 24, 22, 22];

/** The export's styles, in the order a new document defines them. */
export const STYLE_DEFINITIONS: Readonly<Record<StyleRole, StyleDefinition>> = {
  title: paragraphStyle("Title", {
    next: true,
    pPr: '<w:spacing w:after="240"/>',
    rPr: '<w:sz w:val="48"/><w:szCs w:val="48"/>',
  }),
  ...(Object.fromEntries(
    HEADING_SIZES.map((size, index) => [
      `heading${index + 1}`,
      paragraphStyle(`heading ${index + 1}`, {
        next: true,
        pPr: `<w:keepNext/><w:keepLines/><w:spacing w:before="${index === 0 ? 360 : 240}" w:after="80"/><w:outlineLvl w:val="${index}"/>`,
        rPr: `<w:b/>${index >= 3 ? "<w:i/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
      }),
    ]),
  ) as Record<`heading${1 | 2 | 3 | 4 | 5 | 6}`, StyleDefinition>),
  quote: paragraphStyle("Quote", {
    pPr: `${border("D1D5DB")}<w:ind w:left="${INDENT}"/>`,
    rPr: '<w:i/><w:color w:val="4B5563"/>',
  }),
  question: paragraphStyle("Question", {
    next: true,
    pPr: border("0EA5E9"),
    rPr: '<w:color w:val="374151"/>',
  }),
  listParagraph: paragraphStyle("List Paragraph", {
    pPr: `<w:ind w:left="${INDENT}"/><w:contextualSpacing/>`,
  }),
  code: paragraphStyle("Code", {
    pPr: '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>',
    rPr: `${CODE_FONT}<w:sz w:val="20"/><w:szCs w:val="20"/>`,
  }),
  math: paragraphStyle("Math", { pPr: '<w:jc w:val="center"/>' }),
  // Word's own "caption" style, so its captions list picks a chart's up.
  caption: paragraphStyle("caption", {
    pPr: '<w:spacing w:after="160"/>',
    rPr: '<w:i/><w:color w:val="4A4F57"/><w:sz w:val="18"/><w:szCs w:val="18"/>',
  }),
  footnoteText: {
    name: "footnote text",
    type: "paragraph",
    xml: (id, bases) =>
      `<w:style w:type="paragraph" w:styleId="${escapeXml(id)}"><w:name w:val="footnote text"/>${basedOn(bases.paragraph)}<w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>`,
  },
  footnoteReference: {
    name: "footnote reference",
    type: "character",
    xml: (id, bases) =>
      `<w:style w:type="character" w:styleId="${escapeXml(id)}"><w:name w:val="footnote reference"/>${basedOn(bases.character)}<w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>`,
  },
  hyperlink: {
    name: "Hyperlink",
    type: "character",
    xml: (id, bases) =>
      `<w:style w:type="character" w:styleId="${escapeXml(id)}"><w:name w:val="Hyperlink"/>${basedOn(bases.character)}<w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>`,
  },
  codeChar: {
    name: "Inline Code",
    type: "character",
    xml: (id, bases) =>
      `<w:style w:type="character" w:styleId="${escapeXml(id)}"><w:name w:val="Inline Code"/>${basedOn(bases.character)}<w:rPr>${CODE_FONT}<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:rPr></w:style>`,
  },
  commentText: {
    name: "annotation text",
    type: "paragraph",
    xml: (id, bases) =>
      `<w:style w:type="paragraph" w:styleId="${escapeXml(id)}"><w:name w:val="annotation text"/>${basedOn(bases.paragraph)}<w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>`,
  },
  commentReference: {
    name: "annotation reference",
    type: "character",
    xml: (id, bases) =>
      `<w:style w:type="character" w:styleId="${escapeXml(id)}"><w:name w:val="annotation reference"/>${basedOn(bases.character)}<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>`,
  },
  tableGrid: {
    name: "Table Grid",
    type: "table",
    xml: (id, bases) =>
      `<w:style w:type="table" w:styleId="${escapeXml(id)}"><w:name w:val="Table Grid"/>${basedOn(bases.table)}<w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>`,
  },
};

/** A new document's ids for the styles, which `NEW_DOCUMENT_STYLES` writes in. */
export const NEW_DOCUMENT_STYLE_IDS: Readonly<Record<StyleRole, string>> = {
  title: "Title",
  heading1: "Heading1",
  heading2: "Heading2",
  heading3: "Heading3",
  heading4: "Heading4",
  heading5: "Heading5",
  heading6: "Heading6",
  quote: "Quote",
  question: "Question",
  listParagraph: "ListParagraph",
  code: "Code",
  math: "Math",
  caption: "Caption",
  footnoteText: "FootnoteText",
  footnoteReference: "FootnoteReference",
  hyperlink: "Hyperlink",
  codeChar: "CodeChar",
  tableGrid: "TableGrid",
  commentText: "CommentText",
  commentReference: "CommentReference",
};

/** The styles only a document with comments needs. */
const COMMENT_ROLES: ReadonlySet<StyleRole> = new Set(["commentText", "commentReference"]);

const DEFAULT_BODY_FONT = "Calibri";

function styles(
  language: string,
  comments: boolean,
  font: string | null,
  lineSpacing: number | null,
): string {
  const family = escapeXml(font ?? DEFAULT_BODY_FONT);
  const bases: StyleBases = {
    paragraph: "Normal",
    character: "DefaultParagraphFont",
    table: "TableNormal",
  };
  const defined = (Object.keys(STYLE_DEFINITIONS) as StyleRole[])
    .filter((role) => comments || !COMMENT_ROLES.has(role))
    .map((role) => STYLE_DEFINITIONS[role].xml(NEW_DOCUMENT_STYLE_IDS[role], bases))
    .join("");
  return (
    `${XML_DECLARATION}<w:styles xmlns:w="${NS.w}">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}" w:cs="${family}"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="${language}"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="${lineSpacing === null ? 259 : Math.round(lineSpacing * 240)}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    defined +
    "</w:styles>"
  );
}
