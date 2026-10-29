import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { COMPARISON_CELL_NODE, COMPARISON_TABLE_NODE } from "../../../core/api";

/** Where a comparison table is in the editor, by its id; null when it isn't there. */
export function comparisonTableAt(editor: Editor, tableId: string): number | null {
  let found: number | null = null;
  editor.state.doc.forEach((block, offset) => {
    if (block.type.name === COMPARISON_TABLE_NODE && block.attrs.id === tableId) found = offset;
  });
  return found;
}

export interface ComparisonTableLocation {
  pos: number;
  table: ProseMirrorNode;
  /** Where each row starts, in the document. */
  rows: number[];
}

export function comparisonTableIn(editor: Editor, tableId: string): ComparisonTableLocation | null {
  const pos = comparisonTableAt(editor, tableId);
  const table = pos === null ? null : editor.state.doc.nodeAt(pos);
  if (pos === null || !table) return null;
  const rows: number[] = [];
  table.forEach((_row, offset) => {
    rows.push(pos + 1 + offset);
  });
  return { pos, table, rows };
}

export function comparisonCellInRow(
  row: ProseMirrorNode,
  questionId: string,
): { index: number; offset: number } | null {
  let offset = 0;
  for (let index = 0; index < row.childCount; index++) {
    const child = row.child(index);
    if (child.attrs.questionId === questionId) return { index, offset };
    offset += child.nodeSize;
  }
  return null;
}

export function comparisonCellNode(editor: Editor, questionId: string, fillId?: string) {
  const { schema } = editor.state;
  return schema.nodes[COMPARISON_CELL_NODE]?.create(
    { questionId, status: "waiting", ...(fillId && { fillId }) },
    schema.nodes.paragraph?.create(),
  );
}
