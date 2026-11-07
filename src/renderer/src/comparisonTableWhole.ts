/**
 * The whole-table actions of a comparison table (#1839): a copy below it, the table taken out
 * with Undo, and the table turned into a plain one that keeps its words and Citations. Each is
 * one change of the note, so its Undo is the note's own.
 */
import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  cellProblemMessage,
  comparisonCellOf,
  comparisonLabelOf,
  comparisonQuestionsOf,
  comparisonTitleOf,
} from "../../shared/comparisons";
import type { ComparisonTableHandle } from "./comparisonStructure";
import { expandComparisonTable } from "./comparisons";
import { comparisonTableIn } from "./editor/comparisonCommands";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { translateNow } from "./i18n";

const nameOf = (table: ProseMirrorNode): string =>
  comparisonTitleOf(table.attrs) || translateNow("comparison.title");

const childOf = (editor: Editor, name: "paragraph" | "tableCell" | "tableHeader") => {
  const node = editor.state.schema.nodes[name];
  if (!node) throw new Error(`The note has no ${name} type.`);
  return node;
};

function textBlockOf(editor: Editor, text: string): ProseMirrorNode {
  const paragraph = childOf(editor, "paragraph");
  return paragraph.create(null, text ? editor.state.schema.text(text) : null);
}

function headerCellOf(editor: Editor, text: string): ProseMirrorNode {
  return childOf(editor, "tableHeader").create(null, textBlockOf(editor, text));
}

function bodyCellOf(editor: Editor, content: ProseMirrorNode | string): ProseMirrorNode {
  const tableCell = childOf(editor, "tableCell");
  return tableCell.create(
    null,
    typeof content === "string" ? textBlockOf(editor, content) : content,
  );
}

/** A comparison cell's blocks that a plain table holds; an empty one keeps the reason it is empty. */
function plainCellOf(editor: Editor, cell: ProseMirrorNode | null): ProseMirrorNode {
  const tableCell = childOf(editor, "tableCell");
  const state = cell ? comparisonCellOf(cell.attrs) : null;
  const problem = state?.problem ? cellProblemMessage(state.problem, state.message) : null;
  if (problem && (cell?.textContent ?? "").trim() === "") {
    return tableCell.create(null, textBlockOf(editor, translateNow(problem.key, problem.params)));
  }
  const blocks: ProseMirrorNode[] = [];
  cell?.forEach((child) => {
    if (tableCell.contentMatch.matchType(child.type)) blocks.push(child);
  });
  if (blocks.length > 0) return tableCell.create(null, Fragment.from(blocks));
  return tableCell.create(null, textBlockOf(editor, ""));
}

function plainTableOf(editor: Editor, table: ProseMirrorNode): ProseMirrorNode | null {
  const { table: tableType, tableRow } = editor.state.schema.nodes;
  if (!tableType || !tableRow) return null;
  const questions = comparisonQuestionsOf(table.attrs).filter(
    (question) => question.hidden !== true,
  );
  const rows: ProseMirrorNode[] = [
    tableRow.create(null, [
      headerCellOf(editor, translateNow("comparison.document")),
      ...questions.map((question) => headerCellOf(editor, comparisonLabelOf(question))),
    ]),
  ];
  table.forEach((row) => {
    const cells: ProseMirrorNode[] = [bodyCellOf(editor, String(row.attrs.documentName ?? ""))];
    for (const question of questions) {
      let found: ProseMirrorNode | null = null;
      for (let at = 0; at < row.childCount && !found; at++) {
        const cell = row.child(at);
        if (cell.attrs.questionId === question.id) found = cell;
      }
      cells.push(plainCellOf(editor, found));
    }
    rows.push(tableRow.create(null, cells));
  });
  return tableType.create(null, rows);
}

/** A copy of the table below it, titled "(copy)", with the words and Citations it has now. */
export function duplicateComparisonTable(handle: ComparisonTableHandle): void {
  const { editor, tableId } = handle;
  if (!editor.isEditable) return;
  const found = comparisonTableIn(editor, tableId);
  if (!found) return;
  const source = found.table;
  const name = nameOf(source);
  const ids = new Map<string, string>();
  const questions = comparisonQuestionsOf(source.attrs).map((question) => {
    const id = crypto.randomUUID();
    ids.set(question.id, id);
    return { ...question, id };
  });
  const rows: ProseMirrorNode[] = [];
  source.forEach((row) => {
    const cells: ProseMirrorNode[] = [];
    row.forEach((cell) => {
      const { status } = comparisonCellOf(cell.attrs);
      cells.push(
        cell.type.create(
          {
            ...cell.attrs,
            questionId: ids.get(String(cell.attrs.questionId ?? "")) ?? cell.attrs.questionId,
            status: status === "writing" ? "waiting" : status,
            fillId: null,
          },
          cell.content,
        ),
      );
    });
    rows.push(row.type.create(row.attrs, cells));
  });
  const copy = source.type.create(
    {
      ...source.attrs,
      id: crypto.randomUUID(),
      title: translateNow("comparison.table.copyName", { name }),
      questions,
      proposal: null,
    },
    rows,
  );
  asOneStep(editor, () => {
    editor.view.dispatch(editor.state.tr.insert(found.pos + source.nodeSize, copy));
  });
  offerEditorUndo(editor, (t) => t("comparison.table.duplicated", { name }));
}

/** The table taken out of the note whole; Undo puts it back with its Answers as they were. */
export function removeComparisonTable(handle: ComparisonTableHandle): void {
  const { editor, tableId } = handle;
  if (!editor.isEditable) return;
  const found = comparisonTableIn(editor, tableId);
  if (!found) return;
  const name = nameOf(found.table);
  asOneStep(editor, () => {
    editor.view.dispatch(editor.state.tr.delete(found.pos, found.pos + found.table.nodeSize));
  });
  expandComparisonTable(null);
  offerEditorUndo(editor, (t) => t("comparison.table.deleted", { name }));
}

/** The table written as a plain one: its words and Citations stay, its Questions and fills go. */
export function plainComparisonTable(handle: ComparisonTableHandle): void {
  const { editor, tableId } = handle;
  if (!editor.isEditable) return;
  const found = comparisonTableIn(editor, tableId);
  if (!found) return;
  const plain = plainTableOf(editor, found.table);
  if (!plain) return;
  const name = nameOf(found.table);
  asOneStep(editor, () => {
    editor.view.dispatch(
      editor.state.tr.replaceWith(found.pos, found.pos + found.table.nodeSize, plain),
    );
  });
  expandComparisonTable(null);
  offerEditorUndo(editor, (t) => t("comparison.table.turnedPlain", { name }));
}
