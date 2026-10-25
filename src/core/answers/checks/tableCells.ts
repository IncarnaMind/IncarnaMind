/**
 * A sentence in a table's cell, read as a User reads the table (#1459): said with its row's label
 * and its column's heading, beside the line before the table, its headings and its row, for what
 * its words refer to, such as their unit or period. The row's other values are left out: shown
 * them, Claude Haiku 5.5 called a right cell Contradicted for a wrong one beside it. Every check of
 * a Mind's own sentences reads a cell this way; Verify reads a PDF's tables by the row
 * (./verifyTables).
 */
import { comparableSentence } from "../../../shared/sentences";

/** A table as checks read it: each row's cells, whether its first row is headings, and the line before it. */
export interface TableText {
  rows: readonly (readonly string[])[];
  headed: boolean;
  before: string;
}

const line = (cells: readonly string[]) => cells.map(comparableSentence).join(" | ");

/** What a check sends for a sentence of the cell at `row`, `column`: the claim, and what the table says of it. */
export function readCell(
  table: TableText,
  row: number,
  column: number,
  sentence: string,
): { claim: string; table: string } {
  const cells = table.rows[row] ?? [];
  const inHeadings = table.headed && row === 0;
  const headings = table.headed && !inHeadings ? (table.rows[0] ?? []) : [];
  const label = column > 0 && !inHeadings ? comparableSentence(cells[0] ?? "") : "";
  const heading = comparableSentence(headings[column] ?? "");
  return {
    claim: `${label ? `${label} — ` : ""}${heading ? `${heading}: ` : ""}${sentence}`,
    table: [
      comparableSentence(table.before),
      line(headings),
      line(cells.map((each, at) => (at === 0 || at === column ? each : "…"))),
    ]
      .filter((each) => each !== "")
      .join("\n"),
  };
}
