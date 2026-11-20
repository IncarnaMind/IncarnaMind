import {
  type Figure,
  type FigureContext,
  type FigureUnit,
  readFigures,
  readStatedUnits,
} from "../../../shared/figures";
import { cellsOf, isRule, linesOf, type Table, tableAt } from "./textTables";

const flat = (text: string) => text.replace(/\s+/gu, " ").trim();
const withoutBars = (text: string) => flat(text).replace(/^\|\s*|\s*\|$/gu, "");

const UNIT_OF_HEAD = /[(（]([^()（）]{1,12})[)）]$|([%％‰])$/u;

/** A share's unit and what one of it is worth ("‰" a thousandth), or a measure's unit. */
export interface ColumnHeadUnit {
  unit: FigureUnit;
  share: number | null;
}

/**
 * `words` read as one unit alone ("万吨", "kt", "‰"), as the figure "1 <words>" reads. Null where
 * they begin with a number of their own ("1000 t"), which a 1 before it would change.
 */
function unitAlone(words: string, context: FigureContext): Figure | null {
  if (/^\p{Nd}/u.test(words)) return null;
  const written = `1${/^[A-Za-z]/u.test(words) ? " " : ""}${words}`;
  const [said, ...more] = readFigures(written, { ...context, header: null, headerRead: null });
  return said && more.length === 0 && said.start === 0 && said.end === written.length ? said : null;
}

/** The heading cells of the column of `table`'s number, each with its line and where it is. */
const headings = (table: Table) =>
  table.lines.slice(table.head, table.top).flatMap((line, at) => {
    const cell = flat(cellsOf(line)[table.column] ?? "");
    return cell === "" ? [] : [{ cell, line, row: table.head + at }];
  });

// A heading row that doesn't line up with the row (a reader that drops a blank corner cell,
// a merged heading written once) can't say which heading is the number's, or whose another is.
const alignedHeadings = ({ lines, index, top, head }: Table): string[] =>
  lines
    .slice(head, top)
    .filter(
      (heading) =>
        !isRule(heading) && cellsOf(heading).length === cellsOf(lines[index] ?? "").length,
    );

/** A column headed 单位 or Unit holds each row's unit. */
const UNITS_HEADING = /^\s*(?:(?:计量|金额|货币|数量)?单位|units?)\s*$/iu;

/** The cell of `table`'s row in the column its headings name its units column; "" for none, or of two. */
function unitsCell(table: Table): string {
  const columns = new Set(
    alignedHeadings(table).flatMap((heading) =>
      cellsOf(heading).flatMap((cell, at) => (UNITS_HEADING.test(cell) ? [at] : [])),
    ),
  );
  const [only] = columns;
  if (columns.size !== 1 || only === undefined || only === table.column) return "";
  return cellsOf(table.lines[table.index] ?? "")[only] ?? "";
}

/** The unit a heading cell names at its end, in its one bracket or as a sign ("Levy (‰)", "YoY%"). */
function unitOfHead(cell: string, context: FigureContext): Figure | null {
  const [, bracketed, sign] = UNIT_OF_HEAD.exec(cell) ?? [];
  const piece = (bracketed ?? sign ?? "").trim();
  if (piece === "" || (cell.match(/[(（]/gu)?.length ?? 0) > 1) return null;
  return unitAlone(piece, context);
}

/**
 * The unit the heading of a number's own column names, where `quote` is that heading, its cell
 * or its whole row, and states no scale or currency as a unit line does: "Levy (‰)" over a 5,
 * "YoY%" over a 12, "Output (t)" over a 54,000 (#3022). Null where the number at `at` of `text` is
 * in no table's row, the quote heads another column, or its heading names no one unit.
 */
export function columnHeadUnit(
  text: string,
  at: number,
  quote: string,
  context: FigureContext,
): ColumnHeadUnit | null {
  if (readStatedUnits(quote, context, true).length > 0) return null;
  const table = tableAt(text, at);
  if (!table) return null;
  const asked = withoutBars(quote);
  const own = headings(table).find(
    ({ cell, line }) => asked === cell || asked === withoutBars(line),
  );
  const said = own ? unitOfHead(own.cell, context) : null;
  if (said?.scale !== 1) return null;
  if (said.unit.kind === "percent" || said.unit.kind === "points")
    return { unit: said.unit, share: said.value };
  return said.unit.kind === "other" ? { unit: said.unit, share: null } : null;
}

/**
 * Where the heading row of a number's own column runs in `text`, when `quote` is the heading cell
 * of that column: the row's other cells head other columns, so a scale one of them states is not
 * a nearer line for the number (#2997). Null where the number at `at` is in no table's row or the
 * quote is not its column's heading cell.
 */
export function ownHeadingRow(
  text: string,
  at: number,
  quote: string,
): { from: number; to: number } | null {
  const table = tableAt(text, at);
  if (!table) return null;
  const asked = withoutBars(quote);
  const own = headings(table).find(({ cell }) => asked === cell);
  if (!own) return null;
  const from = linesOf(text).starts[own.row] ?? 0;
  return { from, to: from + own.line.length };
}

/**
 * The unit the row of the number at `at` gives it in its table's units column ("万吨" under 单位),
 * read as one unit alone (#2997). Null where a heading of its own column states a unit, as
 * "比上年增长（%）" does beside such a column, where its row's cell there is no one unit for
 * certain (a "¥" the Document leaves open), or where `quoted`, the number's row as it is quoted,
 * leaves the cell out: a number quoted alone is asked for its row, so its Citation shows its unit
 * (#1798).
 */
export function unitsCellUnit(
  text: string,
  at: number,
  quoted: string,
  context: FigureContext,
): Figure | null {
  const table = tableAt(text, at);
  if (!table) return null;
  const cell = unitsCell(table).trim();
  if (cell === "" || !cellsOf(quoted).some((each) => each.trim() === cell)) return null;
  const headed = headings(table).some(
    (heading) =>
      readStatedUnits(heading.cell, context, true).length > 0 ||
      unitOfHead(heading.cell, context) !== null,
  );
  if (headed) return null;
  const said = unitAlone(cell, context);
  if (!said || said.ambiguous.length > 0) return null;
  return said.scaleWord !== null || said.unit.kind !== "plain" ? said : null;
}
