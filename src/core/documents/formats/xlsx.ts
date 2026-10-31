/**
 * Excel (.xlsx) → sheets of cells, and Units of blocks of rows (see ./grid).
 *
 * Values are shown as Excel shows them: formulas give their last cached
 * result, numbers follow their cell's number format ("£350,200", "4.2%"),
 * dates become ISO dates, booleans TRUE and FALSE. Hidden sheets are left
 * out unless the read asks for them (#740). Sheets are read as a stream of rows, so a huge sheet costs no more
 * than the rows read: past `MAX_ROWS` rows or `MAX_CELLS` cells in all,
 * reading stops and the workbook says it was cut short. Ported from the
 * office-formats spike, with streaming and number formats added.
 *
 * The sheet preview also asks for the workbook's look (`layout`), read in the
 * same pass: cell styles, rich text, row heights and column widths, hidden
 * rows and columns, frozen panes, gridlines, notes, pictures and charts, and
 * each value as Excel's own format shows it (./sheetLayout). Indexing never
 * asks for it.
 */
import { parseCellRef, type TextUnit } from "../../../shared/units";
import type { UnreadParts } from "../../api";
import { ExtractionError } from "./errors";
import { type Cell, gridUnits, MAX_CELLS, MAX_ROWS, type Sheet, type Workbook } from "./grid";
import { displayNumber, displayText } from "./numberDisplay";
import { builtInFormat, formatNumber, generalNumber, isDateFormat } from "./numbers";
import {
  cellIndex,
  emptyLayout,
  type LayoutOptions,
  pointsToPixels,
  type SheetLayout,
  type TextRun,
  widthToPixels,
} from "./sheetLayout";
import {
  type ImageBudget,
  MAX_WORKBOOK_IMAGE_BYTES,
  readDrawings,
  readNotes,
  relationshipsOf,
} from "./xlsxDrawings";
import { readFont, readStyles, type WorkbookStyles } from "./xlsxStyles";
import {
  child,
  descendants,
  elements,
  is,
  parseXml,
  streamElements,
  textOf,
  type XmlElement,
} from "./xml";
import { openPackage, resolvePart, type ZipArchive } from "./zip";

/** The largest a sheet or the shared strings may inflate to while being read. */
const MAX_STREAMED_BYTES = 256 * 1024 * 1024;

/** The furthest column the preview's layout follows formatting to. */
const MAX_LAYOUT_COLUMNS = 512;

/** A rich-text string item's text: plain <t>, or runs <r><t>; phonetic hints (<rPh>) aren't text. */
const stringItem = (si: XmlElement) =>
  elements(si)
    .filter((each) => is(each, "t") || is(each, "r"))
    .map((each) => (is(each, "t") ? textOf(each) : textOf(child(each, "t") ?? each)))
    .join("");

/** A string item's runs, when they have fonts of their own; undefined for plain text. */
function stringRuns(si: XmlElement, styles: WorkbookStyles): TextRun[] | undefined {
  const runs = elements(si).filter((each) => is(each, "r"));
  if (!runs.some((run) => child(run, "rPr"))) return undefined;
  return runs.map((run) => {
    const properties = child(run, "rPr");
    const text = textOf(child(run, "t") ?? run);
    return properties ? { text, font: readFont(properties, styles.color) } : { text };
  });
}

export interface Limits {
  rows: number;
  cells: number;
}

/** What the reading of a cell found: its indexed value, and what its look needs. */
interface ReadCell extends Pick<Cell, "value" | "numeric" | "raw"> {
  /** The cell's type: n, s, inlineStr, str, b, e or d. */
  type: string;
  number?: number;
  /** A shared string's index. */
  shared?: number;
}

/** The parts the elements of a sheet's stream are read from. */
const SHEET_PARTS = ["col", "row", "mergeCell"];
const LAYOUT_PARTS = [...SHEET_PARTS, "sheetPr", "sheetView", "sheetFormatPr", "drawing"];

/**
 * Reads a workbook's visible sheets, and with `readHidden`, its hidden and very
 * hidden ones too. With `layout`, it also reads how they look, for the sheet
 * preview (see the file's comment).
 */
