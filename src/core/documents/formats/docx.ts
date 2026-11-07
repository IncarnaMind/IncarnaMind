/**
 * Word (.docx) → Units: one per heading section, labelled with the heading
 * path, in reading order (ADR-0011: Word is cited by section, not by page).
 * A section longer than `MAX_SECTION_CHARS` is split at paragraph ends into
 * parts. Footnotes and endnotes form one last Unit.
 *
 * Read: body paragraphs and tables, in order (a table row is one line, its
 * cells separated by tabs), runs, tabs, breaks, hyperlinks, insertions,
 * content controls, and one branch of `mc:AlternateContent`. Left out:
 * deleted text, field instructions and list numbers ("1.", "a)"). Headings
 * are found from styles.xml, by name ("heading N") or outline level, so
 * localised style ids work. Ported from the office-formats spike.
 *
 * Headers and footers aren't in a Unit's text, which would repeat them in
 * every section; each Unit keeps those of the Word sections it is in as its
 * `runningText`, for the scale they may state ("£'000", #2365).
 *
 * Comments (#76) are read into the Unit their reference mark is in, where
 * the viewer shows them beside the pages (where their range starts, for one
 * with no mark), after that Unit's own text: each after a blank line,
 * anchored as "comment" and its id, and named with its author in the Unit's
 * label, so a quote of it is cited at its section, as a comment by its
 * author. Comments anchored only in headers or footers, which aren't in a
 * Unit's text, are left out.
 */
import {
  type TextUnit,
  UnitBuilder,
  type UnitComment,
  type UnitTable,
} from "../../../shared/units";
import { headingLevelOfStyleName } from "../../../shared/wordStyles";
import { cellTable, headingRowsOf, isFigure, shiftedDigits } from "../tableCells";
import { mainRootOf, OfficePackage, partOfType, type Relationships } from "./officePackage";
import { readStyleTable } from "./wordStyleTable";
import { child, elements, local, parseXml, type XmlElement } from "./xml";
import { openPackage, type ZipArchive } from "./zip";

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

/** Style id → heading level (from 1), and the character styles that set a run raised. */
interface DocxStyles {
  levels: Map<string, number>;
  raised: Set<string>;
}

const setsRaised = (style: XmlElement): boolean => {
  const rPr = child(style, "w:rPr");
  const align = rPr && child(rPr, "w:vertAlign")?.attrs["w:val"];
  const position = Number((rPr && child(rPr, "w:position")?.attrs["w:val"]) ?? 0);
  return align === "superscript" || position > 0;
};

function docxStyles(root: XmlElement | undefined): DocxStyles {
  const table = readStyleTable(root);
  const levels = new Map<string, number>();
  const raised = new Set<string>();
  for (const style of table.styles) {
    if (style.type === "paragraph") {
      const level = headingLevelOf(style.element);
      if (level !== null) levels.set(style.id, level);
    }
    if (table.chain(style.type, style.id).some((each) => setsRaised(each.element))) {
      raised.add(style.id);
    }
  }
  return { levels, raised };
}

/** The comments a paragraph refers to, by id, in order: by their reference marks, and where their ranges start. */
interface CommentMarks {
  references: string[];
  starts: string[];
}

interface Paragraph extends CommentMarks {
  /** Empty only for a paragraph read for the comments it refers to, or for the section it ends. */
  text: string;
  /** A table's row: the table, counted in the body from 0, and its cells, one for each column of its grid. */
  row?: { table: number; cells: string[]; covered?: boolean[] };
  /** 0 for a Title, 1–9 for headings, null for body text. */
  level: number | null;
  /** The properties of the Word section this paragraph ends, when it ends one. */
  sectionEnd?: XmlElement;
}

