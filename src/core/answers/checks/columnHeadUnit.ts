import {
  type FigureContext,
  type FigureUnit,
  readFigures,
  readStatedUnits,
} from "../../../shared/figures";
import { cellsOf, tableAt } from "./figureMeasures";

const flat = (text: string) => text.replace(/\s+/gu, " ").trim();
const withoutBars = (text: string) => flat(text).replace(/^\|\s*|\s*\|$/gu, "");

const UNIT_OF_HEAD = /[(（]([^()（）]{1,12})[)）]$|([%％‰])$/u;

/** A share's unit and what one of it is worth ("‰" a thousandth), or a measure's unit. */
export interface ColumnHeadUnit {
  unit: FigureUnit;
  share: number | null;
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
  for (let row = table.head; row < table.top; row++) {
    const line = table.lines[row] ?? "";
    const cell = flat(cellsOf(line)[table.column] ?? "");
    if (cell === "" || (asked !== cell && asked !== withoutBars(line))) continue;
    const [, bracketed, sign] = UNIT_OF_HEAD.exec(cell) ?? [];
    const piece = (bracketed ?? sign ?? "").trim();
    if (piece === "" || (cell.match(/[(（]/gu)?.length ?? 0) > 1) return null;
    const written = `1${/^[A-Za-z]/u.test(piece) ? " " : ""}${piece}`;
    const [said, ...more] = readFigures(written, { ...context, header: null, headerRead: null });
    if (!said || more.length > 0 || said.start !== 0 || said.end !== written.length) return null;
    if (said.scale !== 1) return null;
    if (said.unit.kind === "percent" || said.unit.kind === "points")
      return { unit: said.unit, share: said.value };
    return said.unit.kind === "other" ? { unit: said.unit, share: null } : null;
  }
  return null;
}
