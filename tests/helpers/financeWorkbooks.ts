/**
 * Finance models as .xlsx files, built in the tests (#2347): a DCF, a small
 * LBO and three linked statements, each with an assumptions sheet, defined
 * names, cross-sheet references and shared formulas; workbooks of what can't
 * be worked out; and one of over 10,000 formulas. Each formula's saved result
 * is worked out here in plain JavaScript, as Excel would save it, apart from
 * IncarnaMind's own formula engine. They are what LibreOffice is given to
 * work out (with their results taken out), and the files it saves are the
 * fixtures tests compare with (`libreOfficeFixture`). Test data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildZip } from "./zip";

type Format = "general" | "percent" | "money" | "multiple" | "date";
const STYLE: Record<Format, number> = { general: 0, percent: 1, money: 2, multiple: 3, date: 4 };

type Saved = number | string | boolean | null;

interface Cell {
  value: Saved;
  formula?: string;
  /** A shared formula: its id, and its range on the cell that writes it. */
  shared?: { id: number; ref?: string };
  /** An array formula over this block. */
  array?: string;
  format: Format;
  error?: true;
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const columnLetters = (index: number): string => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

export function refParts(ref: string): { column: number; row: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) throw new Error(`Not a cell: ${ref}`);
  let column = 0;
  for (const letter of match[1] ?? "") column = column * 26 + (letter.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(match[2]) };
}

export const refOf = (column: number, row: number): string => `${columnLetters(column)}${row}`;

export class SheetBuilder {
  readonly cells = new Map<string, Cell>();
  state?: "hidden";

  constructor(
    readonly name: string,
    private readonly book: WorkbookBuilder,
  ) {}

  text(ref: string, text: string): this {
    this.cells.set(ref, { value: text, format: "general" });
    return this;
  }

  number(ref: string, value: number, format: Format = "general"): this {
    this.cells.set(ref, { value, format });
    return this;
  }

  flag(ref: string, value: boolean): this {
    this.cells.set(ref, { value, format: "general" });
    return this;
  }

  /** An error typed into a cell, as Excel keeps "#N/A" typed in. */
  error(ref: string, code: string): this {
    this.cells.set(ref, { value: code, format: "general", error: true });
    return this;
  }

  formula(ref: string, formula: string, value: Saved, format: Format = "general"): this {
    this.cells.set(ref, { value, formula, format });
    return this;
  }

  /**
   * A shared formula across a row or column: `formula` is the first cell's,
   * `value` gives each cell's result by its place in the range, from 0.
   */
  fill(
    range: string,
    formula: string,
    value: (offset: number, ref: string) => number,
    format: Format = "general",
  ): this {
    const [from, to] = range.split(":") as [string, string];
    const a = refParts(from);
    const b = refParts(to);
    const id = this.book.nextShared++;
    let offset = 0;
    for (let row = a.row; row <= b.row; row++) {
      for (let column = a.column; column <= b.column; column++) {
        const ref = refOf(column, row);
        const first = offset === 0;
        this.cells.set(ref, {
          value: value(offset, ref),
          formula: first ? formula : "",
          shared: first ? { id, ref: range } : { id },
          format,
        });
        offset++;
      }
    }
    return this;
  }

  /** A cell's saved value, as a number. */
  n(ref: string): number {
    const value = this.cells.get(ref)?.value;
    if (typeof value !== "number")
      throw new Error(`${this.name}!${ref} isn't a number: ${String(value)}`);
    return value;
  }
}

export interface XlsxOptions {
  /** As a program that writes formulas leaves them: no saved results. */
  withoutResults?: boolean;
  /** Excel recalculates everything when it opens the file (LibreOffice too). */
  recalculateOnOpen?: boolean;
}

export class WorkbookBuilder {
  readonly sheets: SheetBuilder[] = [];
  readonly names: { name: string; sheet?: string; refersTo: string }[] = [];
  calc: { iterate?: boolean; manual?: boolean } = {};
  /** Its dates count from 1904. */
  date1904 = false;
  nextShared = 0;

  sheet(name: string): SheetBuilder {
    const sheet = new SheetBuilder(name, this);
    this.sheets.push(sheet);
    return sheet;
  }

  name(name: string, refersTo: string, sheet?: string): this {
    this.names.push({ name, refersTo, ...(sheet ? { sheet } : {}) });
    return this;
  }

  get(sheet: string): SheetBuilder {
    const found = this.sheets.find((each) => each.name === sheet);
    if (!found) throw new Error(`No sheet ${sheet}`);
    return found;
  }

