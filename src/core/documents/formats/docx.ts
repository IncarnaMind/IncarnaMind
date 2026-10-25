/**
 * Word (.docx) → Units: one per heading section, labelled with the heading
 * path, in reading order (ADR-0011: Word is cited by section, not by page).
 * A section longer than `MAX_SECTION_CHARS` is split at paragraph ends into
 * parts. Footnotes and endnotes form one last Unit.
 *
 * Read: body paragraphs and tables, in order (a table row is one line, its
 * cells separated by tabs), runs, tabs, breaks, hyperlinks, insertions,
 * content controls, and one branch of `mc:AlternateContent`. Left out:
 * deleted text, field instructions, headers and footers, and list numbers
 * ("1.", "a)"). Headings are found from styles.xml, by name ("heading N") or
 * outline level, so localised style ids work. Ported from the office-formats
 * spike.
 *
 * Comments (#76) are read into the Unit their reference mark is in, where
 * the viewer shows them beside the pages (where their range starts, for one
 * with no mark), after that Unit's own text: each after a blank line,
 * anchored as "comment" and its id, and named with its author in the Unit's
 * label, so a quote of it is cited at its section, as a comment by its
 * author. Comments anchored only in headers or footers, which aren't read,
 * are left out.
 */
import { type TextUnit, UnitBuilder, type UnitComment } from "../../../shared/units";
import { headingLevelOfStyleName } from "../../../shared/wordStyles";
import { ExtractionError } from "./errors";
import { child, elements, local, parseXml, type XmlElement } from "./xml";
import { openPackage } from "./zip";

/** A section longer than this many characters is split into parts at paragraph ends. */
export const MAX_SECTION_CHARS = 6000;

/**
 * The heading level a paragraph style gives (from 1; 0 for a Title), by its
 * name ("heading N"), so localised style ids work, or its outline level; null
 * for a style that isn't a heading's.
 */
export function headingLevelOf(style: XmlElement): number | null {
  const named = headingLevelOfStyleName(child(style, "w:name")?.attrs["w:val"] ?? "");
  if (named !== null) return named;
  const outline = child(child(style, "w:pPr") ?? style, "w:outlineLvl")?.attrs["w:val"];
  if (outline !== undefined && Number(outline) < 9) return Number(outline) + 1;
  return null;
}

/** Style id → heading level (from 1), from styles.xml: "heading N", or an outline level. */
function headingStyles(styles: XmlElement | undefined): Map<string, number> {
  const levels = new Map<string, number>();
  if (!styles) return levels;
  for (const style of elements(styles)) {
    if (style.name !== "w:style" || style.attrs["w:type"] !== "paragraph") continue;
    const id = style.attrs["w:styleId"];
    const level = headingLevelOf(style);
    if (id && level !== null) levels.set(id, level);
  }
  return levels;
}

/** The comments a paragraph refers to, by id, in order: by their reference marks, and where their ranges start. */
interface CommentMarks {
  references: string[];
  starts: string[];
}

interface Paragraph extends CommentMarks {
  /** Empty only for a paragraph read for the comments it refers to. */
  text: string;
  /** 0 for a Title, 1–9 for headings, null for body text. */
  level: number | null;
}

/** The text of run content; the comments it refers to go into `marks`. */
function runText(node: XmlElement, marks: CommentMarks): string {
  let text = "";
  for (const element of elements(node)) {
    switch (local(element.name)) {
      case "t":
        text += element.children.filter((part) => typeof part === "string").join("");
        break;
      case "tab":
        text += "\t";
        break;
      case "br":
      case "cr":
        text += "\n";
        break;
      case "noBreakHyphen":
        text += "-";
        break;
      case "AlternateContent": {
        // The same content twice (DrawingML and a VML fallback): read the first choice only.
        const choice = elements(element)[0];
        if (choice) text += runText(choice, marks);
        break;
      }
      case "commentReference":
      case "commentRangeStart": {
        const id = element.attrs["w:id"];
        const list = local(element.name) === "commentReference" ? marks.references : marks.starts;
        if (id !== undefined) list.push(id);
        break;
      }
      case "del":
      case "delText":
      case "instrText":
      case "pPr":
      case "rPr":
      case "footnoteReference":
      case "endnoteReference":
        break;
      default:
        // r, hyperlink, ins, smartTag, fldSimple, sdt, sdtContent, …
        text += runText(element, marks);
    }
  }
  return text;
}

