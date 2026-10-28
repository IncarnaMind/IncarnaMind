/**
 * A comparison table's column width (#1833): how wide its heading and its
 * Answers read, so double-clicking a column's edge fits the column to them.
 */
import { MAX_COMPARISON_COLUMN_WIDTH, MIN_COMPARISON_COLUMN_WIDTH } from "../../shared/comparisons";

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
  const heading = table.querySelector<HTMLElement>(
    `.comparison-head-row .comparison-question[data-question-id="${CSS.escape(questionId)}"]`,
  );
  if (!heading) return null;
  let widest = maxContentWidth(heading, (clone) =>
    clone.querySelector(".comparison-question-menu")?.remove(),
  );
  for (const row of table.querySelectorAll<HTMLElement>(".comparison-row")) {
    // A cell keeps the Question it belongs to, whatever order the table draws the columns in.
    const cell = row.querySelector<HTMLElement>(
      `.comparison-cell[data-question-id="${CSS.escape(questionId)}"]`,
    );
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
