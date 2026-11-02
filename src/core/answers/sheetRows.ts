/**
 * The rows a sheet's file sets aside, marked where the model reads them (#1979). A row the file
 * strikes through or hides, often an earlier version of a row shown beside it, is an ordinary
 * line of cells in the text, and Claude Haiku 5.5 took such rows for current ones, guessing from
 * their order. Each such line of a Passage starts with its row and how the file sets it aside,
 * "[row 4, struck through]": on the line itself, since a Passage can start partway through a
 * Unit and its text numbers no rows. The marks are the Passage's, never a quote's.
 */
import type { UnitText } from "../../shared/units";

/** A mark this module puts at the start of a line, as the model reads it. */
export const SET_ASIDE_MARK = /\[row \d+(?:, (?:struck through|hidden))+\]/;

interface Row {
  line: string;
  row: number;
  marks: string[];
}

function rowsOf(units: readonly UnitText[]): Row[] {
  return units.flatMap((unit) => {
    const label = unit.label;
    if (unit.kind !== "rows" || !label?.rows) return [];
    const struck = new Set(label.struckRows ?? []);
    const hidden = new Set(label.hiddenRows ?? []);
    const lines = unit.text.split("\n");
    return label.rows.map((row, index) => ({
      line: lines[index] ?? "",
      row,
      marks: [
        ...(struck.has(row) ? ["struck through"] : []),
        ...(hidden.has(row) ? ["hidden"] : []),
      ],
    }));
  });
}

/**
 * Each line of a Passage's text with the row it is, or null: matched as a run, from the row the
 * most of its lines follow on from, since two rows can read the same.
 */
function placed(lines: readonly string[], rows: readonly Row[]): (Row | null)[] {
  const found: (Row | null)[] = lines.map(() => null);
  const first = lines.findIndex((line) => line !== "");
  if (first < 0) return found;
  const runFrom = (start: number) => {
    let row = start;
    let run = 0;
    for (let at = first; at < lines.length && row < rows.length; at++) {
      if (lines[at] === "") continue;
      if (rows[row]?.line !== lines[at]) break;
      run++;
      row++;
    }
    return run;
  };
  let start = -1;
  let longest = 0;
  rows.forEach((row, index) => {
    if (row.line !== lines[first]) return;
    const run = runFrom(index);
    if (run > longest) {
      start = index;
      longest = run;
    }
  });
  if (start < 0) return found;
  let next = start;
  for (let at = first; at < lines.length; at++) {
    if (lines[at] === "") continue;
    let match = next;
    while (match < rows.length && rows[match]?.line !== lines[at]) match++;
    if (match >= rows.length) continue;
    found[at] = rows[match] ?? null;
    next = match + 1;
  }
  return found;
}

/**
 * `shown`, a Passage's text as the model reads it, with each line of a row the file sets aside
 * marked: `text` is the Passage's own text, line for line, and `units` its Units.
 */
export function withSetAsideMarks(shown: string, text: string, units: readonly UnitText[]): string {
  const rows = rowsOf(units);
  if (!rows.some((row) => row.marks.length > 0)) return shown;
  const own = text.split("\n");
  const where = placed(own, rows);
  return shown
    .split("\n")
    .map((line, at) => {
      const row = where[at];
      if (!row || row.marks.length === 0) return line;
      const mark = `[row ${row.row}, ${row.marks.join(", ")}]`;
      const plain = own[at] ?? "";
      // A mark the Passage already gives at the line's start, such as its Unit's, stays first.
      if (plain !== "" && line.endsWith(plain) && line !== plain)
        return `${line.slice(0, line.length - plain.length)}${mark} ${plain}`;
      return `${mark} ${line}`;
    })
    .join("\n");
}
