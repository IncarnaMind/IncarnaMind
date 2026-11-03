import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { comparisonLabelOf, comparisonQuestionsOf } from "../../../shared/comparisons";

interface InTable {
  table: ProseMirrorNode;
  questions: ReturnType<typeof comparisonQuestionsOf>;
}

function tableIn(editor: Editor, tableId: string): InTable | null {
  let found: InTable | null = null;
  editor.state.doc.forEach((block, offset) => {
    if (block.type.name !== "comparisonTable" || block.attrs.id !== tableId) return;
    const node = editor.state.doc.nodeAt(offset);
    if (node) found = { table: node, questions: comparisonQuestionsOf(node.attrs) };
  });
  return found;
}

export interface ColumnHere {
  /** Where it is among all the columns: the second column is 1. */
  index: number;
  label: string;
}

/** A column as the note has it now, for the core to change. */
export function comparisonColumnHere(
  editor: Editor,
  tableId: string,
  questionId: string,
): ColumnHere | null {
  const found = tableIn(editor, tableId);
  if (!found) return null;
  const index = found.questions.findIndex((question) => question.id === questionId);
  const question = found.questions[index];
  return question ? { index, label: comparisonLabelOf(question) } : null;
}

/** Where a column lands one shown column left or right, hidden ones passed over; null at the edge. */
export function comparisonColumnStep(
  editor: Editor,
  tableId: string,
  questionId: string,
  direction: -1 | 1,
): number | null {
  const found = tableIn(editor, tableId);
  if (!found) return null;
  const index = found.questions.findIndex((question) => question.id === questionId);
  if (index === -1) return null;
  for (let at = index + direction; at >= 0 && at < found.questions.length; at += direction) {
    if (found.questions[at]?.hidden !== true) return at;
  }
  return null;
}

/** The table's last column, which "+ Question" goes after; null when the table is gone. */
export function lastComparisonColumn(editor: Editor, tableId: string): string | null {
  const found = tableIn(editor, tableId);
  return found?.questions.at(-1)?.id ?? null;
}