/** The text of run content; the comments it refers to go into `marks`. */
function runText(
  node: XmlElement,
  marks: CommentMarks,
  raisedStyles?: ReadonlySet<string>,
): string {
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
      case "r": {
        const rPr = child(element, "w:rPr");
        const align = rPr && child(rPr, "w:vertAlign")?.attrs["w:val"];
        const styleId = rPr && child(rPr, "w:rStyle")?.attrs["w:val"];
        const position = Number((rPr && child(rPr, "w:position")?.attrs["w:val"]) ?? 0);
        const raised =
          align === "superscript" ||
          position > 0 ||
          (styleId !== undefined && raisedStyles?.has(styleId) === true);
        const lowered = align === "subscript" || position < 0;
        const read = runText(element, marks, raisedStyles);
        text += raised || lowered ? shiftedDigits(read, raised) : read;
        break;
      }
      case "AlternateContent": {
        // The same content twice (DrawingML and a VML fallback): read the first choice only.
        const choice = elements(element)[0];
        if (choice) text += runText(choice, marks, raisedStyles);
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
        text += runText(element, marks, raisedStyles);
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

/** A cell's paragraphs on one line of its row, its tabs a space so the row's own tabs part its cells. */
const cellText = (paragraphs: readonly Paragraph[]) =>
  textOf(paragraphs, " ").replace(/\s+/g, " ").trim();

/** Word's most columns in a table: a count past it is a damaged file's, not a grid's. */
const MAX_GRID_COLUMNS = 63;

/** How many grid columns `element` (a gridSpan, gridBefore or gridAfter) counts; `none` without one. */
function gridCount(element: XmlElement | undefined, none: number): number {
  const count = Number(element?.attrs["w:val"]);
  return Number.isInteger(count) && count >= 0 ? Math.min(count, MAX_GRID_COLUMNS) : none;
}

const spanOf = (cell: XmlElement) =>
  Math.max(1, gridCount(child(child(cell, "w:tcPr") ?? cell, "w:gridSpan"), 1));

function readBlocks(
  container: XmlElement,
  styles: DocxStyles,
  out: Paragraph[],
  tables = { count: 0 },
): void {
  for (const element of elements(container)) {
    if (element.name === "w:p") {
      const pPr = child(element, "w:pPr");
      const styleId = pPr && child(pPr, "w:pStyle")?.attrs["w:val"];
      const outline = pPr && child(pPr, "w:outlineLvl")?.attrs["w:val"];
      const marks: CommentMarks = { references: [], starts: [] };
      const text = runText(element, marks, styles.raised).trim();
      const level =
        styleId !== undefined && styles.levels.has(styleId)
          ? (styles.levels.get(styleId) as number)
          : outline !== undefined && Number(outline) < 9
            ? Number(outline) + 1
            : null;
      const sectionEnd = pPr && child(pPr, "w:sectPr");
      const ends = sectionEnd ? { sectionEnd } : {};
      if (text) out.push({ text, level, ...marks, ...ends });
      else if (refersToComments(marks) || sectionEnd)
        out.push({ text, level: null, ...marks, ...ends });
    } else if (element.name === "w:tbl") {
      const table = tables.count++;
      const collected = elements(element)
        .filter((each) => each.name === "w:tr")
        .map((row) => {
          const marks: CommentMarks = { references: [], starts: [] };
          const trPr = child(row, "w:trPr");
          const skipped = (name: string) =>
            Array.from({ length: gridCount(trPr && child(trPr, name), 0) }, () => "");
          // A merged cell keeps its grid's columns (#448): the cells right of one spanning two
          // columns stay under their own headings, and a row starting further along the grid
          // starts there.
          const cells: string[] = [];
          const covered: boolean[] = [];
          const continued: boolean[] = [];
          for (const cell of elements(row).filter((each) => each.name === "w:tc")) {
            const inner: Paragraph[] = [];
            readBlocks(cell, styles, inner);
            for (const paragraph of inner) {
              marks.references.push(...paragraph.references);
              marks.starts.push(...paragraph.starts);
            }
            const vMerge = child(child(cell, "w:tcPr") ?? cell, "w:vMerge");
            const continues =
              vMerge !== undefined &&
              (vMerge.attrs["w:val"] === undefined || vMerge.attrs["w:val"] === "continue");
            const span = spanOf(cell);
            cells.push(cellText(inner));
            covered.push(false);
            continued.push(continues);
            for (let at = 1; at < span; at++) {
              cells.push("");
              covered.push(true);
              continued.push(false);
            }
          }
          const before = skipped("w:gridBefore");
          cells.unshift(...before);
          covered.unshift(...before.map(() => false));
          continued.unshift(...before.map(() => false));
          const after = skipped("w:gridAfter");
          cells.push(...after);
          covered.push(...after.map(() => false));
          continued.push(...after.map(() => false));
          return { marks, cells, covered, continued };
        });
      // A merge repeats the text it continues down the body's rows, not into another heading row,
      // and never a figure, which would count twice.
      const starts: string[] = [];
      const startedAt: number[] = [];
      const headingRows = headingRowsOf(
        collected.map((row) => row.cells),
        { covered: collected.map((row) => row.covered) },
      );
      for (const [at, row] of collected.entries()) {
        for (let column = 0; column < row.cells.length; column++) {
          const start = starts[column];
          if (
            row.continued[column] &&
            start &&
            !isFigure(start) &&
            (startedAt[column] ?? -1) >= headingRows
          )
            row.cells[column] = start;
        }
        for (let column = 0; column < row.cells.length; column++) {
          if (!row.continued[column]) {
            starts[column] = row.cells[column] ?? "";
            startedAt[column] = at;
          }
        }
      }
      for (const { marks, cells, covered } of collected) {
        const filled = cells.some((cell) => cell !== "");
        const text = filled ? cells.join("\t") : "";
        if (filled) out.push({ text, level: null, ...marks, row: { table, cells, covered } });
        else if (refersToComments(marks)) out.push({ text, level: null, ...marks });
      }
    } else if (element.name === "w:sdt") {
      const content = child(element, "w:sdtContent");
      if (content) readBlocks(content, styles, out, tables);
    }
  }
}

/** A comment of the Document: its author, if the file names one, and its text. */
interface DocxComment {
  author: string | null;
  text: string;
}

/** The Document's comments with text, by id, from its comments part. */
function readComments(xml: string | undefined, styles: DocxStyles): Map<string, DocxComment> {
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

/**
 * The text of each Word section's headers and footers, in the order the sections run: the last
 * section's properties are the body's own. A section without a header or footer of a kind (first
 * page, even pages, the rest) keeps the one before it, as Word shows it. A header or footer
 * part that can't be parsed reads as empty: the body is read as without it.
 */
async function runningTexts(
  zip: ZipArchive,
  rels: Relationships,
  sections: readonly (XmlElement | undefined)[],
  styles: DocxStyles,
): Promise<string[]> {
  const parts = new Map<string, string>();
  const textOfPart = async (part: string) => {
    let text = parts.get(part);
    if (text === undefined) {
      const inner: Paragraph[] = [];
      try {
        const xml = await zip.readText(part);
        if (xml) readBlocks(parseXml(xml), styles, inner);
      } catch {
        inner.length = 0;
      }
      text = textOf(inner, "\n");
      parts.set(part, text);
    }
    return text;
  };
  const current = new Map<string, string>();
  const texts: string[] = [];
  for (const section of sections) {
    for (const reference of section ? elements(section) : []) {
      const kind = local(reference.name);
      if (kind !== "headerReference" && kind !== "footerReference") continue;
      const target = rels.get(reference.attrs["r:id"] ?? "");
      if (target && !target.external)
        current.set(`${kind} ${reference.attrs["w:type"] ?? "default"}`, target.target);
    }
    const written = await Promise.all([...new Set(current.values())].map(textOfPart));
    texts.push([...new Set(written.filter(Boolean))].join("\n"));
  }
  return texts;
}

interface ReadTable {
  rows: Paragraph[];
  /** Null for a table with no column of figures, which isn't kept. */
  read: UnitTable | null;
}

function readTables(paragraphs: readonly Paragraph[]): Map<number, ReadTable> {
  const tables = new Map<number, ReadTable>();
  for (const paragraph of paragraphs) {
    if (!paragraph.row) continue;
    const table = tables.get(paragraph.row.table) ?? { rows: [], read: null };
    table.rows.push(paragraph);
    tables.set(paragraph.row.table, table);
  }
  for (const table of tables.values()) {
    table.read = cellTable(
      table.rows.map((row) => row.row?.cells ?? []),
      { covered: table.rows.map((row) => row.row?.covered ?? []) },
    );
  }
  return tables;
}

/**
 * The tables a Unit holds rows of, from those rows (`index` in their table): a long table split
 * over two Units goes on in the second from where the first left it.
 */
function tablesIn(
  rows: readonly { table: number; index: number }[],
  tables: ReadonlyMap<number, ReadTable>,
): UnitTable[] {
  const held: UnitTable[] = [];
  for (const id of new Set(rows.map((row) => row.table))) {
    const table = tables.get(id);
    if (!table?.read) continue;
    const headed = table.rows.length - table.read.rows.length;
    const body = rows.filter((row) => row.table === id && row.index >= headed);
    const [first] = body;
    if (!first) continue;
    held.push({
      headings: table.read.headings,
      rows: body.map((row) => table.read?.rows[row.index - headed] ?? []),
      ...(first.index > headed && { continues: true as const }),
    });
  }
  return held;
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
  /** Relationships parts that couldn't be read; the rest was read without what they name. */
  unreadable: string[];
}

export async function extractDocx(bytes: Uint8Array): Promise<DocxResult> {
  const zip = openPackage(bytes);
  const pkg = new OfficePackage(zip);
  const main = await pkg.mainPart("word/document.xml");
  const document = mainRootOf(await zip.readText(main), main, "document", "Not a Word document");
  const rels = await pkg.relationships(main);
  const stylesXml = await zip.readText(partOfType(rels, "/styles", "word/styles.xml"));
  const styles = docxStyles(stylesXml ? parseXml(stylesXml) : undefined);
  const body = child(document, "w:body");
  const paragraphs: Paragraph[] = [];
  if (body) readBlocks(body, styles, paragraphs);
  const comments = readComments(
    await zip.readText(partOfType(rels, "/comments", "word/comments.xml")),
    styles,
  );
  const anchors = commentAnchors(paragraphs);
  const running = await runningTexts(
    zip,
    rels,
    [
      ...paragraphs.flatMap((paragraph) => (paragraph.sectionEnd ? [paragraph.sectionEnd] : [])),
      body && child(body, "w:sectPr"),
    ],
    styles,
  );

  const units: TextUnit[] = [];
  const headings: DocxHeading[] = [];
  const path: string[] = [];
  const headed = paragraphs.some(
    (paragraph) => paragraph.text && paragraph.level !== null && paragraph.level > 0,
  );
  const tables = readTables(paragraphs);
  let builder = new UnitBuilder();
  /** The table rows in the Unit being built: each its table and its place in it, from 0. */
  let tableRows: { table: number; index: number }[] = [];
  const rowCounts = new Map<number, number>();
  let part = 1;
  /** The comments anchored in the Unit being built, added after its text. */
  let pending: string[] = [];
  /** The Word sections the Unit being built is in. */
  let inSections = new Set<number>();
  let section = 0;
  const flush = () => {
    const added = addComments(builder, pending, comments);
    const unitTables = tablesIn(tableRows, tables);
    if (!builder.empty) {
      const heading = path.filter(Boolean);
      const runningText = [...new Set([...inSections].map((each) => running[each] ?? ""))]
        .filter(Boolean)
        .join("\n");
      units.push({
        page: units.length + 1,
        kind: "section",
        label: {
          path: heading,
          ...(part > 1 ? { part } : {}),
          ...(heading.length === 0 && headed ? { beforeHeading: true } : {}),
          ...(added.length > 0 ? { comments: added } : {}),
          ...(unitTables.length > 0 ? { tables: unitTables } : {}),
        },
        text: builder.text,
        anchors: builder.anchors,
        ...(runningText ? { runningText } : {}),
      });
    }
    builder = new UnitBuilder();
    tableRows = [];
    pending = [];
    inSections = new Set();
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
      if (paragraph.row) {
        const { table } = paragraph.row;
        const index = rowCounts.get(table) ?? 0;
        tableRows.push({ table, index });
        rowCounts.set(table, index + 1);
      }
      inSections.add(section);
    }
    pending.push(...commentsAt(paragraph, index, anchors));
    if (paragraph.sectionEnd) section++;
  });
  flush();

  // Footnotes and endnotes: one Unit at the end, each note anchored, then the comments in them.
  const notes = new UnitBuilder();
  const inNotes: Paragraph[] = [];
  for (const [type, usual, tag] of [
    ["/footnotes", "word/footnotes.xml", "w:footnote"],
    ["/endnotes", "word/endnotes.xml", "w:endnote"],
  ] as const) {
    const xml = await zip.readText(partOfType(rels, type, usual));
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
    headingStyles: [...styles.levels].filter(([, level]) => level > 0).map(([id]) => id),
    unreadable: pkg.unreadable,
  };
}