/** The text of some of a document's XML, as it is read: without deleted text or field instructions. */
export const textIn = (node: XmlElement): string => runText(node, { references: [], starts: [] });

const refersToComments = (marks: CommentMarks) =>
  marks.references.length > 0 || marks.starts.length > 0;

/** The text of paragraphs read, without those read only for their comments, joined by `separator`. */
const textOf = (paragraphs: readonly Paragraph[], separator: string) =>
  paragraphs
    .filter((paragraph) => paragraph.text)
    .map((paragraph) => paragraph.text)
    .join(separator);

function readBlocks(container: XmlElement, styles: Map<string, number>, out: Paragraph[]): void {
  for (const element of elements(container)) {
    if (element.name === "w:p") {
      const pPr = child(element, "w:pPr");
      const styleId = pPr && child(pPr, "w:pStyle")?.attrs["w:val"];
      const outline = pPr && child(pPr, "w:outlineLvl")?.attrs["w:val"];
      const marks: CommentMarks = { references: [], starts: [] };
      const text = runText(element, marks).trim();
      const level =
        styleId !== undefined && styles.has(styleId)
          ? (styles.get(styleId) as number)
          : outline !== undefined && Number(outline) < 9
            ? Number(outline) + 1
            : null;
      if (text) out.push({ text, level, ...marks });
      else if (refersToComments(marks)) out.push({ text, level: null, ...marks });
    } else if (element.name === "w:tbl") {
      for (const row of elements(element).filter((each) => each.name === "w:tr")) {
        const marks: CommentMarks = { references: [], starts: [] };
        const cells = elements(row)
          .filter((each) => each.name === "w:tc")
          .map((cell) => {
            const inner: Paragraph[] = [];
            readBlocks(cell, styles, inner);
            for (const paragraph of inner) {
              marks.references.push(...paragraph.references);
              marks.starts.push(...paragraph.starts);
            }
            return textOf(inner, " ");
          });
        const text = cells.join("\t").trim();
        if (text || refersToComments(marks)) out.push({ text, level: null, ...marks });
      }
    } else if (element.name === "w:sdt") {
      const content = child(element, "w:sdtContent");
      if (content) readBlocks(content, styles, out);
    }
  }
}

/** A comment of the Document: its author, if the file names one, and its text. */
interface DocxComment {
  author: string | null;
  text: string;
}

/** The Document's comments with text, by id, from word/comments.xml. */
function readComments(
  xml: string | undefined,
  styles: Map<string, number>,
): Map<string, DocxComment> {
  const comments = new Map<string, DocxComment>();
  if (!xml) return comments;
  for (const comment of elements(parseXml(xml)).filter((each) => each.name === "w:comment")) {
    const id = comment.attrs["w:id"];
    const inner: Paragraph[] = [];
    readBlocks(comment, styles, inner);
    const text = textOf(inner, "\n");
    if (id === undefined || !text) continue;
    const author = comment.attrs["w:author"]?.trim();
    comments.set(id, { author: author || null, text });
  }
  return comments;
}

/**
 * Where each comment is anchored, by id: the index of the paragraph that
 * holds its reference mark, or else the one where its range starts.
 */
function commentAnchors(paragraphs: readonly Paragraph[]): Map<string, number> {
  const anchors = new Map<string, number>();
  for (const marks of ["references", "starts"] as const) {
    paragraphs.forEach((paragraph, index) => {
      for (const id of paragraph[marks]) if (!anchors.has(id)) anchors.set(id, index);
    });
  }
  return anchors;
}

/** The comments anchored at a paragraph (see `commentAnchors`), in the order it refers to them. */
const commentsAt = (paragraph: Paragraph, index: number, anchors: ReadonlyMap<string, number>) =>
  [...new Set([...paragraph.references, ...paragraph.starts])].filter(
    (id) => anchors.get(id) === index,
  );

/**
 * Adds comments to a Unit's text, after what it has, each after a blank line
 * and anchored as "comment" and its id; returns them for the Unit's label.
 */
function addComments(
  builder: UnitBuilder,
  ids: readonly string[],
  comments: ReadonlyMap<string, DocxComment>,
): UnitComment[] {
  const added: UnitComment[] = [];
  for (const id of ids) {
    const comment = comments.get(id);
    if (!comment) continue;
    const target = `comment${id}`;
    builder.add(comment.text, target, "\n\n");
    added.push({ target, author: comment.author });
  }
  return added;
}