export async function readWorkbook(
  bytes: Uint8Array,
  limits: Limits = { rows: MAX_ROWS, cells: MAX_CELLS },
  layout?: LayoutOptions,
  readHidden = false,
): Promise<Workbook> {
  const zip = openPackage(bytes);
  const workbookXml = await zip.readText("xl/workbook.xml");
  if (workbookXml === undefined) {
    throw new ExtractionError("unreadable", "Not an Excel workbook: it has no xl/workbook.xml.");
  }
  const workbook = parseXml(workbookXml);
  const date1904 = ["1", "true"].includes(child(workbook, "workbookPr")?.attrs.date1904 ?? "");

  const relsXml = await zip.readText("xl/_rels/workbook.xml.rels");
  const targets = new Map<string, string>();
  let themePart: string | undefined;
  for (const rel of relsXml ? elements(parseXml(relsXml)) : []) {
    if (rel.attrs.Id && rel.attrs.Target) {
      const target = resolvePart("xl/workbook.xml", rel.attrs.Target);
      targets.set(rel.attrs.Id, target);
      if (rel.attrs.Type?.endsWith("/theme")) themePart = target;
    }
  }

  // The number format of each cell style (by its index in cellXfs).
  const formats: (string | undefined)[] = [];
  const stylesXml = await zip.readText("xl/styles.xml");
  const styles = stylesXml ? parseXml(stylesXml) : undefined;
  if (styles) {
    const custom = new Map<number, string>();
    for (const format of descendants(styles, "numFmt")) {
      custom.set(Number(format.attrs.numFmtId), format.attrs.formatCode ?? "");
    }
    const xfs = child(styles, "cellXfs");
    for (const xf of xfs ? elements(xfs) : []) {
      const id = Number(xf.attrs.numFmtId ?? 0);
      formats.push(custom.get(id) ?? builtInFormat(id));
    }
  }
  let looks: WorkbookStyles | undefined;
  if (layout) {
    const themeXml = themePart && zip.has(themePart) ? await zip.readText(themePart) : undefined;
    looks = readStyles(styles, themeXml ? parseXml(themeXml) : undefined);
  }

  const shared: string[] = [];
  const sharedRuns = new Map<number, TextRun[]>();
  if (zip.has("xl/sharedStrings.xml")) {
    const chunks = zip.textChunks("xl/sharedStrings.xml", MAX_STREAMED_BYTES);
    for await (const si of streamElements(chunks, ["si"])) {
      if (looks) {
        const runs = stringRuns(si, looks);
        if (runs) sharedRuns.set(shared.length, runs);
      }
      shared.push(stringItem(si));
    }
  }

  const sheets: Sheet[] = [];
  const parts: string[] = [];
  const drawingIds: (string | undefined)[] = [];
  const hiddenSheets: string[] = [];
  const rowsCut: { sheet: string; from: number }[] = [];
  const sheetsNotRead: string[] = [];
  const active = Number(descendants(workbook, "workbookView")[0]?.attrs.activeTab ?? 0);
  let activeSheet = 0;
  let rowsLeft = limits.rows;
  let cellsLeft = limits.cells;
  let truncated = false;
  for (const [position, entry] of descendants(workbook, "sheet").entries()) {
    const part = targets.get(entry.attrs["r:id"] ?? "");
    if (!part || !zip.has(part)) continue;
    const name = entry.attrs.name ?? `Sheet${position + 1}`;
    if (!readHidden && (entry.attrs.state === "hidden" || entry.attrs.state === "veryHidden")) {
      hiddenSheets.push(name);
      continue;
    }
    if (position === active) activeSheet = sheets.length;
    const sheet: Sheet = {
      name,
      cells: [],
      merges: [],
      rowCount: 0,
      columnCount: 0,
      columnWidths: [],
    };
    const look = looks ? emptyLayout() : undefined;
    if (look) sheet.layout = look;
    sheets.push(sheet);
    parts.push(part);
    drawingIds.push(undefined);
    if (truncated) {
      sheetsNotRead.push(name);
      continue;
    }
    let rowNumber = 0;
    const chunks = zip.textChunks(part, MAX_STREAMED_BYTES);
    for await (const element of streamElements(chunks, look ? LAYOUT_PARTS : SHEET_PARTS)) {
      if (is(element, "col")) {
        readColumns(element, sheet, look);
        continue;
      }
      if (is(element, "mergeCell")) {
        if (element.attrs.ref) sheet.merges.push(element.attrs.ref);
        continue;
      }
      if (!is(element, "row")) {
        if (look && looks) readSheetPart(element, look, looks);
        if (is(element, "drawing")) drawingIds[drawingIds.length - 1] = element.attrs["r:id"];
        continue;
      }
      rowNumber = element.attrs.r ? Number(element.attrs.r) : rowNumber + 1;
      if (look) readRow(element, rowNumber, look);
      const cells = elements(element).filter((each) => is(each, "c"));
      if (cells.length === 0) continue;
      if (rowsLeft <= 0 || cellsLeft < cells.length) {
        rowsCut.push({ sheet: name, from: rowNumber });
        truncated = true;
        break;
      }
      rowsLeft--;
      let column = -1;
      for (const c of cells) {
        const ref = c.attrs.r ? parseCellRef(c.attrs.r) : null;
        column = ref ? ref.column : column + 1;
        const cell = readCell(c, shared, formats, date1904);
        if (look && looks) {
          lookOfCell(c, cell, rowNumber, column, look, looks, sharedRuns, { ...layout, date1904 });
        }
        if (!cell) continue;
        cellsLeft--;
        sheet.cells.push({
          row: rowNumber,
          column,
          value: cell.value,
          numeric: cell.numeric,
          ...(cell.raw !== undefined ? { raw: cell.raw } : {}),
        });
        sheet.rowCount = Math.max(sheet.rowCount, rowNumber);
        sheet.columnCount = Math.max(sheet.columnCount, column + 1);
      }
    }
  }
  // Merged ranges stretch the grid even where they hold nothing.
  for (const sheet of sheets) {
    for (const merge of sheet.merges) {
      const end = parseCellRef(merge.split(":")[1] ?? "");
      if (!end) continue;
      sheet.rowCount = Math.max(sheet.rowCount, end.row);
      sheet.columnCount = Math.max(sheet.columnCount, end.column + 1);
    }
  }
  const read = { sheets, truncated, hiddenSheets, rowsCut, sheetsNotRead };
  if (!looks) return read;
  const budget: ImageBudget = { left: MAX_WORKBOOK_IMAGE_BYTES };
  for (const [index, sheet] of sheets.entries()) {
    if (sheet.layout)
      await readSheetExtras(zip, parts[index] as string, drawingIds[index], sheet.layout, budget);
  }
  return {
    ...read,
    layout: { styles: looks.cells, defaultFont: looks.defaultFont, activeSheet },
  };
}

