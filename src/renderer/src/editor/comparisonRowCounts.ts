/** What a comparison table's cells came to, for the title line's counts and the rows they show (#1837). */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { comparisonCellOf, comparisonCountOf } from "../../../shared/comparisons";
import type { RowProblem } from "../comparisonTableState";

export interface ProblemCounts {
  nothing: number;
  failed: number;
}

/** How many of a table's shown cells found nothing, and how many failed. */
export function problemCounts(node: ProseMirrorNode, hidden: ReadonlySet<string>): ProblemCounts {
  const counts: ProblemCounts = { nothing: 0, failed: 0 };
  node.forEach((row) => {
    const own = rowProblems(row, hidden);
    counts.nothing += own.nothing;
    counts.failed += own.failed;
  });
  return counts;
}

/** How many of one row's shown cells found nothing, and how many failed. */
export function rowProblems(row: ProseMirrorNode, hidden: ReadonlySet<string>): ProblemCounts {
  const counts: ProblemCounts = { nothing: 0, failed: 0 };
  row.forEach((cell) => {
    if (hidden.has(String(cell.attrs.questionId ?? ""))) return;
    const state = comparisonCellOf(cell.attrs);
    if (state.status !== "failed") return;
    const counted = comparisonCountOf(state.problem);
    if (counted) counts[counted]++;
  });
  return counts;
}

/** Whether a row shows with the counts the User clicked: it has a cell of each one. */
export function rowShows(
  row: ProseMirrorNode,
  hidden: ReadonlySet<string>,
  filters: ReadonlySet<RowProblem>,
): boolean {
  if (filters.size === 0) return true;
  const counts = rowProblems(row, hidden);
  return [...filters].every((problem) => counts[problem] > 0);
}

/** How many of a table's rows show with these counts clicked. */
export function shownRowCount(
  node: ProseMirrorNode,
  hidden: ReadonlySet<string>,
  filters: ReadonlySet<RowProblem>,
): number {
  let shown = 0;
  node.forEach((row) => {
    if (rowShows(row, hidden, filters)) shown++;
  });
  return shown;
}
