/**
 * A chart's embedded workbook (#1264), a package inside the deck's package:
 * its cells are read and written through the same patch layer, so the cells
 * and parts it doesn't change keep their bytes.
 */
import { deflateRawSync } from "node:zlib";
import { child, descendants, elements, textOf, type XmlElement } from "../../documents/formats/xml";
import { openPackage } from "../../documents/formats/zip";
import { checkWellFormed, PackagePartError, PackageWriter } from "../packagePatch/package";
import { appendInside, applySplices, endOf, type Splice, startOf } from "../packagePatch/text";
import { escapeXml } from "../wordml";

const SPREADSHEET_RELATIONSHIPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const COMMENTS_RELATIONSHIP = `${SPREADSHEET_RELATIONSHIPS}/comments`;
const VML_RELATIONSHIP = `${SPREADSHEET_RELATIONSHIPS}/vmlDrawing`;
const COMMENTS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml";
const VML_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.vmlDrawing";

/** A cell reference split: "B12" → column 2, row 12. */
export function cellAt(ref: string): { column: number; row: number } {
  const match = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref.toUpperCase());
  if (!match) throw new Error(`Not a cell reference: ${ref}`);
  let column = 0;
  for (const letter of match[1] as string) column = column * 26 + letter.charCodeAt(0) - 64;
  return { column, row: Number(match[2]) };
}

export function refOf(column: number, row: number): string {
  let letters = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return `${letters}${row}`;
}

/** A chart formula's sheet and cells, in order: "Sheet1!$B$2:$B$5" → Sheet1, B2…B5. */
export function formulaCells(formula: string): { sheet: string; cells: string[] } {
  const bang = formula.lastIndexOf("!");
  if (bang < 0) throw new Error(`Not a sheet range: ${formula}`);
  const sheet = formula
    .slice(0, bang)
    .replace(/^'(.*)'$/, "$1")
    .replace(/''/g, "'");
  const [from = "", to = from] = formula
    .slice(bang + 1)
    .replace(/^\(|\)$/g, "")
    .split(":");
  const start = cellAt(from);
  const end = cellAt(to);
  const cells: string[] = [];
  for (let row = start.row; row <= end.row; row++) {
    for (let column = start.column; column <= end.column; column++) cells.push(refOf(column, row));
  }
  // A range down a column reads top to bottom; one along a row, left to right: both are this order.
  return { sheet, cells };
}

export class Workbook {
  private constructor(readonly pkg: PackageWriter) {}

  static open(bytes: Uint8Array): Workbook {
    return new Workbook(new PackageWriter(openPackage(bytes)));
  }

  /** The worksheet part of a sheet, by its name in the workbook. */
  async sheetPart(name: string): Promise<string> {
    const workbook = await this.pkg.part("xl/workbook.xml");
    if (!workbook) throw new PackagePartError("xl/workbook.xml", "is missing.");
    const sheet = descendants(workbook.root, "sheet").find((each) => each.attrs.name === name);
    const id = sheet && Object.entries(sheet.attrs).find(([key]) => key.endsWith(":id"))?.[1];
    const target =
      id &&
      (await this.pkg.relationshipsOf("xl/workbook.xml")).existing.find((each) => each.id === id)
        ?.target;
    if (!target) throw new PackagePartError("xl/workbook.xml", `has no sheet named "${name}".`);
    return target;
  }

  private async sharedStrings(): Promise<string[]> {
    const part = await this.pkg.part("xl/sharedStrings.xml");
    if (!part) return [];
    return descendants(part.root, "si").map((item) =>
      descendants(item, "t")
        .map((each) => textOf(each))
        .join(""),
    );
  }

  /** The cells' values as Excel shows them: numbers as numbers, text as text, empty as null. */
  async read(sheet: string, cells: readonly string[]): Promise<(number | string | null)[]> {
    const part = await this.pkg.part(await this.sheetPart(sheet));
    if (!part) throw new PackagePartError(sheet, "is missing.");
    const strings = await this.sharedStrings();
    const found = new Map(descendants(part.root, "c").map((cell) => [cell.attrs.r ?? "", cell]));
    return cells.map((ref) => {
      const cell = found.get(ref);
      if (!cell) return null;
      const value = child(cell, "v");
      if (cell.attrs.t === "s") return value ? (strings[Number(textOf(value))] ?? null) : null;
      if (cell.attrs.t === "inlineStr") return textOf(child(cell, "is") ?? cell);
      if (cell.attrs.t === "str") return value ? textOf(value) : null;
      if (!value) return null;
      const number = Number(textOf(value));
      return Number.isFinite(number) ? number : textOf(value);
    });
  }