/** A `<col>` element: widths for the indexed sheet, and hidden columns and styles for the look. */
function readColumns(element: XmlElement, sheet: Sheet, look: SheetLayout | undefined): void {
  const width = Number(element.attrs.width);
  const min = Number(element.attrs.min);
  const max = Math.min(Number(element.attrs.max), min + MAX_LAYOUT_COLUMNS);
  if (!(min >= 1)) return;
  const hidden = element.attrs.hidden === "1" || element.attrs.hidden === "true";
  const style = Number(element.attrs.style ?? 0);
  for (let column = min; column <= max; column++) {
    if (Number.isFinite(width)) sheet.columnWidths[column - 1] = widthToPixels(width);
    if (!look) continue;
    look.columns.set(column - 1, {
      ...(Number.isFinite(width) ? { width: widthToPixels(width) } : {}),
      ...(hidden ? { hidden } : {}),
      ...(style > 0 ? { style } : {}),
    });
  }
}

/** A sheet's properties, view and default sizes. */
function readSheetPart(element: XmlElement, look: SheetLayout, styles: WorkbookStyles): void {
  if (is(element, "sheetPr")) {
    const tab = styles.color(child(element, "tabColor"));
    if (tab) look.tabColor = tab;
  } else if (is(element, "sheetView")) {
    // A sheet has a view for each window; the first is the one shown.
    if (element.attrs.showGridLines === "0" || element.attrs.showGridLines === "false") {
      look.showGridLines = false;
    }
    const pane = child(element, "pane");
    if (pane && (pane.attrs.state === "frozen" || pane.attrs.state === "frozenSplit")) {
      const rows = Math.max(0, Math.floor(Number(pane.attrs.ySplit ?? 0)));
      const columns = Math.max(0, Math.floor(Number(pane.attrs.xSplit ?? 0)));
      if (rows > 0 || columns > 0) look.frozen = { rows, columns };
    }
  } else if (is(element, "sheetFormatPr")) {
    const height = Number(element.attrs.defaultRowHeight);
    if (height > 0) look.defaultRowHeight = pointsToPixels(height);
    const width = Number(element.attrs.defaultColWidth);
    const base = Number(element.attrs.baseColWidth);
    if (width > 0) look.defaultColumnWidth = widthToPixels(width);
    else if (base > 0) look.defaultColumnWidth = Math.round((base + 0.43) * 7 + 5);
  }
}

