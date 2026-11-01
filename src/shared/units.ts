/**
 * Units (ADR-0011): the spans a Document's text is stored in, in reading
 * order, and what a Citation's Location points at. A Unit is a PDF's page, a
 * deck's slide (its speaker notes included), a heading section of a Word or
 * Markdown file or a saved web page, a block of rows of one sheet of a
 * spreadsheet or CSV, a block of lines of a plain-text file, or a block of
 * a Transcript's cues. Each is one
 * `document_pages` row of a version: `page` is the Unit's number, from 1,
 * which for a PDF is its page and for a deck its slide.
 *
 * A Citation names one Unit, or two consecutive ones in the same sheet or
 * Document, and its quote is checked against their stored text. Anchors map
 * spans of a Unit's text back to what a preview can highlight (a cell, a
 * paragraph, a slide's notes, a Word comment); only the viewer, a Citation's
 * label and the marks in the Passages a model reads need them.
 *
 * Pure, with no Node or DOM imports: the processing worker, the core and the
 * renderer all use it.
 */

/**
 * - "page": a PDF's page: the text in the PDF, or for a scanned page, the
 *   text read from its picture (`UnitLabel.scan`, #397).
 * - "slide": a deck's slide, with its speaker notes.
 * - "section": the text under one heading of a Word or Markdown file or a
 *   web page (or the part of a long one), or what comes before the first
 *   heading.
 * - "rows": a block of rows of one sheet (a CSV has one sheet).
 * - "lines": a block of lines of a plain-text file.
 * - "cues": a block of a Transcript's cues, one line each, in time order.
 * - "text": a whole TXT or Markdown file, as text was stored before Units
 *   (migration 22); kept only for the old versions Citations quote.
 */
export type UnitKind = "page" | "slide" | "section" | "rows" | "lines" | "cues" | "text";

/**
 * What a Unit's Location label is made of, by kind; stored as JSON beside
 * the Unit's text. Language-neutral: the label is worded when shown.
 */
export interface UnitLabel {
  /** section: the heading path, outermost first; empty before the first heading. */
  path?: string[];
  /** section: which part of a long section this is, from 2 (the first part has none). */
  part?: number;
  /**
   * section: comes before the first heading of a Document that has headings; `path` is empty.
   * Without it, an empty `path` is a Document with no headings (or one read before this was said).
   */
  beforeHeading?: boolean;
  /** section: the Word file's footnotes and endnotes, gathered at the end. */
  notes?: boolean;
  /**
   * section: a web page's, whose anchors number its paragraphs from its
   * heading ("p3"), so its Location names the paragraph too ("§ History, ¶ 3").
   */
  paragraphs?: boolean;
  /**
   * section: the Word comments anchored in it, in order, read after its own
   * text: each one's anchor and its author.
   */
  comments?: UnitComment[];
  /** slide: its title, if it has one. */
  title?: string;
  /** slide: hidden in a slide show. */
  hidden?: boolean;
  /** rows: the sheet's name; none for a CSV. */
  sheet?: string;
  /**
   * rows and lines: the first and last row (or line) number, from 1, as the file numbers them.
   * cues: where the first cue starts and the last one ends, in ms from the Transcript's start.
   */
  from?: number;
  to?: number;
  /** cues: who said each cue, in order, where any is known (null for one not known). */
  speakers?: (string | null)[];
  /** rows: the row number of each line of the Unit's text, in order. */
  rows?: number[];
  /** rows: the sheet's first column (from 0): each line lists the cells from it, tab-separated. */
  column?: number;
  /** rows: the Unit's first line repeats the sheet's header row, for context. */
  header?: boolean;
  /** page: a scanned page, whose text was read from its picture (#397), not taken from the PDF. */
  scan?: UnitScan;
  /** page: its own name, from the PDF's page labels ("xii", "A-3") or the number its header or footer prints (#901). */
  printed?: string;
  /** section: a web page's pictures in it whose text was read on this computer. */
  figures?: UnitFigure[];
  /**
   * rows of a workbook: the number stored in each cell whose shown text isn't
   * that number written plainly, by cell ("C12": 0.04213 for a cell showing
   * "4.2%"). Sparse; none for a CSV, whose cells are their text. See `cellNumber`.
   */
  values?: Record<string, number>;
  /**
   * rows of a workbook (#2347): each formula, by cell, as the workbook writes
   * it without its "=" ("C5*(1+Growth)"), an array formula in braces. A cell
   * whose row has nothing else to show is in its sheet's nearest Unit.
   */
  formulas?: Record<string, string>;
  /**
   * rows of a workbook (#2347): the value a cell saved where its shown text
   * doesn't give it, by cell: a date's serial number, text that would read
   * as a number or TRUE, a formula's result that shows as nothing.
   */
  saved?: Record<string, number | string | boolean>;
  /** rows: the first Unit of a workbook's, what the whole workbook's formulas need (#2347). */
  workbook?: WorkbookFacts;
}

