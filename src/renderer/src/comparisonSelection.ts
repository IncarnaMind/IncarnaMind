import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { ComparisonCellRef } from "../../core/api";
import {
  type ComparisonProblemFilter,
  comparisonCellOf,
  comparisonQuestionsOf,
  comparisonRowMatchesFilter,
} from "../../shared/comparisons";
import type { ComparisonCellHandle } from "./comparisonCellHandle";
import { type RowProblem, useComparisonTables } from "./comparisonTableState";
import { comparisonTableIn } from "./editor/comparisonCommands";

export const comparisonCellFilters = (
  problems: ReadonlySet<RowProblem>,
): ComparisonProblemFilter[] =>
  [...problems].map((problem) => (problem === "nothing" ? "not-found" : "failed"));

const currentFilters = (tableId: string): ComparisonProblemFilter[] =>
  comparisonCellFilters(useComparisonTables.getState().filters.get(tableId) ?? new Set());

export function comparisonRowMatches(
  row: ProseMirrorNode,
  filters: readonly ComparisonProblemFilter[],
): boolean {
  const cells: ReturnType<typeof comparisonCellOf>[] = [];
  row.forEach((cell) => {
    cells.push(comparisonCellOf(cell.attrs));
  });
  return comparisonRowMatchesFilter(cells, filters);
}

export function comparisonCellsInTable(
  handle: Pick<ComparisonCellHandle, "editor" | "tableId">,
  includeHidden = false,
  filters: readonly ComparisonProblemFilter[] = [],
): ComparisonCellRef[] {
  const found = comparisonTableIn(handle.editor, handle.tableId);
  if (!found) return [];
  const questions = comparisonQuestionsOf(found.table.attrs).filter(
    (question) => includeHidden || !question.hidden,
  );
  const cells: ComparisonCellRef[] = [];
  found.table.forEach((row) => {
    if (!comparisonRowMatches(row, filters)) return;
    for (const question of questions) {
      cells.push({ documentId: String(row.attrs.documentId ?? ""), questionId: question.id });
    }
  });
  return cells;
}

export function comparisonCellsSelectable(
  handle: ComparisonCellHandle,
  filters: readonly ComparisonProblemFilter[] = currentFilters(handle.tableId),
): ComparisonCellRef[] {
  return comparisonCellsInTable(handle, false, filters);
}

export function comparisonCellFirst(
  handle: ComparisonCellHandle,
  filters?: readonly ComparisonProblemFilter[],
): ComparisonCellRef | null {
  return comparisonCellsSelectable(handle, filters)[0] ?? null;
}

export function comparisonCellAt(
  handle: ComparisonCellHandle,
  direction: "left" | "right" | "up" | "down",
): ComparisonCellRef | null {
  const cells = comparisonCellsSelectable(handle);
  const current = cells.findIndex(
    (cell) => cell.documentId === handle.documentId && cell.questionId === handle.questionId,
  );
  if (current < 0) return null;
  const columns = comparisonQuestionsOf(
    comparisonTableIn(handle.editor, handle.tableId)?.table.attrs ?? {},
  ).filter((question) => !question.hidden).length;
  if (columns === 0) return null;
  const column = current % columns;
  if (direction === "left" && column === 0) return null;
  if (direction === "right" && column === columns - 1) return null;
  const step =
    direction === "left" ? -1 : direction === "right" ? 1 : direction === "up" ? -columns : columns;
  return cells[current + step] ?? null;
}

export function comparisonCellNext(
  handle: ComparisonCellHandle,
  backward: boolean,
): ComparisonCellRef | null {
  const cells = comparisonCellsSelectable(handle);
  const current = cells.findIndex(
    (cell) => cell.documentId === handle.documentId && cell.questionId === handle.questionId,
  );
  return current < 0 ? null : (cells[current + (backward ? -1 : 1)] ?? null);
}

export function comparisonCellRange(
  handle: ComparisonCellHandle,
  anchor: ComparisonCellRef,
  current: ComparisonCellRef,
): ComparisonCellRef[] {
  const cells = comparisonCellsSelectable(handle);
  const indexOf = (target: ComparisonCellRef) =>
    cells.findIndex(
      (cell) => cell.documentId === target.documentId && cell.questionId === target.questionId,
    );
  const first = indexOf(anchor);
  const last = indexOf(current);
  if (first < 0 || last < 0) return [current];
  const columns = comparisonQuestionsOf(
    comparisonTableIn(handle.editor, handle.tableId)?.table.attrs ?? {},
  ).filter((question) => !question.hidden).length;
  if (columns === 0) return [];
  const rowFrom = Math.min(Math.floor(first / columns), Math.floor(last / columns));
  const rowTo = Math.max(Math.floor(first / columns), Math.floor(last / columns));
  const columnFrom = Math.min(first % columns, last % columns);
  const columnTo = Math.max(first % columns, last % columns);
  const selected: ComparisonCellRef[] = [];
  for (let row = rowFrom; row <= rowTo; row++) {
    for (let column = columnFrom; column <= columnTo; column++) {
      const cell = cells[row * columns + column];
      if (cell) selected.push(cell);
    }
  }
  return selected;
}

export function comparisonCellSelection(
  handle: ComparisonCellHandle,
  selected: readonly ComparisonCellRef[] | undefined,
  fallbackToCurrent = true,
): ComparisonCellRef[] {
  const current = { documentId: handle.documentId, questionId: handle.questionId };
  const visible = comparisonCellsSelectable(handle);
  if (
    !visible.some(
      (cell) => cell.documentId === current.documentId && cell.questionId === current.questionId,
    )
  ) {
    return [];
  }
  const chosen = selected?.filter((target) =>
    visible.some(
      (cell) => cell.documentId === target.documentId && cell.questionId === target.questionId,
    ),
  );
  return chosen?.some(
    (cell) => cell.documentId === current.documentId && cell.questionId === current.questionId,
  )
    ? chosen
    : fallbackToCurrent
      ? [current]
      : (chosen ?? []);
}