  /**
   * Writes numbers into cells, keeping each cell's style. A cell with a
   * formula is refused: its value would be recalculated over what was written.
   */
  async writeNumbers(sheet: string, values: ReadonlyMap<string, number>): Promise<void> {
    const name = await this.sheetPart(sheet);
    const part = await this.pkg.part(name);
    if (!part) throw new PackagePartError(name, "is missing.");
    const sheetData = descendants(part.root, "sheetData")[0];
    if (!sheetData) throw new PackagePartError(name, "has no sheetData.");
    const prefix = sheetData.name.includes(":")
      ? sheetData.name.slice(0, sheetData.name.indexOf(":") + 1)
      : "";
    const rows = new Map(
      elements(sheetData)
        .filter((each) => each.name === `${prefix}row`)
        .map((row) => [Number(row.attrs.r), row]),
    );
    const splices: Splice[] = [];
    const cellXml = (ref: string, value: number, style: string | undefined) =>
      `<${prefix}c r="${ref}"${style ? ` s="${escapeXml(style)}"` : ""}><${prefix}v>${value}</${prefix}v></${prefix}c>`;
    const newRows = new Map<number, string[]>();
    for (const [ref, value] of values) {
      const { row: rowNumber, column } = cellAt(ref);
      const row = rows.get(rowNumber);
      const cells = row ? elements(row).filter((each) => each.name === `${prefix}c`) : [];
      const cell = cells.find((each) => each.attrs.r === ref);
      if (cell && child(cell, `${prefix}f`)) {
        throw new PackagePartError(name, `cell ${ref} holds a formula.`);
      }
      if (cell) {
        splices.push({
          from: startOf(cell),
          to: endOf(cell),
          text: cellXml(ref, value, cell.attrs.s),
        });
      } else if (row) {
        const after = cells.find((each) => cellAt(each.attrs.r ?? "A1").column > column);
        const at = after ? startOf(after) : undefined;
        splices.push(
          at === undefined
            ? appendInside(part.text, row, cellXml(ref, value, undefined))
            : { from: at, to: at, text: cellXml(ref, value, undefined) },
        );
      } else {
        const list = newRows.get(rowNumber) ?? [];
        list.push(cellXml(ref, value, undefined));
        newRows.set(rowNumber, list);
      }
    }
    for (const [rowNumber, cells] of [...newRows].sort(([a], [b]) => a - b)) {
      const xml = `<${prefix}row r="${rowNumber}">${cells.join("")}</${prefix}row>`;
      const after = [...rows.entries()].find(([number]) => number > rowNumber)?.[1];
      splices.push(
        after
          ? { from: startOf(after), to: startOf(after), text: xml }
          : appendInside(part.text, sheetData, xml),
      );
    }
    this.pkg.set(name, applySplices(part.text, splices));
  }

  /**
   * Puts an Excel note on a cell (legacy comments, drawn by VML, which is
   * what Excel and PowerPoint's Edit Data show), as a Citation could be kept
   * on a chart's figure.
   */
  async addNote(sheet: string, ref: string, author: string, text: string): Promise<void> {
    const name = await this.sheetPart(sheet);
    const part = await this.pkg.part(name);
    if (!part) throw new PackagePartError(name, "is missing.");
    const relationships = await this.pkg.relationshipsOf(name);
    if (relationships.ofType(COMMENTS_RELATIONSHIP) || child(part.root, "legacyDrawing")) {
      throw new PackagePartError(name, "already has notes.");
    }
    const comments = this.pkg.freeName("xl/comments", "xml");
    const drawing = this.pkg.freeName("xl/drawings/vmlDrawing", "vml");
    const { row, column } = cellAt(ref);
    this.pkg.add(
      comments,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>${escapeXml(author)}</author></authors><commentList><comment ref="${ref}" authorId="0"><text><r><t xml:space="preserve">${escapeXml(text)}</t></r></text></comment></commentList></comments>`,
    );
    this.pkg.add(
      drawing,
      `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype><v:shape id="_x0000_s1025" type="#_x0000_t202" style="position:absolute;margin-left:80pt;margin-top:2pt;width:108pt;height:59.25pt;z-index:1;visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:AutoFill>False</x:AutoFill><x:Row>${row - 1}</x:Row><x:Column>${column - 1}</x:Column></x:ClientData></v:shape></xml>`,
    );
    await this.pkg.addContentType(comments, COMMENTS_CONTENT_TYPE);
    await this.pkg.addDefaultContentType("vml", VML_CONTENT_TYPE);
    const folder = name.slice(0, name.lastIndexOf("/") + 1);
    const relative = (target: string) =>
      target.startsWith("xl/") && folder === "xl/worksheets/" ? `../${target.slice(3)}` : target;
    relationships.add(COMMENTS_RELATIONSHIP, relative(comments));
    const id = relationships.add(VML_RELATIONSHIP, relative(drawing));
    // The schema's order puts legacyDrawing after drawing and before legacyDrawingHF, picture,
    // oleObjects, controls, webPublishItems, tableParts and extLst.
    const later = [
      "legacyDrawingHF",
      "picture",
      "oleObjects",
      "controls",
      "webPublishItems",
      "tableParts",
      "extLst",
    ]
      .map((each) => child(part.root, each))
      .find((each): each is XmlElement => each !== undefined);
    const xml = `<legacyDrawing r:id="${id}" xmlns:r="${SPREADSHEET_RELATIONSHIPS}"/>`;
    const splice: Splice = later
      ? { from: startOf(later), to: startOf(later), text: xml }
      : appendInside(part.text, part.root, xml);
    this.pkg.set(name, applySplices(part.text, [splice]));
  }

  save(): Promise<Uint8Array> {
    return this.pkg.write(deflateRawSync, checkWellFormed);
  }
}