/** What a workbook's formulas need beyond its cells (#2347). */
export interface WorkbookFacts {
  /** Its defined names: each one's sheet, or null for the whole workbook's, and what it refers to. */
  names?: { name: string; sheet: string | null; refersTo: string }[];
  /** Its dates count from 1904 (Excel for Mac's old default). */
  date1904?: true;
  /** It works circular references out by iterating. */
  iterate?: true;
  /** It was set to calculate only when asked, so its saved results can be out of date. */
  manual?: true;
  /** Sheets with rows left out at the reading limit: the first row not read, from 1. */
  cut?: { sheet: string; from: number }[];
  /** Sheets it has that weren't read: hidden ones, and those past the reading limit. */
  unread?: string[];
}

const MAX_PRINTED_PAGE_LENGTH = 16;

/** Whether a PDF's page label is plain and short enough to be a page's name. */
export const isPrintedName = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  value.length <= MAX_PRINTED_PAGE_LENGTH &&
  !/\p{C}/u.test(value);

export type QuarterTurn = 0 | 90 | 180 | 270;

/**
 * How a scanned page's text was read (#397). Its anchors are its lines, in
 * reading order ("line1", "line2", …), each with its box on the page (`Anchor.quad`).
 */
export interface UnitScan {
  /**
   * What read it, and which version of how it reads ("PP-OCRv5 mobile/2"):
   * a page read by an older one is read again, unless a Citation quotes it.
   */
  reader: string;
  /** The clockwise turn from the displayed page to its reading frame; absent when 0 (#1819). */
  turn?: QuarterTurn;
  /** The words it was unsure of: [start, end) UTF-16 offsets into the Unit's text. */
  unsure?: [number, number][];
  /**
   * It couldn't be read (the model couldn't be downloaded or failed on it):
   * the Unit has no text, and the Document names the page with Retry.
   */
  unread?: boolean;
}

/**
 * A web page's picture read on this computer: its anchor is
 * "figure{number}", and each line read "figure{number}.line{n}".
 */
export interface UnitFigure {
  number: number;
  /** As `UnitScan.reader`. */
  reader: string;
  /** [start, end) UTF-16 offsets into the Unit's text. */
  unsure?: [number, number][];
  /** It couldn't be read now: its description alone is its text. */
  unread?: boolean;
}

/** A Word comment in a section's text: the target of its anchor ("comment3") and who wrote it. */
export interface UnitComment {
  target: string;
  /** Null when the file names no author. */
  author: string | null;
}

/** A span of a Unit's text and what it stands for in the file, e.g. the cell "B12". */
export interface Anchor {
  /** UTF-16 offsets into the Unit's text; `end` is exclusive. */
  start: number;
  end: number;
  /**
   * slide: "title", "shape2", "table1.row3", "chart1", "image1" or "notes";
   * section: "p12" (the 12th paragraph read; in a web page's, the 12th from
   * its heading), or "comment3" (a Word comment, by its id); rows: a cell, "B12";
   * cues: a cue's times in ms, "t754000-761500";
   * a scanned page: "line3", the third line read, in reading order.
   */
  target: string;
  /**
   * A scanned page's line: its box on the page, as fractions of the page's
   * width and height, x then y of each corner: top-left, top-right,
   * bottom-right, bottom-left, as the text runs.
   */
  quad?: number[];
}

/** A Unit: its number, kind, label, text and anchors. */
export interface TextUnit {
  /**
   * The Unit's number, from 1, in reading order: a PDF's page number, a
   * deck's slide number. Called `page`, as the `document_pages` column is.
   */
  page: number;
  kind: UnitKind;
  label: UnitLabel | null;
  text: string;
  /** Stored for slides and sections; worked out from the text for rows (see `anchorsOf`). */
  anchors: Anchor[] | null;
}

/**
 * A Unit's text as the check reads it from storage: `page` is the Unit's
 * number (null only in data from before Units); `kind` defaults to "page".
 */
export interface UnitText {
  page: number | null;
  text: string;
  kind?: UnitKind;
  label?: UnitLabel | null;
  anchors?: Anchor[] | null;
  /**
   * A currency written next to a scale in the Unit's text before running headers were
   * stripped ("(£'000)"): a Document that writes one scales its amounts somewhere, so a
   * currency read from one line must not apply to a bare number (#1001).
   */
  scaleMarker?: string | null;
}

/** Builds a Unit's text while recording anchors. */
export class UnitBuilder {
  text = "";
  anchors: Anchor[] = [];

  /** Appends `content` as one anchored span, after `separator` unless it is the first. */
  add(content: string, target: string | null, separator = "\n"): void {
    if (!content) return;
    if (this.text) this.text += separator;
    const start = this.text.length;
    this.text += content;
    if (target) this.anchors.push({ start, end: this.text.length, target });
  }

  get empty(): boolean {
    return this.text.trim() === "";
  }
}

