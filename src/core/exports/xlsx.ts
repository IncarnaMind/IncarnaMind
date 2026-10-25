/**
 * A new .xlsx from a sheet book (./sheets, #132), written with the shared ZIP
 * module and nothing else: shared strings for text, numbers and date serials
 * with their number formats, notes as Excel's own (a comments part drawn by
 * VML, which is what Excel, LibreOffice and WPS show as a cell's red corner),
 * links between cells, frozen headings and column widths.
 */
import { columnName } from "../../shared/units";
import { type Deflate, writeZip, type ZipWriteEntry } from "../documents/formats/zip";
import type { CellRef, CellValue, Formula, Sheet, SheetBook, SheetCell } from "./sheets";
import { escapeXml } from "./wordml";

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const SPREADSHEETML = "application/vnd.openxmlformats-officedocument.spreadsheetml";

/** What a cell can hold, by Excel's limit; a longer text is cut and ends in "…". */
export const MAX_CELL_TEXT = 32_767;
const MAX_SHEET_NAME = 31;
/** Day 0 of Excel's 1900 date system, as JavaScript counts days: 30 December 1899. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** A day as Excel's date serial: 31 March 2026 is 46112. */
export function dateSerial(day: string): number {
  const [year = 1900, month = 1, date = 1] = day.split("-").map(Number);
  return (Date.UTC(year, month - 1, date) - EXCEL_EPOCH) / DAY_MS;
}