/** A heading of the Document, for the viewer's outline. */
export interface DocxHeading {
  /** From 1. */
  level: number;
  text: string;
  /** The Unit the heading starts. */
  unit: number;
}

export interface DocxResult {
  units: TextUnit[];
  headings: DocxHeading[];
  /** The ids of the paragraph styles that are headings: the viewer finds headings by them. */
  headingStyles: string[];
}

export async function extractDocx(bytes: Uint8Array): Promise<DocxResult> {
  const zip = openPackage(bytes);
  const documentXml = await zip.readText("word/document.xml");
  if (documentXml === undefined) {
    throw new ExtractionError("unreadable", "Not a Word document: it has no word/document.xml.");
  }
  const stylesXml = await zip.readText("word/styles.xml");
  const styles = headingStyles(stylesXml ? parseXml(stylesXml) : undefined);
  const body = child(parseXml(documentXml), "w:body");
  const paragraphs: Paragraph[] = [];
  if (body) readBlocks(body, styles, paragraphs);
  const comments = readComments(await zip.readText("word/comments.xml"), styles);
  const anchors = commentAnchors(paragraphs);

  const units: TextUnit[] = [];
  const headings: DocxHeading[] = [];
  const path: string[] = [];
  const headed = paragraphs.some(
    (paragraph) => paragraph.text && paragraph.level !== null && paragraph.level > 0,
  );
  let builder = new UnitBuilder();
  let part = 1;
  /** The comments anchored in the Unit being built, added after its text. */
  let pending: string[] = [];
  const flush = () => {
    const added = addComments(builder, pending, comments);
    if (!builder.empty) {
      const heading = path.filter(Boolean);
      units.push({
        page: units.length + 1,
        kind: "section",
        label: {
          path: heading,
          ...(part > 1 ? { part } : {}),
          ...(heading.length === 0 && headed ? { beforeHeading: true } : {}),
          ...(added.length > 0 ? { comments: added } : {}),
        },
        text: builder.text,
        anchors: builder.anchors,
      });
    }
    builder = new UnitBuilder();
    pending = [];
  };

  let read = 0;
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.text) {
      if (paragraph.level !== null && paragraph.level > 0) {
        flush();
        path.length = paragraph.level - 1;
        path[paragraph.level - 1] = paragraph.text;
        part = 1;
        headings.push({ level: paragraph.level, text: paragraph.text, unit: units.length + 1 });
      } else if (
        builder.text.length + paragraph.text.length > MAX_SECTION_CHARS &&
        !builder.empty
      ) {
        flush();
        part++;
      }
      read++;
      builder.add(paragraph.text, `p${read}`);
    }
    pending.push(...commentsAt(paragraph, index, anchors));
  });
  flush();

  // Footnotes and endnotes: one Unit at the end, each note anchored, then the comments in them.
  const notes = new UnitBuilder();
  const inNotes: Paragraph[] = [];
  for (const [name, tag] of [
    ["word/footnotes.xml", "w:footnote"],
    ["word/endnotes.xml", "w:endnote"],
  ] as const) {
    const xml = await zip.readText(name);
    if (!xml) continue;
    for (const note of elements(parseXml(xml)).filter((each) => each.name === tag)) {
      if (note.attrs["w:type"]) continue; // separators
      const inner: Paragraph[] = [];
      readBlocks(note, styles, inner);
      notes.add(textOf(inner, "\n"), `${local(tag)}${note.attrs["w:id"]}`);
      inNotes.push(...inner);
    }
  }
  const unanchored = [...new Set(inNotes.flatMap((each) => [...each.references, ...each.starts]))];
  const noteComments = addComments(
    notes,
    unanchored.filter((id) => !anchors.has(id)),
    comments,
  );
  if (!notes.empty) {
    units.push({
      page: units.length + 1,
      kind: "section",
      label: {
        path: [],
        notes: true,
        ...(noteComments.length > 0 ? { comments: noteComments } : {}),
      },
      text: notes.text,
      anchors: notes.anchors,
    });
  }
  return {
    units,
    headings,
    headingStyles: [...styles].filter(([, level]) => level > 0).map(([id]) => id),
  };
}
