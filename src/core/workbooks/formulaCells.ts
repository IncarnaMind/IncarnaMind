/**
 * The cells that take part in a workbook's formulas (#2372): those a formula works out, and those
 * one reads. A figure of such a cell is known only from the formulas, which a Passage never shows,
 * and a value supposed for one is a what-if, which only the workbook's own formulas work out.
 */
import type { UnitText } from "../../shared/units";
import { workbookModel } from "./model";
import { parseFormula } from "./parse";
import { placeKey, WorkbookEngine } from "./recalculate";

/** Whether a cell of one version of a workbook, by its sheet and ref ("B6"), takes part in its formulas. */
type PartOfFormulas = (sheet: string, ref: string) => boolean;

function partOfFormulas(
  documentId: string,
  contentHash: string,
  units: readonly UnitText[],
): PartOfFormulas | null {
  const model = workbookModel(documentId, contentHash, units);
  if (!model || model.formulaCount === 0) return null;
  const engine = new WorkbookEngine(model);
  const formulaKeys: number[] = [];
  for (const sheet of model.sheets)
    for (const cell of sheet.cells.values())
      if (cell.formula !== null) formulaKeys.push(placeKey(sheet, cell.row, cell.column));
  let reads: Map<string, { top: number; left: number; bottom: number; right: number }[]> | null =
    null;
  const readBlocks = () => {
    if (reads) return reads;
    const found = new Map<string, { top: number; left: number; bottom: number; right: number }[]>();
    for (const key of formulaKeys) {
      for (const read of engine.analysis(key).reads) {
        const sheet = read.sheet.toUpperCase();
        const list = found.get(sheet) ?? [];
        list.push(read.range);
        found.set(sheet, list);
      }
    }
    reads = found;
    return found;
  };
  return (sheetName, ref) => {
    const node = parseFormula(ref);
    const sheet = model.byName.get(sheetName.toUpperCase());
    if (node.kind !== "reference" || !sheet) return false;
    const { top: row, left: column } = node.range;
    if (engine.cellAt(placeKey(sheet, row, column))?.formula != null) return true;
    return (readBlocks().get(sheet.name.toUpperCase()) ?? []).some(
      (range) =>
        row >= range.top && row <= range.bottom && column >= range.left && column <= range.right,
    );
  };
}

/**
 * Which cells take part in each workbook's formulas, worked out once for each version the Answer
 * asks about: false for a cell of a Document that isn't a workbook with formulas kept.
 */
export function formulaCells(
  unitsOf: (documentId: string, contentHash: string) => readonly UnitText[],
): (documentId: string, contentHash: string, sheet: string, ref: string) => boolean {
  const known = new Map<string, PartOfFormulas | null>();
  return (documentId, contentHash, sheet, ref) => {
    const key = `${documentId}\n${contentHash}`;
    if (!known.has(key))
      known.set(key, partOfFormulas(documentId, contentHash, unitsOf(documentId, contentHash)));
    return known.get(key)?.(sheet, ref) ?? false;
  };
}

/**
 * The rows of a Passage's Units that hold a figure a formula works out, as the Passage's mark
 * gives them: "rows 4–12", or with each sheet's name when there are several; null for none.
 */
export function formulaRows(units: readonly UnitText[]): string | null {
  const bySheet = new Map<string, Set<number>>();
  for (const unit of units) {
    const label = unit.label;
    const formulas = label?.formulas;
    if (unit.kind !== "rows" || label?.sheet === undefined || !formulas) continue;
    const shown = new Set(label.rows ?? []);
    const rows = bySheet.get(label.sheet) ?? new Set<number>();
    for (const ref of Object.keys(formulas)) {
      const row = Number(/\d+$/.exec(ref)?.[0]);
      if (shown.has(row)) rows.add(row);
    }
    if (rows.size > 0) bySheet.set(label.sheet, rows);
  }
  const named = [...bySheet].map(([sheet, rows]) => ({ sheet, spans: spansOf([...rows]) }));
  if (named.length === 0) return null;
  if (named.length === 1) return `rows ${named[0]?.spans}`;
  return named.map(({ sheet, spans }) => `${sheet}, rows ${spans}`).join("; ");
}

/** Rows as runs: "4–7, 9, 11–12". */
function spansOf(rows: number[]): string {
  const sorted = rows.sort((a, b) => a - b);
  const spans: string[] = [];
  let start = sorted[0] as number;
  let end = start;
  for (const row of sorted.slice(1)) {
    if (row === end + 1) {
      end = row;
      continue;
    }
    spans.push(start === end ? `${start}` : `${start}–${end}`);
    start = row;
    end = row;
  }
  spans.push(start === end ? `${start}` : `${start}–${end}`);
  return spans.join(", ");
}
