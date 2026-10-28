/**
 * A comparison table's column width (#1833): how wide its heading and its
 * Answers read, so double-clicking a column's edge fits the column to them.
 */
import { MAX_COMPARISON_COLUMN_WIDTH, MIN_COMPARISON_COLUMN_WIDTH } from "../../shared/comparisons";

/** The width `element` needs to hold its content on one line, as the page draws it. */
function maxContentWidth(element: HTMLElement, remove: (clone: HTMLElement) => void): number {
  const clone = element.cloneNode(true) as HTMLElement;
  remove(clone);
  clone.style.cssText =
    "position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;width:max-content;max-width:none;display:block";
  document.body.append(clone);
  const width = clone.getBoundingClientRect().width;
  clone.remove();
  return width;
}

/** The width that fits `questionId`'s heading and every Answer under it, within a column's bounds. */
export function fittedColumnWidth(table: HTMLElement, questionId: string): number | null {
  const headings = Array.from(
    table.querySelectorAll<HTMLElement>(".comparison-head-row .comparison-question"),
  );
  const index = headings.findIndex((heading) => heading.dataset.questionId === questionId);
  const heading = headings[index];
  if (!heading) return null;
  let widest = maxContentWidth(heading, (clone) =>
    clone.querySelector(".comparison-question-menu")?.remove(),
  );
  for (const row of table.querySelectorAll<HTMLElement>(".comparison-row")) {
    // A hidden column keeps its cell in the row, unshown: measure only the cells the table draws.
    const cell = Array.from(row.querySelectorAll<HTMLElement>(".comparison-cell")).filter(
      (each) => each.getClientRects().length > 0,
    )[index];
    if (!cell) continue;
    widest = Math.max(
      widest,
      maxContentWidth(cell, (clone) => clone.querySelector(".comparison-cell-stale")?.remove()),
    );
  }
  return Math.min(
    MAX_COMPARISON_COLUMN_WIDTH,
    Math.max(MIN_COMPARISON_COLUMN_WIDTH, Math.ceil(widest)),
  );
}
