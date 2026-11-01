import type { Sheet } from "../../../core/documents/formats/grid";
import { cellIndex } from "../../../core/documents/formats/sheetLayout";
import { fitName, textColumns } from "../../../shared/naming";
import { parseCellRef } from "../../../shared/units";
import { joinMeta } from "../cost";

/** How wide a row's name may be on a Citation's mark, in columns, before it is cut (#2388). */
const NAME_COLUMNS = 24;

/** Text with a letter that still names nothing: an Excel error, a boolean, or "n/a", "nil", "n/m". */
const NOT_A_NAME = /^(#[A-Z0-9/_]+[!?]?|TRUE|FALSE|N\/?A|N\.A\.?|NIL|N\/?M)$/i;

const lettersIn = (text: string): number => text.match(/\p{L}/gu)?.length ?? 0;

/** The cells a quote was found in, keyed "Sheet!B8", and the sheet it opens on. */
export interface FoundCells {
  sheet: string;
  cells: ReadonlySet<string>;
}

/** The references ("B8") of the found cells on the sheet they open on; a quote can span sheets. */
export const cellsOn = (found: FoundCells): string[] =>
  [...found.cells].flatMap((key) =>
    key.startsWith(`${found.sheet}!`) ? [key.slice(found.sheet.length + 1)] : [],
  );

/** A cited row and its name, or null when it has none. */
export interface CitedRow {
  row: number;
  name: string | null;
}

/**
 * The rows a quote covers on `sheet`, in row order, each with its name: of
 * the text left of its cited figures, the cell with the most letters (the
 * leftmost of equals), so an account code, a note reference or a currency
 * beside the name ("AR01", "Note 12", "USD") never stands in for it. A figure
 * stored as text counts as a figure. A merged cell's text counts where the
 * merge covers that place. Hidden columns, text the cell's number format
 * hides, and text that names nothing (no letter, as a figure or year typed as
 * text, "-", or else "n/a", an Excel error or a boolean) are passed over.
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
  const textAt = (row: number, column: number): { text: string; figure: boolean } | null => {
    const cell = cellAt(row, column);
    if (!cell) return null;
    const shown = layout?.shown.get(cellIndex(cell.row, cell.column))?.text ?? cell.value;
    const text = shown.replace(/\s+/g, " ").trim();
    return { text, figure: cell.numeric || (/\d/.test(text) && lettersIn(text) === 0) };
  };
  const nameAt = (row: number, column: number): string | null => {
    if (layout?.columns.get(column)?.hidden) return null;
    const found = textAt(row, column);
    if (!found || found.figure || lettersIn(found.text) === 0 || NOT_A_NAME.test(found.text)) {
      return null;
    }
    return found.text;
  };
  const figures = new Map<number, number>();
  const rows = new Set<number>();
  for (const ref of cited) {
    const at = parseCellRef(ref);
    if (!at) continue;
    rows.add(at.row);
    if (!textAt(at.row, at.column)?.figure) continue;
    figures.set(at.row, Math.max(figures.get(at.row) ?? at.column, at.column));
  }
  return [...rows]
    .sort((a, b) => a - b)
    .map((row) => {
      let best: string | null = null;
      for (let column = 0; column < (figures.get(row) ?? 0); column++) {
        const name = nameAt(row, column);
        if (name && lettersIn(name) > (best === null ? 0 : lettersIn(best))) best = name;
      }
      return { row, name: best };
    });
}

/** A row's name as its mark shows it: cut at the end, with "…", past about 24 columns. */
export const shortRowName = (name: string): string =>
  fitName(name, (text) => textColumns(text) <= NAME_COLUMNS, !/\p{Script=Han}/u.test(name));

/**
 * A sheet Citation's mark with its rows' names (#2388): a one-row quote shows
 * its row's name in place of the label; several rows keep their range on the
 * mark. The tooltip's label adds the names, joined by `separator`, only when
 * every cited row has one, so no name is read against the wrong row.
 */
export function withRowNames<Mark extends { label?: string; shown?: string }>(
  mark: Mark | null,
  sheet: Sheet | undefined,
  found: FoundCells | null,
  separator: string,
): Mark | null {
  if (!mark || !sheet || !found) return mark;
  const rows = citedRowNames(sheet, cellsOn(found));
  const names = rows.flatMap((each) => (each.name ? [each.name] : []));
  if (names.length === 0 || names.length < rows.length) return mark;
  const shown = rows.length === 1 && names[0] ? shortRowName(names[0]) : mark.label;
  if (!shown) return mark;
  return { ...mark, label: joinMeta([mark.label ?? "", names.join(separator)]), shown };
}