/** A row's height, whether it is hidden, and its style. */
function readRow(element: XmlElement, row: number, look: SheetLayout): void {
  const { ht, hidden, s, customFormat } = element.attrs;
  const height = Number(ht);
  const styled = (customFormat === "1" || customFormat === "true") && Number(s) > 0;
  if (!(height >= 0 && ht !== undefined) && hidden !== "1" && hidden !== "true" && !styled) return;
  look.rows.set(row, {
    ...(ht !== undefined && height >= 0 ? { height: pointsToPixels(height) } : {}),
    ...(hidden === "1" || hidden === "true" ? { hidden: true } : {}),
    ...(styled ? { style: Number(s) } : {}),
  });
}

/** A cell's look: its style, what it shows as Excel shows it, its runs, its alignment. */
function lookOfCell(
  c: XmlElement,
  cell: ReadCell | null,
  row: number,
  column: number,
  look: SheetLayout,
  styles: WorkbookStyles,
  sharedRuns: ReadonlyMap<number, TextRun[]>,
  options: LayoutOptions & { date1904: boolean },
): void {
  const at = cellIndex(row, column);
  const s = Number(c.attrs.s ?? 0);
  const style = styles.cells[s];
  if (s > 0 && style) {
    look.styles.set(at, s);
    if (style.fill || Object.keys(style.border).length > 0) {
      look.extent.rows = Math.max(look.extent.rows, row);
      look.extent.columns = Math.min(MAX_LAYOUT_COLUMNS, Math.max(look.extent.columns, column + 1));
    }
  }
  if (!cell) {
    if (savedNoResult(c)) look.noValue.add(at);
    return;
  }
  const format = style?.numberFormat;
  if (cell.number !== undefined) {
    const width = look.columns.get(column)?.width ?? look.defaultColumnWidth;
    const shown = displayNumber(cell.number, format?.code, {
      date1904: options.date1904,
      ...(format?.builtIn !== undefined ? { builtIn: format.builtIn } : {}),
      ...(options.shortDate ? { shortDate: options.shortDate } : {}),
      // General takes at most 11 characters, and fewer in a narrow column.
      generalWidth: Math.min(11, Math.max(1, Math.floor((width - 5) / 7))),
    });
    if (shown.text !== cell.value || shown.color || shown.fill !== undefined)
      look.shown.set(at, shown);
  } else if (cell.type === "b" || cell.type === "e") {
    look.centred.add(at);
  } else {
    const shown = displayText(cell.value, format?.code);
    if (shown.text !== cell.value || shown.color || shown.fill !== undefined)
      look.shown.set(at, shown);
    const runs =
      cell.shared !== undefined
        ? sharedRuns.get(cell.shared)
        : cell.type === "inlineStr"
          ? stringRuns(child(c, "is") ?? c, styles)
          : undefined;
    if (runs) look.runs.set(at, runs);
  }
}