/** "A", "B", … "Z", "AA", … for a column from 0. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/**
 * The number stored in a cell of a workbook's rows Unit, or null when the
 * cell shows its number plainly (or is not a number), when the Unit isn't a
 * workbook's, or when the cell is not in it. `ref` is "C12", any case.
 */
export function cellNumber(label: UnitLabel | null | undefined, ref: string): number | null {
  const cell = parseCellRef(ref);
  if (!cell || !label?.values) return null;
  const value = label.values[`${columnName(cell.column)}${cell.row}`];
  return typeof value === "number" ? value : null;
}

/** "C12" → { column: 2, row: 12 }; null if it isn't a cell reference. */
export function parseCellRef(ref: string): { column: number; row: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!match) return null;
  let column = 0;
  for (const letter of (match[1] as string).toUpperCase()) {
    column = column * 26 + (letter.charCodeAt(0) - 64);
  }
  return { column: column - 1, row: Number(match[2]) };
}

/**
 * The anchors of a block of rows: one per non-empty cell, from its text. Each
 * line is a row (`label.rows` gives its number) and lists its cells from the
 * sheet's first column, separated by tabs.
 */
export function rowAnchors(text: string, label: UnitLabel | null): Anchor[] {
  const rows = label?.rows ?? [];
  const first = label?.column ?? 0;
  const anchors: Anchor[] = [];
  let lineStart = 0;
  let line = 0;
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? text.length : lineEnd;
    const row = rows[line];
    if (row !== undefined) {
      let cellStart = lineStart;
      let column = first;
      while (cellStart <= end) {
        const tab = text.indexOf("\t", cellStart);
        const cellEnd = tab < 0 || tab > end ? end : tab;
        if (cellEnd > cellStart) {
          anchors.push({ start: cellStart, end: cellEnd, target: `${columnName(column)}${row}` });
        }
        column++;
        cellStart = cellEnd + 1;
      }
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
    line++;
  }
  return anchors;
}

/** A Unit's anchors: those stored, or for rows, those its text gives. */
export function anchorsOf(unit: Pick<UnitText, "kind" | "label" | "text" | "anchors">): Anchor[] {
  if (unit.kind === "rows") return rowAnchors(unit.text, unit.label ?? null);
  return unit.anchors ?? [];
}

/** The line of a block of lines that `offset` (into the Unit's text) is on, numbered as the file is. */
export function lineAt(text: string, label: UnitLabel | null, offset: number): number {
  let line = label?.from ?? 1;
  for (let at = text.indexOf("\n"); at >= 0 && at < offset; at = text.indexOf("\n", at + 1)) line++;
  return line;
}

/** A cue's anchor target: its start and end in ms, "t754000-761500". */
export const cueTarget = (startMs: number, endMs: number) =>
  `t${Math.round(startMs)}-${Math.round(endMs)}`;

/** A cue's times from its anchor target; null if it isn't one. */
export function parseCueTarget(target: string): { startMs: number; endMs: number } | null {
  const match = /^t(\d+)-(\d+)$/.exec(target);
  return match ? { startMs: Number(match[1]), endMs: Number(match[2]) } : null;
}

/** Whether two Units can be cited together: the same kind, and for rows, the same sheet. */
export function sameRun(
  a: Pick<UnitText, "kind" | "label">,
  b: Pick<UnitText, "kind" | "label">,
): boolean {
  return (
    (a.kind ?? "page") === (b.kind ?? "page") &&
    (a.kind !== "rows" || a.label?.sheet === b.label?.sheet)
  );
}

/**
 * A Unit's text from `start` to `end` (UTF-16 offsets), with the anchors and
 * a scan's unsure words that fall in it moved with it, cut where they cross
 * its ends: what is left of a scanned page once its running header and
 * footer are taken off.
 */
export function cutUnit<Unit extends Pick<UnitText, "text" | "label" | "anchors">>(
  unit: Unit,
  start: number,
  end: number,
): Unit {
  const inside = (from: number, to: number): [number, number] | null => {
    const clipped: [number, number] = [Math.max(from, start) - start, Math.min(to, end) - start];
    return clipped[0] < clipped[1] ? clipped : null;
  };
  const anchors = unit.anchors?.flatMap((anchor) => {
    const span = inside(anchor.start, anchor.end);
    return span ? [{ ...anchor, start: span[0], end: span[1] }] : [];
  });
  const scan = unit.label?.scan;
  const unsure = scan?.unsure?.flatMap(([from, to]) => {
    const span = inside(from, to);
    return span ? [span] : [];
  });
  return {
    ...unit,
    text: unit.text.slice(start, end),
    ...(unit.anchors !== undefined && { anchors: anchors ?? null }),
    ...(scan &&
      unit.label && {
        label: {
          ...unit.label,
          scan: { ...scan, ...(unsure && unsure.length > 0 ? { unsure } : { unsure: undefined }) },
        },
      }),
  };
}
