import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { COMPARISON_ROW_NODE } from "../../../core/api";
import { comparisonTableAt } from "./comparisonCommands";

export interface RowHere {
  /** Where it is among all the rows: the second row is 1. */
  index: number;
  label: string;
  documentId: string;
}

function tableIn(editor: Editor, tableId: string): ProseMirrorNode | null {
  const pos = comparisonTableAt(editor, tableId);
  return pos === null ? null : editor.state.doc.nodeAt(pos);
}

/** A row as the note has it now, for the core to change. */
export function comparisonRowHere(
  editor: Editor,
  tableId: string,
  documentId: string,
): RowHere | null {
  const table = tableIn(editor, tableId);
  let found: RowHere | null = null;
  let index = 0;
  table?.forEach((row) => {
    if (row.type.name !== COMPARISON_ROW_NODE) return;
    if (String(row.attrs.documentId ?? "") === documentId) {
      found = {
        index,
        label: String(row.attrs.documentName ?? ""),
        documentId,
      };
    }
    index++;
  });
  return found;
}

export function comparisonRowCount(editor: Editor, tableId: string): number {
  let count = 0;
  tableIn(editor, tableId)?.forEach((row) => {
    if (row.type.name === COMPARISON_ROW_NODE) count++;
  });
  return count;
}

/** Where a row moves one place up or down; null at the edge. */
export function comparisonRowStep(
  editor: Editor,
  tableId: string,
  documentId: string,
  direction: -1 | 1,
): number | null {
  const here = comparisonRowHere(editor, tableId, documentId);
  if (!here) return null;
  const to = here.index + direction;
  const rows = comparisonRowCount(editor, tableId);
  return to >= 0 && to < rows ? to : null;
}

export function comparisonRowDocuments(editor: Editor, tableId: string): string[] {
  const documents: string[] = [];
  tableIn(editor, tableId)?.forEach((row) => {
    if (row.type.name === COMPARISON_ROW_NODE) {
      documents.push(String(row.attrs.documentId ?? ""));
    }
  });
  return documents;
}
