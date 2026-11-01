import type { Sheet } from "../../../core/documents/formats/grid";
import { fitName, textColumns } from "../../../shared/naming";
import { parseCellRef } from "../../../shared/units";

/** How wide a row's name may be on a Citation's mark, in columns, before it is cut (#2388). */
const NAME_COLUMNS = 24;

/**
 * The names of the rows a quote covers, in row order: for each cited row with a
 * figure among its cited cells, its first text cell left of those figures (a
 * merged cell's text where the merge covers that place). A row with no figure
 * cited, or no text left of its figures, has none.
 */
export function citedRowNames(sheet: Sheet, cited: Iterable<string>): string[] {
  const cells = new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]));
  const merges = sheet.merges.flatMap((range) => {
    const [from, to] = range.split(":").map((ref) => parseCellRef(ref));
    return from && to ? [{ from, to }] : [];
  });
  const cellAt = (row: number, column: number) => {
    const merge = merges.find(
      ({ from, to }) =>
        row >= from.row && row <= to.row && column >= from.column && column <= to.column,
    );
    return cells.get(merge ? `${merge.from.row}:${merge.from.column}` : `${row}:${column}`);
  };
  const figures = new Map<number, number>();
  for (const ref of cited) {
    const at = parseCellRef(ref);
    if (!at || !cellAt(at.row, at.column)?.numeric) continue;
    figures.set(at.row, Math.min(figures.get(at.row) ?? at.column, at.column));
  }
  return [...figures.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([row, first]) => {
      for (let column = first - 1; column >= 0; column--) {
        const cell = cellAt(row, column);
        const text = cell && !cell.numeric ? cell.value.trim() : "";
        if (text) return [text];
      }
      return [];
    });
}

/** A row's name as its mark shows it: cut at the end, with "…", past about 24 columns. */
export const shortRowName = (name: string): string =>
  fitName(name, (text) => textColumns(text) <= NAME_COLUMNS, !/\p{Script=Han}/u.test(name));