  formulaCount(): number {
    return this.sheets.reduce(
      (total, sheet) =>
        total + [...sheet.cells.values()].filter((cell) => cell.formula !== undefined).length,
      0,
    );
  }

  xlsx(options: XlsxOptions = {}): Buffer {
    const ns = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
    const sheetXml = (sheet: SheetBuilder) => {
      const rows = new Map<number, [number, string, Cell][]>();
      for (const [ref, cell] of sheet.cells) {
        const { row, column } = refParts(ref);
        const list = rows.get(row) ?? [];
        list.push([column, ref, cell]);
        rows.set(row, list);
      }
      const body = [...rows.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([row, cells]) => {
          const xml = cells
            .sort((a, b) => a[0] - b[0])
            .map(([, ref, cell]) => cellXml(ref, cell, options))
            .join("");
          return `<row r="${row}">${xml}</row>`;
        })
        .join("");
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${ns}><sheetData>${body}</sheetData></worksheet>`;
    };
    const definedNames =
      this.names.length === 0
        ? ""
        : `<definedNames>${this.names
            .map((each) => {
              const local = each.sheet
                ? ` localSheetId="${this.sheets.findIndex((sheet) => sheet.name === each.sheet)}"`
                : "";
              return `<definedName name="${escapeXml(each.name)}"${local}>${escapeXml(each.refersTo)}</definedName>`;
            })
            .join("")}</definedNames>`;
    const calc = `<calcPr calcId="191029"${this.calc.iterate ? ' iterate="1"' : ""}${this.calc.manual ? ' calcMode="manual"' : ""}${options.recalculateOnOpen ? ' fullCalcOnLoad="1"' : ""}/>`;
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${ns}>${this.date1904 ? '<workbookPr date1904="1"/>' : ""}<sheets>${this.sheets
      .map(
        (sheet, index) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="rId${index + 1}"/>`,
      )
      .join("")}</sheets>${definedNames}${calc}</workbook>`;
    const rel = (id: string, type: string, target: string) =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${ns}><numFmts count="4"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.0"/><numFmt numFmtId="166" formatCode="0.0&quot;x&quot;"/><numFmt numFmtId="167" formatCode="yyyy-mm-dd"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
    return buildZip([
      {
        name: "[Content_Types].xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${this.sheets
          .map(
            (_, index) =>
              `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join(
            "",
          )}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      },
      {
        name: "_rels/.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      },
      { name: "xl/workbook.xml", data: workbook },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.sheets
          .map((_, index) =>
            rel(`rId${index + 1}`, "worksheet", `worksheets/sheet${index + 1}.xml`),
          )
          .join("")}${rel("rIdS", "styles", "styles.xml")}</Relationships>`,
      },
      { name: "xl/styles.xml", data: styles },
      ...this.sheets.map((sheet, index) => ({
        name: `xl/worksheets/sheet${index + 1}.xml`,
        data: sheetXml(sheet),
      })),
    ]);
  }
}

function cellXml(ref: string, cell: Cell, options: XlsxOptions): string {
  const style = STYLE[cell.format] ? ` s="${STYLE[cell.format]}"` : "";
  if (cell.formula === undefined) {
    if (cell.error)
      return `<c r="${ref}"${style} t="e"><v>${escapeXml(String(cell.value))}</v></c>`;
    if (typeof cell.value === "string")
      return `<c r="${ref}"${style} t="inlineStr"><is><t>${escapeXml(cell.value)}</t></is></c>`;
    if (typeof cell.value === "boolean")
      return `<c r="${ref}"${style} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
    if (cell.value === null) return "";
    return `<c r="${ref}"${style}><v>${cell.value}</v></c>`;
  }
  const f = cell.array
    ? `<f t="array" ref="${cell.array}">${escapeXml(cell.formula)}</f>`
    : cell.shared
      ? cell.shared.ref
        ? `<f t="shared" ref="${cell.shared.ref}" si="${cell.shared.id}">${escapeXml(cell.formula)}</f>`
        : `<f t="shared" si="${cell.shared.id}"/>`
      : `<f>${escapeXml(cell.formula)}</f>`;
  if (options.withoutResults || cell.value === null) return `<c r="${ref}"${style}>${f}</c>`;
  if (typeof cell.value === "string")
    return `<c r="${ref}"${style} t="str">${f}<v>${escapeXml(cell.value)}</v></c>`;
  if (typeof cell.value === "boolean")
    return `<c r="${ref}"${style} t="b">${f}<v>${cell.value ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${style}>${f}<v>${cell.value}</v></c>`;
}

const YEARS = ["C", "D", "E", "F", "G"];

