import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  COMPARISON_CELL_NODE,
  COMPARISON_ROW_NODE,
  COMPARISON_TABLE_NODE,
} from "../../../core/api";
import {
  cellToFill,
  comparisonCellOf,
  comparisonLabelOf,
  comparisonQuestionsOf,
  MAX_COMPARISON_COLUMN_WIDTH,
  MAX_COMPARISON_LABEL,
  MAX_COMPARISON_QUESTIONS,
  MAX_COMPARISON_TEXT,
  MIN_COMPARISON_COLUMN_WIDTH,
} from "../../../shared/comparisons";
import { staleAnswerKey, useComparisonColumns } from "../comparisonColumnState";
import { comparisonTableAt } from "./comparisonCommands";
import { asOneStep, undoStackOf } from "./editorUndo";

/** A column's Question as it is stored: one line, no longer than a table's Question. */
export function questionLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_COMPARISON_TEXT);
}

/** A column's label as it is stored: one short line; empty is no label, which the heading derives. */
export function labelLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_COMPARISON_LABEL);
}

interface InTable {
  pos: number;
  table: ProseMirrorNode;
  /** Where each row starts, in the document. */
  rows: number[];
}

function tableIn(editor: Editor, tableId: string): InTable | null {
  const pos = comparisonTableAt(editor, tableId);
  const table = pos === null ? null : editor.state.doc.nodeAt(pos);
  if (pos === null || !table) return null;
  const rows: number[] = [];
  table.forEach((_row, offset) => {
    rows.push(pos + 1 + offset);
  });
  return { pos, table, rows };
}

