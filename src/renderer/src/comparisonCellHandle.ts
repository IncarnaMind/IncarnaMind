import type { ComparisonHandle } from "./comparisonColumnState";

export interface ComparisonCellTarget extends ComparisonHandle {
  documentId: string;
  questionId: string;
}

export interface ComparisonCellHandle extends ComparisonCellTarget {
  anchor: HTMLElement;
}

export const comparisonCellKey = (tableId: string, documentId: string, questionId: string) =>
  `${tableId}:${documentId}:${questionId}`;

export const comparisonCellHandles = new Map<string, ComparisonCellHandle>();

export const comparisonCellRef = (handle: ComparisonCellHandle) => ({
  tableId: handle.tableId,
  documentId: handle.documentId,
  questionId: handle.questionId,
});