/** A sheet's pictures, charts and notes, through its relationships. */
async function readSheetExtras(
  zip: ZipArchive,
  part: string,
  drawingId: string | undefined,
  look: SheetLayout,
  budget: ImageBudget,
): Promise<void> {
  const rels = await relationshipsOf(zip, part);
  const drawing = drawingId ? rels.get(drawingId) : undefined;
  if (drawing) {
    look.drawings = await readDrawings(zip, drawing.target, budget);
    for (const each of look.drawings) {
      const end = each.to ?? each.from;
      look.extent.rows = Math.max(look.extent.rows, end.row);
      look.extent.columns = Math.min(
        MAX_LAYOUT_COLUMNS,
        Math.max(look.extent.columns, end.column + 1),
      );
    }
  }
  for (const rel of rels.values()) {
    if (!rel.type.endsWith("/comments")) continue;
    for (const [ref, text] of await readNotes(zip, rel.target)) {
      const cell = parseCellRef(ref);
      if (cell) look.notes.set(cellIndex(cell.row, cell.column), text);
    }
  }
}

/**
 * A formula the file saved no result for, as a script that writes formulas (openpyxl) leaves it:
 * no number to show, which isn't 0.
 */
function savedNoResult(c: XmlElement): boolean {
  if (!child(c, "f") || (c.attrs.t !== undefined && c.attrs.t !== "n")) return false;
  const v = child(c, "v");
  return !v || textOf(v).trim() === "";
}

/** A cell's value as shown, or null for an empty one. */
function readCell(
  c: XmlElement,
  shared: readonly string[],
  formats: readonly (string | undefined)[],
  date1904: boolean,
): ReadCell | null {
  const type = c.attrs.t ?? "n";
  const v = child(c, "v");
  const raw = v ? textOf(v) : "";
  let value: string;
  let numeric = false;
  let number: number | undefined;
  let stored: number | undefined;
  let sharedIndex: number | undefined;
  if (type === "s") {
    sharedIndex = Number(raw);
    value = shared[sharedIndex] ?? "";
  } else if (type === "inlineStr") value = stringItem(child(c, "is") ?? c);
  else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
  else if (savedNoResult(c)) return null;
  else if (!v) return null;
  else if (type === "n") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) value = raw;
    else {
      number = parsed;
      const format = formats[Number(c.attrs.s ?? 0)];
      value = format ? formatNumber(parsed, format, date1904) : generalNumber(parsed);
      const isDate = format !== undefined && isDateFormat(format);
      numeric = !isDate;
      // Excel computes with the stored number; a date stays its ISO text.
      if (!isDate && value.trim() !== generalNumber(parsed)) stored = parsed;
    }
    numeric = numeric || /^\d{4}-\d\d-\d\d/.test(value);
  } else value = raw; // str (a formula's text), e (an error), d (an ISO date)
  value = value.trim();
  if (value === "") return null;
  return {
    value,
    numeric,
    type,
    ...(stored !== undefined ? { raw: stored } : {}),
    ...(number !== undefined ? { number } : {}),
    ...(sharedIndex !== undefined ? { shared: sharedIndex } : {}),
  };
}

export interface XlsxResult {
  units: TextUnit[];
  workbook: Workbook;
}

export async function extractXlsx(bytes: Uint8Array, readHidden = false): Promise<XlsxResult> {
  const workbook = await readWorkbook(bytes, undefined, undefined, readHidden);
  return { units: gridUnits(workbook.sheets, true), workbook };
}

/** The parts of the workbook that weren't read, for the unread list (#740); null when all of it was. */
export function unreadPartsOf(workbook: Workbook): UnreadParts | null {
  const { hiddenSheets, rowsCut, sheetsNotRead } = workbook;
  return hiddenSheets.length === 0 && rowsCut.length === 0 && sheetsNotRead.length === 0
    ? null
    : { hiddenSheets, rowsCut, sheetsNotRead };
}
