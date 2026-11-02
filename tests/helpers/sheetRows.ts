/**
 * One-sheet .xlsx files whose rows the file can strike through or hide, as a person sets an
 * older version of a row aside in Excel (#1979). Test data only.
 */
import { xlsxPackage } from "./office";

/** A number format a cell can show: Excel's General, or one of these codes. */
export type CellFormat = "general" | "0.00" | "0.000" | "#,##0";

export type SheetValue =
  | string
  | number
  | { value: number; format: CellFormat }
  | { formula: string; value: number; format?: CellFormat };

export interface SheetRow {
  cells: SheetValue[];
  /** Every cell of the row in a struck-through font. */
  struck?: boolean;
  /** The row hidden, as Excel's Hide Rows leaves it. */
  hidden?: boolean;
}

const FORMATS: readonly CellFormat[] = ["general", "0.00", "0.000", "#,##0"];
const FORMAT_IDS: Record<CellFormat, number> = {
  general: 0,
  "0.00": 2,
  "0.000": 164,
  "#,##0": 3,
};

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const columnName = (index: number) => String.fromCharCode(65 + index);

/** Each format once in a plain font, then once struck through. */
const styleOf = (format: CellFormat, struck: boolean) =>
  FORMATS.indexOf(format) + (struck ? FORMATS.length : 0);

const STYLES = (() => {
  const xf = (format: CellFormat, struck: boolean) =>
    `<xf numFmtId="${FORMAT_IDS[format]}" fontId="${struck ? 1 : 0}" fillId="0" borderId="0" xfId="0"${format === "general" ? "" : ' applyNumberFormat="1"'}${struck ? ' applyFont="1"' : ""}/>`;
  const xfs = [
    ...FORMATS.map((format) => xf(format, false)),
    ...FORMATS.map((format) => xf(format, true)),
  ];
  return `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><strike/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>`;
})();

function cellXml(ref: string, value: SheetValue, struck: boolean): string {
  if (value === "") return "";
  if (typeof value === "string")
    return `<c r="${ref}" s="${styleOf("general", struck)}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  if (typeof value === "number")
    return `<c r="${ref}" s="${styleOf("general", struck)}"><v>${value}</v></c>`;
  const style = styleOf(value.format ?? "general", struck);
  if ("formula" in value)
    return `<c r="${ref}" s="${style}"><f>${escapeXml(value.formula)}</f><v>${value.value}</v></c>`;
  return `<c r="${ref}" s="${style}"><v>${value.value}</v></c>`;
}

/** A workbook of one sheet with these rows, from row 1. */
export function sheetWithRows(name: string, rows: readonly SheetRow[]): Buffer {
  const data = rows
    .map((row, index) => {
      const number = index + 1;
      const cells = row.cells
        .map((value, column) =>
          cellXml(`${columnName(column)}${number}`, value, row.struck ?? false),
        )
        .join("");
      return `<row r="${number}"${row.hidden ? ' hidden="1"' : ""}>${cells}</row>`;
    })
    .join("");
  return xlsxPackage({
    sheets: [{ name, xml: `<sheetData>${data}</sheetData>` }],
    styles: STYLES,
  });
}