function sheetNames(sheets: readonly Sheet[]): string[] {
  const taken = new Set<string>();
  return sheets.map((sheet, index) => {
    const base =
      sheet.name
        .replace(/[\\/?*[\]:]/g, " ")
        .replace(/^'+|'+$/g, "")
        .trim()
        .slice(0, MAX_SHEET_NAME) || `Sheet${index + 1}`;
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

const quotedSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;

function addresses(book: SheetBook, names: readonly string[]) {
  const sheets = new Map(
    book.sheets.map((sheet, index) => [
      sheet.id,
      {
        name: names[index] ?? sheet.name,
        rows: new Map(sheet.rows.map((row, at) => [row.id, at + 1])),
        columns: new Map(sheet.columns.map((column, at) => [column.id, columnName(at)])),
      },
    ]),
  );
  const cell = (ref: CellRef) => {
    const sheet = sheets.get(ref.sheet);
    const row = sheet?.rows.get(ref.row);
    const column = sheet?.columns.get(ref.column);
    if (!sheet || row === undefined || !column) {
      throw new Error(`No cell ${ref.sheet}/${ref.row}/${ref.column} in the book.`);
    }
    return { sheetName: sheet.name, local: `${column}${row}` };
  };
  const at = (ref: CellRef, from: string): string => {
    const { sheetName, local } = cell(ref);
    return ref.sheet === from ? local : `${quotedSheet(sheetName)}!${local}`;
  };
  const local = (ref: CellRef) => cell(ref).local;
  return { at, local, sheetName: (id: string) => sheets.get(id)?.name ?? "" };
}

function formulaText(formula: Formula, sheet: string, at: (ref: CellRef, from: string) => string) {
  return formula
    .map((part) => {
      if (typeof part === "string") return part;
      if ("from" in part)
        return `${at(part.from, sheet)}:${at(part.to, sheet).replace(/^.*!/, "")}`;
      return at(part, sheet);
    })
    .join("")
    .replace(/^=/, "");
}

function createStyles() {
  const formats = new Map<string, number>();
  const xfs = new Map<string, number>([["0|0|0", 0]]);
  const style = (cell: SheetCell, bold: boolean): number => {
    let formatId = 0;
    if (cell.format && cell.format !== "General") {
      formatId = formats.get(cell.format) ?? 164 + formats.size;
      formats.set(cell.format, formatId);
    }
    const key = `${formatId}|${bold ? 1 : 0}|${cell.wrap ? 1 : 0}`;
    let id = xfs.get(key);
    if (id === undefined) {
      id = xfs.size;
      xfs.set(key, id);
    }
    return id;
  };
  const xml = () => {
    const numFmts = [...formats]
      .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`)
      .join("");
    const cellXfs = [...xfs.keys()]
      .map((key) => {
        const [formatId = 0, bold = 0, wrap = 0] = key.split("|").map(Number);
        return `<xf numFmtId="${formatId}" fontId="${bold}" fillId="0" borderId="0" xfId="0"${formatId ? ' applyNumberFormat="1"' : ""}${bold ? ' applyFont="1"' : ""} applyAlignment="1"><alignment vertical="top"${wrap ? ' wrapText="1"' : ""}/></xf>`;
      })
      .join("");
    return `${DECLARATION}<styleSheet xmlns="${MAIN}">${formats.size > 0 ? `<numFmts count="${formats.size}">${numFmts}</numFmts>` : ""}<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.size}">${cellXfs}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  };
  return { style, xml };
}

function createSharedStrings() {
  const index = new Map<string, number>();
  let count = 0;
  const add = (text: string): number => {
    count++;
    let at = index.get(text);
    if (at === undefined) {
      at = index.size;
      index.set(text, at);
    }
    return at;
  };
  const xml = () =>
    `${DECLARATION}<sst xmlns="${MAIN}" count="${count}" uniqueCount="${index.size}">${[
      ...index.keys(),
    ]
      .map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
      .join("")}</sst>`;
  return { add, xml };
}

const cutText = (text: string) =>
  text.length > MAX_CELL_TEXT ? `${text.slice(0, MAX_CELL_TEXT - 1)}…` : text;

interface WrittenSheet {
  xml: string;
  notes: { ref: string; row: number; column: number; text: string }[];
}

function cellXml(
  ref: string,
  styled: string,
  formula: string,
  value: CellValue,
  strings: ReturnType<typeof createSharedStrings>,
): string {
  switch (value.kind) {
    case "text":
      return `<c r="${ref}"${styled} t="s">${formula}<v>${strings.add(cutText(value.text))}</v></c>`;
    case "number":
      return `<c r="${ref}"${styled}>${formula}<v>${value.number}</v></c>`;
    case "date":
      return `<c r="${ref}"${styled}>${formula}<v>${dateSerial(value.date)}</v></c>`;
    case "empty":
      return formula || styled ? `<c r="${ref}"${styled}>${formula}</c>` : "";
  }
}

function worksheetXml(
  sheet: Sheet,
  styles: ReturnType<typeof createStyles>,
  strings: ReturnType<typeof createSharedStrings>,
  where: ReturnType<typeof addresses>,
): WrittenSheet {
  const columns = new Map(sheet.columns.map((column, at) => [column.id, at]));
  const notes: WrittenSheet["notes"] = [];
  const links: string[] = [];
  const rows = sheet.rows.map((row, rowAt) => {
    const number = rowAt + 1;
    const cells = row.cells
      .flatMap((cell) => {
        const column = columns.get(cell.column);
        return column === undefined ? [] : [{ cell, column }];
      })
      .sort((a, b) => a.column - b.column)
      .map(({ cell, column }) => {
        const ref = `${columnName(column)}${number}`;
        const s = styles.style(cell, row.header === true);
        const styled = s ? ` s="${s}"` : "";
        if (cell.note) notes.push({ ref, row: rowAt, column, text: cell.note });
        if (cell.link) {
          const target = `${quotedSheet(where.sheetName(cell.link.sheet))}!${where.local(cell.link)}`;
          links.push(
            `<hyperlink ref="${ref}" location="${escapeXml(target)}" display="${escapeXml(where.local(cell.link))}"/>`,
          );
        }
        const formula = cell.formula
          ? `<f>${escapeXml(formulaText(cell.formula, sheet.id, where.at))}</f>`
          : "";
        return cellXml(ref, styled, formula, cell.value, strings);
      })
      .join("");
    return `<row r="${number}">${cells}</row>`;
  });
  const widths = sheet.columns.flatMap((column, at) =>
    column.width === undefined
      ? []
      : [`<col min="${at + 1}" max="${at + 1}" width="${column.width}" customWidth="1"/>`],
  );
  const frozenRows = sheet.frozen?.rows ?? 0;
  const frozenColumns = sheet.frozen?.columns ?? 0;
  const topLeft = `${columnName(frozenColumns)}${frozenRows + 1}`;
  const pane =
    frozenRows || frozenColumns
      ? `<pane${frozenColumns ? ` xSplit="${frozenColumns}"` : ""}${frozenRows ? ` ySplit="${frozenRows}"` : ""} topLeftCell="${topLeft}" activePane="${frozenRows && frozenColumns ? "bottomRight" : frozenRows ? "bottomLeft" : "topRight"}" state="frozen"/><selection pane="${frozenRows && frozenColumns ? "bottomRight" : frozenRows ? "bottomLeft" : "topRight"}" activeCell="${topLeft}" sqref="${topLeft}"/>`
      : "";
  const xml = `${DECLARATION}<worksheet xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${widths.length > 0 ? `<cols>${widths.join("")}</cols>` : ""}<sheetData>${rows.join("")}</sheetData>${links.length > 0 ? `<hyperlinks>${links.join("")}</hyperlinks>` : ""}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${notes.length > 0 ? '<legacyDrawing r:id="rId1"/>' : ""}</worksheet>`;
  return { xml, notes };
}

const commentsXml = (notes: WrittenSheet["notes"], author: string) =>
  `${DECLARATION}<comments xmlns="${MAIN}"><authors><author>${escapeXml(author)}</author></authors><commentList>${notes
    .map(
      (note) =>
        `<comment ref="${note.ref}" authorId="0"><text><r><rPr><sz val="9"/><rFont val="Tahoma"/><family val="2"/></rPr><t xml:space="preserve">${escapeXml(cutText(note.text))}</t></r></text></comment>`,
    )
    .join("")}</commentList></comments>`;

/** Each drawing owns blocks of 1,024 shape ids, and its idmap lists them; ids outside its blocks break the file. */
const SHAPE_BLOCK = 1024;

const notesVml = (notes: WrittenSheet["notes"], firstBlock: number, blocks: number) =>
  `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${Array.from({ length: blocks }, (_, at) => firstBlock + at).join(",")}"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${notes
    .map(
      (note, index) =>
        `<v:shape id="_x0000_s${firstBlock * SHAPE_BLOCK + index + 1}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:216pt;height:108pt;z-index:${index + 1};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${note.column + 1}, 15, ${note.row}, 2, ${note.column + 5}, 15, ${note.row + 7}, 2</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${note.row}</x:Row><x:Column>${note.column}</x:Column></x:ClientData></v:shape>`,
    )
    .join("")}</xml>`;

export interface XlsxOptions {
  /** Who the notes are by, as Excel names a note's author. */
  author: string;
  /** When it was made, ISO 8601 UTC. */
  created: string;
}

export function writeXlsx(book: SheetBook, deflate: Deflate, options: XlsxOptions): Uint8Array {
  const names = sheetNames(book.sheets);
  const where = addresses(book, names);
  const styles = createStyles();
  const strings = createSharedStrings();
  const entries: ZipWriteEntry[] = [];
  const overrides: string[] = [];
  const workbookRels: string[] = [];
  let hasFormulas = false;
  let nextBlock = 1;
  book.sheets.forEach((sheet, index) => {
    const number = index + 1;
    hasFormulas ||= sheet.rows.some((row) => row.cells.some((cell) => cell.formula));
    const written = worksheetXml(sheet, styles, strings, where);
    entries.push({ name: `xl/worksheets/sheet${number}.xml`, data: written.xml });
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="${SPREADSHEETML}.worksheet+xml"/>`,
    );
    workbookRels.push(
      `<Relationship Id="rId${number}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${number}.xml"/>`,
    );
    if (written.notes.length > 0) {
      const blocks = Math.ceil((written.notes.length + 1) / SHAPE_BLOCK);
      const firstBlock = nextBlock;
      nextBlock += blocks;
      entries.push(
        { name: `xl/comments${number}.xml`, data: commentsXml(written.notes, options.author) },
        {
          name: `xl/drawings/vmlDrawing${number}.vml`,
          data: notesVml(written.notes, firstBlock, blocks),
        },
        {
          name: `xl/worksheets/_rels/sheet${number}.xml.rels`,
          data: `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${RELATIONSHIPS}/vmlDrawing" Target="../drawings/vmlDrawing${number}.vml"/><Relationship Id="rId2" Type="${RELATIONSHIPS}/comments" Target="../comments${number}.xml"/></Relationships>`,
        },
      );
      overrides.push(
        `<Override PartName="/xl/comments${number}.xml" ContentType="${SPREADSHEETML}.comments+xml"/>`,
      );
    }
  });
  const count = book.sheets.length;
  workbookRels.push(
    `<Relationship Id="rId${count + 1}" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId${count + 2}" Type="${RELATIONSHIPS}/sharedStrings" Target="sharedStrings.xml"/>`,
  );
  const workbook = `${DECLARATION}<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><bookViews><workbookView/></bookViews><sheets>${names
    .map(
      (name, index) =>
        `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join(
      "",
    )}</sheets>${hasFormulas ? '<calcPr calcId="191029" fullCalcOnLoad="1"/>' : ""}</workbook>`;
  return writeZip(
    [
      {
        name: "[Content_Types].xml",
        data: `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/workbook.xml" ContentType="${SPREADSHEETML}.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${SPREADSHEETML}.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${SPREADSHEETML}.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides.join("")}</Types>`,
      },
      {
        name: "_rels/.rels",
        data: `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${RELATIONSHIPS}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
      },
      {
        name: "docProps/app.xml",
        data: `${DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>IncarnaMind</Application></Properties>`,
      },
      {
        name: "docProps/core.xml",
        data: `${DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(options.created.replace(/\.\d+Z$/, "Z"))}</dcterms:created></cp:coreProperties>`,
      },
      { name: "xl/workbook.xml", data: workbook },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">${workbookRels.join("")}</Relationships>`,
      },
      ...entries,
      { name: "xl/styles.xml", data: styles.xml() },
      { name: "xl/sharedStrings.xml", data: strings.xml() },
    ],
    deflate,
  );
}