function cellOf(
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

function offsetAt(row: ProseMirrorNode, index: number): number {
  let offset = 0;
  for (let at = 0; at < index && at < row.childCount; at++) offset += row.child(at).nodeSize;
  return offset;
}

function cellNode(editor: Editor, questionId: string) {
  const { schema } = editor.state;
  return schema.nodes[COMPARISON_CELL_NODE]?.create(
    { questionId, status: "waiting" },
    schema.nodes.paragraph?.create(),
  );
}

function withLabel<T extends { label?: string }>(question: T, label: string): T {
  if (label) return { ...question, label };
  const { label: _gone, ...rest } = question;
  return rest as T;
}

/**
 * A column for `text` at `index`, and in each row a cell waiting to be
 * filled, as one change ⌘Z takes back. Null when the table is gone, the
 * Question is empty, or the table holds as many columns as it can.
 */
export function insertComparisonColumnAt(
  editor: Editor,
  tableId: string,
  index: number,
  text: string,
  label = "",
): string | null {
  const found = tableIn(editor, tableId);
  const question = questionLine(text);
  if (!found || !question) return null;
  const questions = comparisonQuestionsOf(found.table.attrs);
  if (questions.length >= MAX_COMPARISON_QUESTIONS) return null;
  const at = Math.max(0, Math.min(index, questions.length));
  const id = crypto.randomUUID();
  const nextLabel = labelLine(label);
  const column = { id, text: question, ...(nextLabel && { label: nextLabel }) };
  const next = [...questions.slice(0, at), column, ...questions.slice(at)];
  const tr = editor.state.tr.setNodeAttribute(found.pos, "questions", next);
  for (let row = found.table.childCount - 1; row >= 0; row--) {
    const node = found.table.child(row);
    const rowPos = found.rows[row];
    const element = cellNode(editor, id);
    if (rowPos === undefined || !element) continue;
    tr.insert(rowPos + 1 + offsetAt(node, at), element);
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  return id;
}

/** A column left or right of the one named, from its Question. */
export function insertComparisonColumnBeside(
  editor: Editor,
  tableId: string,
  questionId: string,
  side: "left" | "right",
  text: string,
): string | null {
  const found = tableIn(editor, tableId);
  if (!found) return null;
  const at = comparisonQuestionsOf(found.table.attrs).findIndex(
    (question) => question.id === questionId,
  );
  if (at === -1) return null;
  return insertComparisonColumnAt(editor, tableId, side === "left" ? at : at + 1, text);
}

export interface EditedColumn {
  changed: boolean;
  /** Whether the column's cells are asked again: only a new Question does that. */
  refilled: boolean;
  questionId: string;
  label: string;
}

function keepOldAnswer(found: InTable, questionId: string, newQuestionId: string): void {
  const tableId = String(found.table.attrs.id ?? "");
  found.table.forEach((row) => {
    const at = cellOf(row, questionId);
    if (!at) return;
    const cell = row.child(at.index);
    const words = cell.textBetween(0, cell.content.size, "\n", " ").trim();
    if (words) {
      useComparisonColumns
        .getState()
        .rememberStale(
          staleAnswerKey(tableId, String(row.attrs.documentId ?? ""), newQuestionId),
          words,
        );
    }
  });
}

/**
 * Gives the column's cells to a new Question in the Mind's own document, one
 * undo step: the old cells are taken out whole and new ones put in their
 * place, so ⌘Z brings the old cells back with nothing a fill wrote into the
 * new ones, which a ProseMirror change would leave behind.
 */
function rewordCellsInYjs(
  editor: Editor,
  tableId: string,
  questionId: string,
  newQuestionId: string,
  questions: ReturnType<typeof comparisonQuestionsOf>,
): boolean {
  const sync = ySyncPluginKey.getState(editor.state) as
    | { doc?: Y.Doc; type?: Y.XmlFragment }
    | undefined;
  const manager = undoStackOf(editor);
  const doc = sync?.doc;
  const fragment = sync?.type;
  if (!doc || !fragment || !manager) return false;
  const table = fragment
    .toArray()
    .find(
      (element): element is Y.XmlElement =>
        element instanceof Y.XmlElement &&
        element.nodeName === COMPARISON_TABLE_NODE &&
        String(element.getAttribute("id") ?? "") === tableId,
    );
  if (!table) return false;
  const origin = Symbol("comparison column");
  manager.addTrackedOrigin(origin);
  manager.stopCapturing();
  try {
    doc.transact(() => {
      table.setAttribute("questions", questions as never);
      for (const row of table.toArray()) {
        if (!(row instanceof Y.XmlElement) || row.nodeName !== COMPARISON_ROW_NODE) continue;
        const at = row
          .toArray()
          .findIndex(
            (cell) =>
              cell instanceof Y.XmlElement &&
              String(cell.getAttribute("questionId") ?? "") === questionId,
          );
        if (at === -1) continue;
        const cell = new Y.XmlElement(COMPARISON_CELL_NODE);
        cell.setAttribute("questionId", newQuestionId);
        cell.setAttribute("status", "waiting");
        const line = new Y.XmlElement("paragraph");
        line.setAttribute(BLOCK_ID_ATTRIBUTE, crypto.randomUUID());
        cell.insert(0, [line]);
        row.delete(at, 1);
        row.insert(at, [cell]);
      }
    }, origin);
  } finally {
    manager.removeTrackedOrigin(origin);
    manager.stopCapturing();
  }
  return true;
}

/**
 * A column's label and Question. A new Question refills only that column:
 * its cells become new ones, so what a fill still writing for the old
 * Question can no longer land, and ⌘Z puts the old cells back whole.
 */
export function editComparisonColumn(
  editor: Editor,
  tableId: string,
  questionId: string,
  { text, label }: { text: string; label: string },
): EditedColumn | null {
  const found = tableIn(editor, tableId);
  if (!found) return null;
  const questions = comparisonQuestionsOf(found.table.attrs);
  const index = questions.findIndex((question) => question.id === questionId);
  const old = questions[index];
  if (!old) return null;
  const question = questionLine(text);
  if (!question) return null;
  const nextLabel = labelLine(label);
  if (question === old.text && nextLabel === (old.label ?? "")) {
    return { changed: false, refilled: false, questionId, label: comparisonLabelOf(old) };
  }
  if (question === old.text) {
    const edited = withLabel(old, nextLabel);
    const next = questions.map((each, at) => (at === index ? edited : each));
    asOneStep(editor, () =>
      editor.view.dispatch(editor.state.tr.setNodeAttribute(found.pos, "questions", next)),
    );
    return { changed: true, refilled: false, questionId, label: comparisonLabelOf(edited) };
  }

  const newQuestionId = crypto.randomUUID();
  const column = {
    id: newQuestionId,
    text: question,
    ...(nextLabel && { label: nextLabel }),
    ...(old.width !== undefined && { width: old.width }),
    ...(old.hidden !== undefined && { hidden: old.hidden }),
  };
  const next = questions.map((each, at) => (at === index ? column : each));
  keepOldAnswer(found, questionId, newQuestionId);
  if (!rewordCellsInYjs(editor, tableId, questionId, newQuestionId, next)) {
    const tr = editor.state.tr.setNodeAttribute(found.pos, "questions", next);
    for (let row = found.table.childCount - 1; row >= 0; row--) {
      const node = found.table.child(row);
      const rowPos = found.rows[row];
      const at = cellOf(node, questionId);
      const element = cellNode(editor, newQuestionId);
      if (rowPos === undefined || !at || !element) continue;
      const start = rowPos + 1 + at.offset;
      tr.replaceWith(start, start + node.child(at.index).nodeSize, element);
    }
    asOneStep(editor, () => editor.view.dispatch(tr));
  }
  return {
    changed: true,
    refilled: true,
    questionId: newQuestionId,
    label: comparisonLabelOf(column),
  };
}

export interface DuplicatedColumn {
  questionId: string;
  label: string;
  /** Whether its cells wait for an Answer, so the table fills them. */
  fill: boolean;
}

/** A column copied beside itself, its label, Question and Answers included. */
export function duplicateComparisonColumn(
  editor: Editor,
  tableId: string,
  questionId: string,
): DuplicatedColumn | null {
  const found = tableIn(editor, tableId);
  if (!found) return null;
  const questions = comparisonQuestionsOf(found.table.attrs);
  const index = questions.findIndex((question) => question.id === questionId);
  const source = questions[index];
  if (!source || questions.length >= MAX_COMPARISON_QUESTIONS) return null;
  const id = crypto.randomUUID();
  const column = { ...source, id };
  const next = [...questions.slice(0, index + 1), column, ...questions.slice(index + 1)];
  const tr = editor.state.tr.setNodeAttribute(found.pos, "questions", next);
  let fill = false;
  for (let row = found.table.childCount - 1; row >= 0; row--) {
    const node = found.table.child(row);
    const rowPos = found.rows[row];
    const at = cellOf(node, questionId);
    if (rowPos === undefined || !at) continue;
    const cell = node.child(at.index);
    const state = comparisonCellOf(cell.attrs);
    // A cell still being written is copied waiting: its words belong to the old column's fill.
    const copy =
      (state.status === "done" || state.status === "failed") &&
      cell.type.create({ ...cell.attrs, questionId: id }, cell.content);
    const made = copy || cellNode(editor, id);
    if (!made) continue;
    if (cellToFill(comparisonCellOf(made.attrs))) fill = true;
    tr.insert(rowPos + 1 + at.offset + cell.nodeSize, made);
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  return { questionId: id, label: comparisonLabelOf(source), fill };
}

export interface RemovedColumn {
  label: string;
  /** The column left in its place, for the focus: the one after it, else the one before. */
  focusId: string | null;
}

/** A column and its cells taken out whole; ⌘Z puts them back with their Answers and problems. */
export function removeComparisonColumn(
  editor: Editor,
  tableId: string,
  questionId: string,
): RemovedColumn | null {
  const found = tableIn(editor, tableId);
  if (!found) return null;
  const questions = comparisonQuestionsOf(found.table.attrs);
  const index = questions.findIndex((question) => question.id === questionId);
  const removed = questions[index];
  if (!removed || questions.length <= 1) return null;
  const next = questions.filter((question) => question.id !== questionId);
  const tr = editor.state.tr.setNodeAttribute(found.pos, "questions", next);
  for (let row = found.table.childCount - 1; row >= 0; row--) {
    const node = found.table.child(row);
    const rowPos = found.rows[row];
    const at = cellOf(node, questionId);
    if (rowPos === undefined || !at) continue;
    const start = rowPos + 1 + at.offset;
    tr.delete(start, start + node.child(at.index).nodeSize);
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  const focus = questions[index + 1] ?? questions[index - 1] ?? null;
  return { label: comparisonLabelOf(removed), focusId: focus?.id ?? null };
}

export interface ColumnHere {
  /** Where it is among all the columns: the second column is 1. */
  index: number;
  label: string;
}

/** A column as the note has it now, for the core to move. */
export function comparisonColumnHere(
  editor: Editor,
  tableId: string,
  questionId: string,
): ColumnHere | null {
  const found = tableIn(editor, tableId);
  if (!found) return null;
  const questions = comparisonQuestionsOf(found.table.attrs);
  const index = questions.findIndex((question) => question.id === questionId);
  const question = questions[index];
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
  const questions = comparisonQuestionsOf(found.table.attrs);
  const index = questions.findIndex((question) => question.id === questionId);
  if (index === -1) return null;
  for (let at = index + direction; at >= 0 && at < questions.length; at += direction) {
    if (questions[at]?.hidden !== true) return at;
  }
  return null;
}

export interface ResizedColumn {
  label: string;
  width: number;
}

/** A column's width in pixels, within what a table can hold; ⌘Z puts the old width back. */
export function setComparisonColumnWidth(
  editor: Editor,
  tableId: string,
  questionId: string,
  width: number,
): ResizedColumn | null {
  const found = tableIn(editor, tableId);
  if (!found) return null;
  const questions = comparisonQuestionsOf(found.table.attrs);
  const index = questions.findIndex((question) => question.id === questionId);
  const old = questions[index];
  if (!old) return null;
  const nextWidth = Math.min(
    MAX_COMPARISON_COLUMN_WIDTH,
    Math.max(MIN_COMPARISON_COLUMN_WIDTH, Math.round(width)),
  );
  if (old.width === nextWidth) return null;
  const next = questions.map((question, at) =>
    at === index ? { ...question, width: nextWidth } : question,
  );
  asOneStep(editor, () =>
    editor.view.dispatch(editor.state.tr.setNodeAttribute(found.pos, "questions", next)),
  );
  return { label: comparisonLabelOf(old), width: nextWidth };
}

export interface HiddenColumn {
  label: string;
  questionId: string;
  hidden: boolean;
  /** The heading that takes the focus: the column shown, or the next one shown after a hidden one. */
  focusId: string | null;
}

/** A column hidden from the table, or shown again; its Answers stay with it, and ⌘Z puts it back. */
export function setComparisonColumnHidden(
  editor: Editor,
  tableId: string,
  questionId: string,
  hidden: boolean,
): HiddenColumn | null {
  const found = tableIn(editor, tableId);
  if (!found) return null;
  const questions = comparisonQuestionsOf(found.table.attrs);
  const index = questions.findIndex((question) => question.id === questionId);
  const old = questions[index];
  if (!old || (old.hidden === true) === hidden) return null;
  const next: typeof questions = questions.map((question, at) => {
    if (at !== index) return question;
    if (hidden) return { ...question, hidden: true };
    const { hidden: _shown, ...rest } = question;
    return rest;
  });
  asOneStep(editor, () =>
    editor.view.dispatch(editor.state.tr.setNodeAttribute(found.pos, "questions", next)),
  );
  const after = next.slice(index + 1).find((question) => question.hidden !== true);
  const before = next
    .slice(0, index)
    .reverse()
    .find((question) => question.hidden !== true);
  return {
    label: comparisonLabelOf(old),
    questionId,
    hidden,
    focusId: hidden ? (after?.id ?? before?.id ?? null) : questionId,
  };
}
