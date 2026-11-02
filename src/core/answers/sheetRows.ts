/**
 * What a sheet's rows say beyond their cells' text, as a Passage's marks give it (#1979): the
 * rows the file strikes through or hides, and the rows that give one item different figures.
 * Read from the cells' text alone, a struck-through or hidden row looked current, and two
 * versions of an item were added up as one.
 */
import type { UnitText } from "../../shared/units";
import { readsAsNumber } from "../documents/formats/grid";

/** The most groups of rows one mark names, and rows of a group, before it says how many more. */
const MAX_GROUPS = 6;
const MAX_GROUP_ROWS = 6;

/** Rows as runs: "4–7, 9, 11–12". */
function spansOf(rows: readonly number[]): string {
  const sorted = [...rows].sort((a, b) => a - b);
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

/** Rows by sheet as a Passage's mark gives them: "rows 4–12", or with each sheet's name when there are several. */
export function rowsMark(bySheet: ReadonlyMap<string, ReadonlySet<number>>): string | null {
  const named = [...bySheet]
    .filter(([, rows]) => rows.size > 0)
    .map(([sheet, rows]) => ({ sheet, spans: spansOf([...rows]) }));
  if (named.length === 0) return null;
  if (named.length === 1) return `rows ${named[0]?.spans}`;
  return named.map(({ sheet, spans }) => `${sheet}, rows ${spans}`).join("; ");
}

/** The rows of a Passage's Units the file strikes through, or hides; null for none. */
export function markedRows(
  units: readonly UnitText[],
  mark: "struckRows" | "hiddenRows",
): string | null {
  const bySheet = new Map<string, Set<number>>();
  for (const unit of units) {
    const rows = unit.kind === "rows" ? unit.label?.[mark] : undefined;
    if (!rows?.length) continue;
    const sheet = unit.label?.sheet ?? "";
    const marked = bySheet.get(sheet) ?? new Set<number>();
    for (const row of rows) marked.add(row);
    bySheet.set(sheet, marked);
  }
  return rowsMark(bySheet);
}

/** A row as its Unit shows it: the words of its cells and its numbers, each with its column. */
interface ShownRow {
  row: number;
  words: string;
  numbers: string;
}

function shownRows(unit: UnitText): ShownRow[] {
  const label = unit.label;
  if (unit.kind !== "rows" || !label?.rows) return [];
  const lines = unit.text.split("\n");
  return label.rows.flatMap((row, index): ShownRow[] => {
    if (index === 0 && label.header) return [];
    const words: string[] = [];
    const numbers: string[] = [];
    (lines[index] ?? "").split("\t").forEach((cell, column) => {
      const value = cell.trim();
      if (value !== "") (readsAsNumber(value) ? numbers : words).push(`${column}\t${value}`);
    });
    if (words.length === 0 || numbers.length === 0) return [];
    return [{ row, words: words.join("\n"), numbers: numbers.join("\n") }];
  });
}

const listed = (rows: readonly number[]): string => {
  const shown = rows.slice(0, MAX_GROUP_ROWS);
  const more = rows.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length === 1
    ? `${shown[0]}`
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
};

/**
 * For each Passage, the rows that give one item different figures, as its mark gives them:
 * "rows 2 and 4; rows 3 and 5"; null for none. An item is a row's words, each in its column,
 * so a status, revision or date in a cell of its own tells two rows apart. Rows are matched
 * across all the Passages of one version of a sheet, since the rows of two versions of a
 * table can be in two Passages.
 */
export function repeatedRows(
  passages: readonly { version: string; units: readonly UnitText[] }[],
): (string | null)[] {
  const sheets = new Map<string, Map<number, ShownRow>>();
  const own = passages.map(({ version, units }) => {
    const rows = new Map<string, Set<number>>();
    for (const unit of units) {
      const key = `${version}\n${unit.label?.sheet ?? ""}`;
      const sheet = sheets.get(key) ?? new Map<number, ShownRow>();
      const shown = rows.get(key) ?? new Set<number>();
      for (const each of shownRows(unit)) {
        sheet.set(each.row, each);
        shown.add(each.row);
      }
      sheets.set(key, sheet);
      rows.set(key, shown);
    }
    return rows;
  });
  const groups = new Map<string, number[][]>();
  for (const [key, rows] of sheets) {
    const byWords = new Map<string, ShownRow[]>();
    for (const each of rows.values())
      byWords.set(each.words, [...(byWords.get(each.words) ?? []), each]);
    groups.set(
      key,
      [...byWords.values()]
        .filter((same) => new Set(same.map((each) => each.numbers)).size > 1)
        .map((same) => same.map((each) => each.row).sort((a, b) => a - b))
        .sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
  }
  return own.map((rows) => {
    const named = [...rows].flatMap(([key, shown]) =>
      (groups.get(key) ?? []).filter((group) => group.some((row) => shown.has(row))),
    );
    if (named.length === 0) return null;
    const marks = named.slice(0, MAX_GROUPS).map((group) => `rows ${listed(group)}`);
    const more = named.length - MAX_GROUPS;
    return `${marks.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
  });
}