/** Excel's serial number of a date. */
export function serial(year: number, month: number, day: number): number {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/**
 * A DCF: revenue grown from 2024 by an assumed growth, EBITDA at a margin,
 * free cash flow discounted at the WACC, a Gordon-growth terminal value, and
 * the value per share. The assumptions sheet's cells have names (Growth,
 * Margin, TaxRate, WACC). 2027's EBITDA is DCF!E5.
 */
export function dcfWorkbook(): WorkbookBuilder {
  const book = new WorkbookBuilder();
  const a = book.sheet("Assumptions");
  a.text("A1", "Assumptions").text("B1", "Value");
  a.text("A3", "Revenue 2024").number("B3", 1000, "money");
  a.text("A4", "Revenue growth").number("B4", 0.05, "percent");
  a.text("A5", "EBITDA margin").number("B5", 0.22, "percent");
  a.text("A6", "Tax rate").number("B6", 0.25, "percent");
  a.text("A7", "D&A % of revenue").number("B7", 0.03, "percent");
  a.text("A8", "Capex % of revenue").number("B8", 0.04, "percent");
  a.text("A9", "NWC % of revenue").number("B9", 0.1, "percent");
  a.text("A10", "WACC").number("B10", 0.09, "percent");
  a.text("A11", "Terminal growth").number("B11", 0.025, "percent");
  a.text("A12", "Net debt").number("B12", 350, "money");
  a.text("A13", "Shares outstanding").number("B13", 100, "money");
  a.text("A14", "Valuation date").number("B14", serial(2024, 12, 31), "date");
  book.name("Growth", "Assumptions!$B$4").name("Margin", "Assumptions!$B$5");
  book.name("TaxRate", "Assumptions!$B$6").name("WACC", "Assumptions!$B$10");

  const d = book.sheet("DCF");
  const g = a.n("B4");
  const m = a.n("B5");
  d.text("A1", "DCF ($m)");
  d.text("A3", "Year").number("B3", 2024);
  d.fill("C3:G3", "B3+1", (i) => 2025 + i);
  d.text("A4", "Revenue").formula("B4", "Assumptions!B3", a.n("B3"), "money");
  d.fill("C4:G4", "B4*(1+Growth)", (i) => a.n("B3") * (1 + g) ** (i + 1), "money");
  const revenue = (column: string) => d.n(`${column}4`);
  d.text("A5", "EBITDA");
  d.fill("C5:G5", "C4*Margin", (i) => revenue(YEARS[i] as string) * m, "money");
  d.text("A6", "D&A");
  d.fill("C6:G6", "C4*Assumptions!$B$7", (i) => revenue(YEARS[i] as string) * a.n("B7"), "money");
  d.text("A7", "EBIT");
  d.fill("C7:G7", "C5-C6", (i) => d.n(`${YEARS[i]}5`) - d.n(`${YEARS[i]}6`), "money");
  d.text("A8", "Taxes");
  d.fill(
    "C8:G8",
    "MAX(0,C7*TaxRate)",
    (i) => Math.max(0, d.n(`${YEARS[i]}7`) * a.n("B6")),
    "money",
  );
  d.text("A9", "NOPAT");
  d.fill("C9:G9", "C7-C8", (i) => d.n(`${YEARS[i]}7`) - d.n(`${YEARS[i]}8`), "money");
  d.text("A10", "Capex");
  d.fill("C10:G10", "C4*Assumptions!$B$8", (i) => revenue(YEARS[i] as string) * a.n("B8"), "money");
  d.text("A11", "Change in NWC");
  const previous = ["B", "C", "D", "E", "F"];
  d.fill(
    "C11:G11",
    "(C4-B4)*Assumptions!$B$9",
    (i) => (revenue(YEARS[i] as string) - d.n(`${previous[i]}4`)) * a.n("B9"),
    "money",
  );
  d.text("A12", "Free cash flow");
  d.fill(
    "C12:G12",
    "C9+C6-C10-C11",
    (i) => {
      const y = YEARS[i] as string;
      return d.n(`${y}9`) + d.n(`${y}6`) - d.n(`${y}10`) - d.n(`${y}11`);
    },
    "money",
  );
  d.text("A13", "Discount factor");
  d.fill("C13:G13", "1/(1+WACC)^(C3-$B$3)", (i) => 1 / (1 + a.n("B10")) ** (i + 1));
  d.text("A14", "PV of free cash flow");
  d.fill("C14:G14", "C12*C13", (i) => d.n(`${YEARS[i]}12`) * d.n(`${YEARS[i]}13`), "money");
  const sumPv = YEARS.reduce((total, y) => total + d.n(`${y}14`), 0);
  d.text("A16", "Sum of PV").formula("B16", "SUM(C14:G14)", sumPv, "money");
  const tv = (d.n("G12") * (1 + a.n("B11"))) / (a.n("B10") - a.n("B11"));
  d.text("A17", "Terminal value").formula(
    "B17",
    "G12*(1+Assumptions!B11)/(WACC-Assumptions!B11)",
    tv,
    "money",
  );
  d.text("A18", "PV of terminal value").formula("B18", "B17*G13", tv * d.n("G13"), "money");
  d.text("A19", "Enterprise value").formula("B19", "B16+B18", sumPv + tv * d.n("G13"), "money");
  d.text("A20", "Equity value").formula(
    "B20",
    "B19-Assumptions!B12",
    d.n("B19") - a.n("B12"),
    "money",
  );
  d.text("A21", "Value per share").formula(
    "B21",
    "ROUND(B20/Assumptions!B13,2)",
    Math.round((d.n("B20") / a.n("B13")) * 100) / 100,
    "money",
  );
  const npv = YEARS.reduce((total, y, i) => total + d.n(`${y}12`) / (1 + a.n("B10")) ** (i + 1), 0);
  d.text("A22", "NPV of free cash flow").formula("B22", "NPV(WACC,C12:G12)", npv, "money");
  d.text("A23", "EV / EBITDA 2025").formula("B23", "B19/C5", d.n("B19") / d.n("C5"), "multiple");
  d.text("A24", "Exit year").formula("B24", "YEAR(Assumptions!B14)+5", 2029);
  return book;
}

/**
 * A small LBO: bought at a multiple of EBITDA with debt, EBITDA grown, cash
 * swept to repay debt, sold at an exit multiple; IRR and MOIC, a dated XIRR,
 * and a term loan's PMT.
 */
export function lboWorkbook(): WorkbookBuilder {
  const book = new WorkbookBuilder();
  const s = book.sheet("LBO");
  s.text("A1", "LBO ($m)");
  s.text("A3", "Entry EBITDA").number("B3", 100, "money");
  s.text("A4", "Entry multiple").number("B4", 8, "multiple");
  s.text("A5", "Debt / EBITDA").number("B5", 5, "multiple");
  s.text("A6", "Interest rate").number("B6", 0.08, "percent");
  s.text("A7", "EBITDA growth").number("B7", 0.06, "percent");
  s.text("A8", "Exit multiple").number("B8", 8.5, "multiple");
  s.text("A9", "Tax rate").number("B9", 0.25, "percent");
  s.text("A10", "Capex % of EBITDA").number("B10", 0.15, "percent");
  s.text("A11", "Cash sweep").number("B11", 1, "percent");
  s.text("A12", "Close date").number("B12", serial(2024, 12, 31), "date");
  book.name("ExitMultiple", "LBO!$B$8");
  const entryEv = s.n("B3") * s.n("B4");
  const debt0 = s.n("B3") * s.n("B5");
  s.text("A14", "Entry EV").formula("B14", "B3*B4", entryEv, "money");
  s.text("A15", "Entry debt").formula("B15", "B3*B5", debt0, "money");
  s.text("A16", "Sponsor equity").formula("B16", "B14-B15", entryEv - debt0, "money");

  const cols = ["B", "C", "D", "E", "F", "G"];
  s.text("A18", "Year").number("B18", 0);
  s.fill("C18:G18", "B18+1", (i) => i + 1);
  s.text("A19", "Date").formula("B19", "B12", s.n("B12"), "date");
  const dates = [s.n("B12")];
  for (let i = 1; i <= 5; i++) dates.push(serial(2024 + i, 12, 31));
  s.fill("C19:G19", "EOMONTH(B19,12)", (i) => dates[i + 1] as number, "date");
  s.text("A20", "EBITDA").formula("B20", "B3", s.n("B3"), "money");
  s.fill("C20:G20", "B20*(1+$B$7)", (i) => s.n("B3") * (1 + s.n("B7")) ** (i + 1), "money");
  s.text("A21", "Interest");
  s.text("A22", "Taxes");
  s.text("A23", "Capex");
  s.text("A24", "Free cash flow");
  s.text("A25", "Debt repaid");
  s.text("A26", "Debt");
  s.formula("B26", "B15", debt0, "money");
  for (let i = 1; i <= 5; i++) {
    const c = cols[i] as string;
    const p = cols[i - 1] as string;
    const interest = s.n(`${p}26`) * s.n("B6");
    s.formula(`${c}21`, `${p}26*$B$6`, interest, "money");
    const taxes = Math.max(0, (s.n(`${c}20`) - interest) * s.n("B9"));
    s.formula(`${c}22`, `MAX(0,(${c}20-${c}21)*$B$9)`, taxes, "money");
    const capex = s.n(`${c}20`) * s.n("B10");
    s.formula(`${c}23`, `${c}20*$B$10`, capex, "money");
    const fcf = s.n(`${c}20`) - interest - taxes - capex;
    s.formula(`${c}24`, `${c}20-${c}21-${c}22-${c}23`, fcf, "money");
    const repaid = Math.min(fcf * s.n("B11"), s.n(`${p}26`));
    s.formula(`${c}25`, `MIN(${c}24*$B$11,${p}26)`, repaid, "money");
    s.formula(`${c}26`, `${p}26-${c}25`, s.n(`${p}26`) - repaid, "money");
  }
  const exitEv = s.n("G20") * s.n("B8");
  s.text("A28", "Exit EV").formula("B28", "G20*ExitMultiple", exitEv, "money");
  const exitEquity = exitEv - s.n("G26");
  s.text("A29", "Exit equity").formula("B29", "B28-G26", exitEquity, "money");
  s.text("A30", "MOIC").formula("B30", "IFERROR(B29/B16,0)", exitEquity / s.n("B16"), "multiple");
  s.text("A31", "Sponsor cash flows").formula("B31", "-B16", -s.n("B16"), "money");
  for (let i = 1; i <= 4; i++) s.formula(`${cols[i]}31`, "0", 0, "money");
  s.formula("G31", "B29", exitEquity, "money");
  const flows = [-s.n("B16"), 0, 0, 0, 0, exitEquity];
  const irr = (exitEquity / s.n("B16")) ** (1 / 5) - 1;
  s.text("A32", "IRR").formula("B32", "IRR(B31:G31)", irr, "percent");
  const xirr = solveXirr(flows, dates);
  s.text("A33", "XIRR").formula("B33", "XIRR(B31:G31,B19:G19)", xirr, "percent");
  const pmt = (s.n("B6") * debt0) / (1 - (1 + s.n("B6")) ** -5);
  s.text("A34", "Term loan payment").formula("B34", "PMT($B$6,5,-B15)", pmt, "money");
  s.text("A35", "Deal check").formula(
    "B35",
    'IF(B32>0.2,"Above hurdle","Below hurdle")',
    irr > 0.2 ? "Above hurdle" : "Below hurdle",
  );
  return book;
}

function solveXirr(flows: readonly number[], dates: readonly number[]): number {
  let rate = 0.1;
  for (let step = 0; step < 100; step++) {
    let value = 0;
    let slope = 0;
    flows.forEach((flow, at) => {
      const years = ((dates[at] ?? 0) - (dates[0] ?? 0)) / 365;
      value += flow / (1 + rate) ** years;
      slope -= (years * flow) / (1 + rate) ** (years + 1);
    });
    const next = rate - value / slope;
    if (Math.abs(next - rate) < 1e-15) return next;
    rate = next;
  }
  return rate;
}

/**
 * Three linked statements over 2025–2027: an inputs sheet of assumptions by
 * year (read with INDEX and MATCH, and with VLOOKUP over whole columns), an
 * income statement, a cash flow statement and a balance sheet that balances.
 */
export function threeStatementWorkbook(): WorkbookBuilder {
  const book = new WorkbookBuilder();
  const inputs = book.sheet("Inputs");
  inputs.text("A1", "Assumption").number("B1", 2025).number("C1", 2026).number("D1", 2027);
  const growth = [0.08, 0.07, 0.06];
  const cogs = [0.55, 0.54, 0.53];
  inputs.text("A2", "Revenue growth");
  inputs.text("A3", "COGS % revenue");
  growth.forEach((value, i) => {
    inputs.number(`${["B", "C", "D"][i]}2`, value, "percent");
  });
  cogs.forEach((value, i) => {
    inputs.number(`${["B", "C", "D"][i]}3`, value, "percent");
  });
  inputs.text("A5", "Opex").number("B5", 120, "money");
  inputs.text("A6", "Depreciation rate").number("B6", 0.1, "percent");
  inputs.text("A7", "Interest rate").number("B7", 0.06, "percent");
  inputs.text("A8", "Tax rate").number("B8", 0.21, "percent");
  inputs.text("A9", "DSO (days)").number("B9", 45);
  inputs.text("A10", "Capex").number("B10", 60, "money");
  inputs.text("A11", "Debt repayment").number("B11", 25, "money");
  inputs.text("A13", "Year").text("B13", "Opex growth");
  [2025, 2026, 2027].forEach((year, i) => {
    inputs
      .number(`A${14 + i}`, year)
      .number(`B${14 + i}`, [0.03, 0.04, 0.05][i] as number, "percent");
  });

  const is = book.sheet("IS");
  const bs = book.sheet("BS");
  const cf = book.sheet("CF");
  const years = ["C", "D", "E"];
  for (const sheet of [is, bs, cf]) {
    sheet.text(
      "A1",
      sheet.name === "IS"
        ? "Income statement"
        : sheet.name === "BS"
          ? "Balance sheet"
          : "Cash flow",
    );
    sheet.text("A2", "Year").number("B2", 2024);
    sheet.fill("C2:E2", "B2+1", (i) => 2025 + i);
  }
  // 2024 opening balance sheet.
  bs.text("A3", "Cash").number("B3", 80, "money");
  bs.text("A4", "Receivables").number("B4", 110, "money");
  bs.text("A5", "PP&E").number("B5", 400, "money");
  bs.text("A6", "Total assets").formula("B6", "SUM(B3:B5)", 590, "money");
  bs.text("A7", "Debt").number("B7", 250, "money");
  bs.text("A8", "Equity").number("B8", 340, "money");
  bs.text("A9", "Total liabilities and equity").formula("B9", "B7+B8", 590, "money");
  bs.text("A10", "Balance check").formula("B10", "ROUND(B6-B9,6)", 0);
  is.text("A3", "Revenue").number("B3", 900, "money");

  for (let i = 0; i < 3; i++) {
    const c = years[i] as string;
    const p = (i === 0 ? "B" : years[i - 1]) as string;
    const g = growth[i] as number;
    const revenue = is.n(`${p}3`) * (1 + g);
    is.formula(
      `${c}3`,
      `${p}3*(1+INDEX(Inputs!$B$2:$D$2,MATCH(${c}$2,Inputs!$B$1:$D$1,0)))`,
      revenue,
      "money",
    );
    const cost = revenue * (cogs[i] as number);
    is.text("A4", "COGS").formula(
      `${c}4`,
      `${c}3*HLOOKUP(${c}$2,Inputs!$B$1:$D$3,3,FALSE)`,
      cost,
      "money",
    );
    is.text("A5", "Gross profit").formula(`${c}5`, `${c}3-${c}4`, revenue - cost, "money");
    const opexGrowth = [0.03, 0.04, 0.05][i] as number;
    const opexValue =
      i === 0 ? inputs.n("B5") * (1 + opexGrowth) : is.n(`${p}6`) * (1 + opexGrowth);
    is.text("A6", "Opex").formula(
      `${c}6`,
      i === 0
        ? `Inputs!$B$5*(1+VLOOKUP(${c}$2,Inputs!A:B,2,FALSE))`
        : `${p}6*(1+VLOOKUP(${c}$2,Inputs!A:B,2,FALSE))`,
      opexValue,
      "money",
    );
    const ebitda = revenue - cost - opexValue;
    is.text("A7", "EBITDA").formula(`${c}7`, `${c}5-${c}6`, ebitda, "money");
    const dep = bs.n(`${p}5`) * inputs.n("B6");
    is.text("A8", "Depreciation").formula(`${c}8`, `BS!${p}5*Inputs!$B$6`, dep, "money");
    is.text("A9", "EBIT").formula(`${c}9`, `${c}7-${c}8`, ebitda - dep, "money");
    const interest = bs.n(`${p}7`) * inputs.n("B7");
    is.text("A10", "Interest").formula(`${c}10`, `BS!${p}7*Inputs!$B$7`, interest, "money");
    const ebt = ebitda - dep - interest;
    is.text("A11", "Pre-tax income").formula(`${c}11`, `${c}9-${c}10`, ebt, "money");
    const tax = Math.max(0, ebt * inputs.n("B8"));
    is.text("A12", "Tax").formula(`${c}12`, `MAX(0,${c}11*Inputs!$B$8)`, tax, "money");
    const ni = ebt - tax;
    is.text("A13", "Net income").formula(`${c}13`, `${c}11-${c}12`, ni, "money");

    const receivables = (revenue * inputs.n("B9")) / 365;
    cf.text("A3", "Net income").formula(`${c}3`, `IS!${c}13`, ni, "money");
    cf.text("A4", "Depreciation").formula(`${c}4`, `IS!${c}8`, dep, "money");
    const changeAr = receivables - bs.n(`${p}4`);
    cf.text("A5", "Increase in receivables").formula(
      `${c}5`,
      `BS!${c}4-BS!${p}4`,
      changeAr,
      "money",
    );
    cf.text("A6", "Cash from operations").formula(
      `${c}6`,
      `${c}3+${c}4-${c}5`,
      ni + dep - changeAr,
      "money",
    );
    cf.text("A7", "Capex").formula(`${c}7`, "-Inputs!$B$10", -inputs.n("B10"), "money");
    const repaid = Math.min(inputs.n("B11"), bs.n(`${p}7`));
    cf.text("A8", "Debt repaid").formula(`${c}8`, `-MIN(Inputs!$B$11,BS!${p}7)`, -repaid, "money");
    const net = ni + dep - changeAr - inputs.n("B10") - repaid;
    cf.text("A9", "Net change in cash").formula(`${c}9`, `SUM(${c}6:${c}8)`, net, "money");

    bs.formula(`${c}3`, `${p}3+CF!${c}9`, bs.n(`${p}3`) + net, "money");
    bs.formula(`${c}4`, `IS!${c}3*Inputs!$B$9/365`, receivables, "money");
    bs.formula(
      `${c}5`,
      `${p}5+Inputs!$B$10-IS!${c}8`,
      bs.n(`${p}5`) + inputs.n("B10") - dep,
      "money",
    );
    const assets = bs.n(`${c}3`) + bs.n(`${c}4`) + bs.n(`${c}5`);
    bs.formula(`${c}6`, `SUM(${c}3:${c}5)`, assets, "money");
    bs.formula(`${c}7`, `${p}7+CF!${c}8`, bs.n(`${p}7`) - repaid, "money");
    bs.formula(`${c}8`, `${p}8+IS!${c}13`, bs.n(`${p}8`) + ni, "money");
    const liabilities = bs.n(`${c}7`) + bs.n(`${c}8`);
    bs.formula(`${c}9`, `${c}7+${c}8`, liabilities, "money");
    bs.formula(`${c}10`, `ROUND(${c}6-${c}9,6)`, Math.round((assets - liabilities) * 1e6) / 1e6);
  }
  is.text("A15", "Average gross margin").formula(
    "B15",
    "SUMPRODUCT(C5:E5,1/C3:E3)/COUNT(C3:E3)",
    years.reduce((total, c) => total + is.n(`${c}5`) / is.n(`${c}3`), 0) / 3,
    "percent",
  );
  is.text("A16", "Revenue over 1,000").formula(
    "B16",
    'COUNTIF(C3:E3,">1000")',
    years.filter((c) => is.n(`${c}3`) > 1000).length,
  );
  is.text("A17", "Total revenue").formula(
    "B17",
    'SUMIF(C2:E2,">=2026",C3:E3)',
    is.n("D3") + is.n("E3"),
    "money",
  );
  return book;
}

/**
 * Formulas that can't be worked out here, each beside a figure that depends
 * on it: a volatile function, OFFSET and INDIRECT reading cells they find as
 * they run, a link to another workbook, a function IncarnaMind doesn't have
 * (a macro's, say), a circular reference, a data table, a formula saved with
 * no result, one whose saved result is out of date, and a hidden sheet.
 */
export function unsupportedWorkbook(): WorkbookBuilder {
  const book = new WorkbookBuilder();
  const s = book.sheet("Cases");
  s.text("A1", "Case").text("B1", "Input").text("C1", "Formula").text("D1", "Figure");
  s.text("A2", "Volatile")
    .number("B2", 10)
    .formula("C2", "B2*RAND()", 4.2)
    .formula("D2", "C2+1", 5.2);
  s.text("A3", "Today")
    .number("B3", 10)
    .formula("C3", "TODAY()-B3", 46000)
    .formula("D3", "C3*2", 92000);
  s.text("A4", "Offset")
    .number("B4", 2)
    .formula("C4", "OFFSET(B2,B4,0)", 2)
    .formula("D4", "C4*3", 6);
  s.text("A5", "Indirect")
    .number("B5", 3)
    .formula("C5", 'INDIRECT("B"&B5)', 10)
    .formula("D5", "C5+B5", 13);
  s.text("A6", "External")
    .number("B6", 1)
    .formula("C6", "[1]Prices!A1*B6", 99)
    .formula("D6", "C6*2", 198);
  s.text("A7", "Macro")
    .number("B7", 5)
    .formula("C7", "FORECASTGROWTH(B7)", 6)
    .formula("D7", "C7+B7", 11);
  s.text("A8", "Circular")
    .number("B8", 100)
    .formula("C8", "B8+D8*0.1", 110)
    .formula("D8", "C8*0.5", 55);
  s.text("A9", "No saved result")
    .number("B9", 7)
    .formula("C9", "B9*2", null)
    .formula("D9", "C9+1", 15);
  s.text("A10", "Out of date")
    .number("B10", 8)
    .formula("C10", "B10*3", 21)
    .formula("D10", "C10+1", 22);
  s.text("A11", "Hidden sheet")
    .number("B11", 2)
    .formula("C11", "Calc!A1*B11", 20)
    .formula("D11", "C11+1", 21);
  s.text("A12", "Static offset")
    .number("B12", 4)
    .formula("C12", "OFFSET(B12,0,0)*2", 8)
    .formula("D12", "C12+1", 9);
  s.text("A13", "Clean").number("B13", 6).formula("C13", "B13*2", 12).formula("D13", "C13+B13", 18);
  const hidden = book.sheet("Calc");
  hidden.number("A1", 10);
  hidden.state = "hidden";
  return book;
}

/** A workbook whose circular references Excel works out by iterating. */
export function iterativeWorkbook(): WorkbookBuilder {
  const book = new WorkbookBuilder();
  book.calc.iterate = true;
  const s = book.sheet("Interest");
  s.text("A1", "Cash").number("B1", 1000);
  s.text("A2", "Interest").formula("B2", "B3*0.05", 52.6315789473684);
  s.text("A3", "Average cash").formula("B3", "B1+B2", 1052.63157894737);
  return book;
}

/**
 * A monthly model of `products` products over `months` months: each one's
 * revenue grown each month by its own growth rate, and totals each month,
 * so `products × months + months` formulas.
 */
export function largeWorkbook(products = 100, months = 120): WorkbookBuilder {
  const book = new WorkbookBuilder();
  const drivers = book.sheet("Drivers");
  drivers.text("A1", "Product").text("B1", "Monthly growth").text("C1", "Starting revenue");
  for (let p = 0; p < products; p++) {
    drivers.text(`A${p + 2}`, `Product ${p + 1}`);
    drivers.number(`B${p + 2}`, 0.001 * ((p % 10) + 1), "percent");
    drivers.number(`C${p + 2}`, 100 + p, "money");
  }
  const model = book.sheet("Model");
  model.text("A1", "Product");
  for (let m = 0; m < months; m++) model.number(refOf(m + 1, 1), m + 1);
  const totals = new Array<number>(months).fill(0);
  for (let p = 0; p < products; p++) {
    const row = p + 2;
    model.text(`A${row}`, `Product ${p + 1}`);
    let value = drivers.n(`C${p + 2}`);
    const growth = drivers.n(`B${p + 2}`);
    model.formula(`B${row}`, `Drivers!C${p + 2}`, value, "money");
    totals[0] = (totals[0] ?? 0) + value;
    const values = [value];
    for (let m = 1; m < months; m++) {
      value *= 1 + growth;
      values.push(value);
      totals[m] = (totals[m] ?? 0) + value;
    }
    model.fill(
      `${refOf(2, row)}:${refOf(months, row)}`,
      `B${row}*(1+Drivers!$B$${p + 2})`,
      (offset) => values[offset + 1] as number,
      "money",
    );
  }
  const totalRow = products + 2;
  model.text(`A${totalRow}`, "Total revenue");
  model.fill(
    `B${totalRow}:${refOf(months, totalRow)}`,
    `SUM(B2:B${products + 1})`,
    (offset) => totals[offset] as number,
    "money",
  );
  return book;
}

/**
 * Blanks that count: SUMPRODUCT over ten cells of which two are filled, so
 * a comparison with B1 counts the eight blank ones too once B1 is above 0.
 */
export function blankCellsWorkbook(): WorkbookBuilder {
  const book = new WorkbookBuilder();
  book.sheet("S").number("A1", 1).number("A2", 9).number("B1", 0);
  book.sheet("F").formula("A1", "SUMPRODUCT(--(S!A1:A10<S!B1))", 0);
  return book;
}

/** A check that two sums are equal, which binary arithmetic leaves a hair apart (0.1 + 0.2). */
export function floatEqualityWorkbook(): WorkbookBuilder {
  const book = new WorkbookBuilder();
  book.sheet("Check").number("A1", 0.1).number("A2", 0.25).formula("B1", "IF(A1+A2=0.3,1,0)", 0);
  return book;
}

/**
 * A model as LibreOffice saved it once it had worked every formula out
 * (tests/fixtures/workbooks; eval/excel/whatIf.excel.ts makes them again and
 * checks they still match): the saved values tests compare with come from
 * LibreOffice, not from this file.
 */
export function libreOfficeFixture(name: "dcf" | "lbo" | "three-statements"): Uint8Array {
  return new Uint8Array(
    readFileSync(join(import.meta.dirname, "../fixtures/workbooks", `${name}.xlsx`)),
  );
}
