import { holdsWords, type Sheet } from "../../../core/documents/formats/grid";
import { cellIndex } from "../../../core/documents/formats/sheetLayout";
import { fitName, textColumns } from "../../../shared/naming";
import { parseCellRef } from "../../../shared/units";

/** How wide a row's name may be on a Citation's mark, in columns, before it is cut (#2388). */
const NAME_COLUMNS = 24;

/** Text that fills a cell without naming anything: an Excel error, a boolean, or "n/a". */
const NOT_A_NAME = /^(#[A-Z0-9/]+[!?]?|TRUE|FALSE|N\/?A)$/i;

/** A cited row and its name, or null when it has none. */
export interface CitedRow {
  row: number;
  name: string | null;
}

/**
 * The rows a quote covers on `sheet`, in row order, each with its name: the
 * first text left of one of its cited figures, tried from the left, so an
 * account code stored as a number doesn't hide the name beside it. A merged
 * cell's text counts where the merge covers that place. Hidden columns, text
 * the cell's number format hides, and text that names nothing (a figure or a
 * year typed as text, "-", "n/a", an Excel error or a boolean) are passed over.
 */
export function citedRowNames(sheet: Sheet, cited: Iterable<string>): CitedRow[] {
  const cells = new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]));
  const merges = sheet.merges.flatMap((range) => {
    const [from, to] = range.split(":").map((ref) => parseCellRef(ref));
    return from && to ? [{ from, to }] : [];
  });
  const layout = sheet.layout;
  const cellAt = (row: number, column: number) => {
    const merge = merges.find(
      ({ from, to }) =>
        row >= from.row && row <= to.row && column >= from.column && column <= to.column,
    );
    return cells.get(merge ? `${merge.from.row}:${merge.from.column}` : `${row}:${column}`);
  };
  const nameAt = (row: number, column: number): string | null => {
    if (layout?.columns.get(column)?.hidden) return null;
    const cell = cellAt(row, column);
    if (!cell) return null;
    const at = cellIndex(cell.row, cell.column);
    if (layout?.centred.has(at)) return null;
    const text = (layout?.shown.get(at)?.text ?? cell.value).replace(/\s+/g, " ").trim();
    const named =
      holdsWords({ value: text, numeric: cell.numeric }) &&
      /\p{L}/u.test(text) &&
      !NOT_A_NAME.test(text);
    return named ? text : null;
  };
  const figures = new Map<number, Set<number>>();
  for (const ref of cited) {
    const at = parseCellRef(ref);
    if (!at) continue;
    const columns = figures.get(at.row) ?? new Set<number>();
    if (cellAt(at.row, at.column)?.numeric) columns.add(at.column);
    figures.set(at.row, columns);
  }
  return [...figures.entries()]
    .sort(([a], [b]) => a - b)
    .map(([row, columns]) => {
      for (const figure of [...columns].sort((a, b) => a - b)) {
        for (let column = figure - 1; column >= 0; column--) {
          const name = nameAt(row, column);
          if (name) return { row, name };
        }
      }
      return { row, name: null };
    });
}

/** A row's name as its mark shows it: cut at the end, with "…", past about 24 columns. */
export const shortRowName = (name: string): string =>
  fitName(name, (text) => textColumns(text) <= NAME_COLUMNS, !/\p{Script=Han}/u.test(name));
