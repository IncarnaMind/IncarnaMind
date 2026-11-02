/**
 * The numbers a column's cells write as text (#2444), read by the way the column itself writes
 * them rather than cell by cell, so an Analysis's code and IncarnaMind's own arithmetic read
 * the same cells as the same numbers. A cell whose text the column leaves open stays text: a
 * figure that would skip it is not worked out again, rather than agreeing on a wrong total.
 *
 * - Decimals: "1,234.5" writes them with a point, "1.234,5" and "12,5" with a comma. A column
 *   that writes both reads neither, and "1,234" or "1.234" only as the column's other cells
 *   say; with nothing to say otherwise, the point, as before.
 * - Negatives: "-5", "−5" and "负5"; "(5)" only where two cells or more of the column write
 *   one so and none writes a minus.
 * - Currency: one symbol for the column ("$1,200"); two different ones read neither.
 * - Percent: "8%" is 0.08 only where every number in the column is written with "%".
 * - Full-width characters ("１，２００", "（５）") read as their plain forms. A unit or a word
 *   ("1.2万", "5k", "n/a", "-"), a sign after the number ("5-"), a raised mark ("1,234²"), a
 *   date or TRUE is no number.
 */
import type { AnalysisCell } from "../../shared/analysis";

interface Written {
  /** Its value with "." for decimals and "," between thousands, or null when it can't be. */
  point: number | null;
  /** Its value with "," for decimals and "." between thousands, or null when it can't be. */
  comma: number | null;
  negative: "minus" | "parentheses" | null;
  currency: string | null;
  percent: boolean;
}

const PARTS =
  /^(\()?([-+])?(\p{Sc})?([-+])?(\d[\d.,]*|\.\d+)([eE][-+]?\d+)?(%)?\s?(\p{Sc})?(\))?$/u;
const POINT = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?$|^\.\d+$/;
const COMMA = /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/;

/** Superscript and subscript characters, which NFKC folds into plain digits: "1,234²" isn't 1,2342. */
const RAISED = /[\u00b2\u00b3\u00b9\u2070-\u209f]/u;

function written(text: string): Written | null {
  if (RAISED.test(text)) return null;
  const plain = text
    .normalize("NFKC")
    .trim()
    .replace(/^[\u2212负]/u, "-");
  const parts = PARTS.exec(plain);
  if (!parts) return null;
  const [, open, sign, before, signAfter, body = "", exponent, percent, after, close] = parts;
  if (Boolean(open) !== Boolean(close) || (sign && signAfter) || (before && after)) return null;
  if (open && (sign || signAfter)) return null;
  const minus = sign === "-" || signAfter === "-";
  let point = POINT.test(body) ? Number(body.replaceAll(",", "")) : null;
  let comma = COMMA.test(body) ? Number(body.replaceAll(".", "").replace(",", ".")) : null;
  if (exponent) {
    if (body.includes(",")) return null;
    point = point === null ? null : Number(`${body}${exponent}`);
    comma = /^\d+$/.test(body) ? point : null;
  }
  if (point === null && comma === null) return null;
  return {
    point,
    comma,
    negative: open ? "parentheses" : minus ? "minus" : null,
    currency: before ?? after ?? null,
    percent: percent !== undefined,
  };
}

function readColumn(cells: readonly AnalysisCell[]): AnalysisCell[] {
  const read = cells.map((cell) => (typeof cell === "string" ? written(cell) : null));
  const numbers = read.filter((each): each is Written => each !== null);
  if (numbers.length === 0) return [...cells];
  const pointOnly = numbers.some((each) => each.comma === null);
  const commaOnly = numbers.some((each) => each.point === null);
  const numberOf = (each: Written): number | null => {
    if (pointOnly && commaOnly) return each.point === each.comma ? each.point : null;
    return commaOnly ? each.comma : each.point;
  };
  const parentheses =
    numbers.filter((each) => each.negative === "parentheses").length >= 2 &&
    !numbers.some((each) => each.negative === "minus");
  const percent =
    numbers.every((each) => each.percent) && !cells.some((cell) => typeof cell === "number");
  const currencies = new Set(numbers.flatMap((each) => (each.currency ? [each.currency] : [])));
  return cells.map((cell, index) => {
    const each = read[index];
    if (!each) return cell;
    const value = numberOf(each);
    if (value === null || !Number.isFinite(value) || (each.percent && !percent)) return cell;
    if (each.negative === "parentheses" && !parentheses) return cell;
    if (each.currency && currencies.size > 1) return cell;
    const signed = each.negative ? -value : value;
    return each.percent ? signed / 100 : signed;
  });
}

/** `rows` with each column's text cells that write a number read as that number. */
export function readNumbers(rows: readonly (readonly AnalysisCell[])[]): AnalysisCell[][] {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const columns = Array.from({ length: width }, (_, column) =>
    readColumn(rows.map((row) => row[column] ?? null)),
  );
  return rows.map((row, at) => row.map((_, column) => columns[column]?.[at] ?? null));
}
