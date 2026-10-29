/**
 * A comparison table's column changes (#1833): the core is the one writer of
 * its structure, so Undo and Redo ask the core, by step id, to take a change
 * back or do it again. One history in this window orders those steps with the
 * note's own text steps by when the User made them: ⌘Z takes back the later
 * of either, and a note edit never drops a column change.
 */
import type { Editor } from "@tiptap/core";
import { clientId } from "../clientId";
import { useComparisonColumns } from "../comparisonColumnState";
import { core } from "../core";
import { flushMindUpdates } from "../mindCopies";
import { type Undoable, UndoRefused, useUndo } from "../undo";
import { type UndoStack, type UndoStep, undoStackOf } from "./editorUndo";

/** A column change the core made, and the column a line names. */
export interface StructureChange {
  mindId: string;
  tableId: string;
  /** The core's record of the change, for its Undo and Redo. */
  step: string;
  /** The column to take the focus after Undo or Redo, when it is there. */
  questionId?: string;
  said: Undoable["said"];
}

/** One step of this note's history, a text step or a column change, by when it was made. */
interface HistoryToken {
  seq: number;
  kind: "text" | "structure";
  step?: UndoStep;
  entry?: Undoable;
}

interface History {
  undo: HistoryToken[];
  redo: HistoryToken[];
  next: number;
  /** Column changes being written now: ⌘Z waits for them. */
  pending: number;
}

const histories = new WeakMap<Editor, History>();

async function applyStructure(change: StructureChange, step: "undo" | "redo"): Promise<void> {
  await flushMindUpdates(change.mindId);
  const input = {
    mindId: change.mindId,
    tableId: change.tableId,
    clientId,
    step: change.step,
  };
  const request = `window-${crypto.randomUUID()}`;
  useComparisonColumns.getState().hold(change.tableId, request);
  try {
    const result =
      step === "undo"
        ? await core.undoComparisonStructure(input)
        : await core.redoComparisonStructure(input);
    if (!result.moved) {
      throw new UndoRefused((t) => t("comparison.column.undoChanged"), null);
    }
  } finally {
    useComparisonColumns.getState().release(change.tableId, request);
  }
  if (change.questionId) {
    useComparisonColumns.getState().focusColumn(change.tableId, change.questionId);
  }
}

/** The note's history: its text steps as they are now, then both kinds as they are made. */
function historyOf(editor: Editor): History | null {
  const stack: UndoStack | undefined = undoStackOf(editor);
  if (!stack) return null;
  const known = histories.get(editor);
  if (known) return known;
  const history: History = {
    undo: stack.undoStack.map((step, seq) => ({ seq, kind: "text", step })),
    redo: [],
    next: stack.undoStack.length,
    pending: 0,
  };
  histories.set(editor, history);
  // An Undo or Redo of the note adds its reverse step with the manager itself as the origin.
  const added = (event: { stackItem: UndoStep; origin?: unknown }) => {
    if (event.origin === stack) return;
    history.undo.push({ seq: history.next++, kind: "text", step: event.stackItem });
    history.redo = [];
    useUndo.setState({ undone: [] });
  };
  const cleared = () => {
    history.undo = stack.undoStack.map((step, seq) => ({ seq, kind: "text", step }));
    history.redo = [];
    history.next = stack.undoStack.length;
  };
  stack.on("stack-item-added", added);
  stack.on("stack-cleared", cleared);
  editor.on("destroy", () => {
    stack.off("stack-item-added", added);
    stack.off("stack-cleared", cleared);
    histories.delete(editor);
  });
  installKeys(editor);
  return history;
}

/**
 * A column change is about to be asked of the core: its place in the history
 * is where the User acted, before any note edit made while it is written.
 */
export function reserveStructureStep(editor: Editor): number {
  const history = historyOf(editor);
  if (!history) return 0;
  undoStackOf(editor)?.stopCapturing();
  history.pending += 1;
  return history.next++;
}

/** The ask made no change, or failed: its place in the history is dropped. */
export function releaseStructureStep(editor: Editor): void {
  const history = histories.get(editor);
  if (history) history.pending = Math.max(0, history.pending - 1);
}

/**
 * Puts a column change on the note's history, at the place it was asked for,
 * with its line, and clears Redo as any new action does.
 */
export function offerStructureUndo(editor: Editor, change: StructureChange, seq: number): void {
  const history = historyOf(editor);
  if (!history) return;
  const entry: Undoable = {
    said: change.said,
    undo: () => applyStructure(change, "undo"),
    redo: () => applyStructure(change, "redo"),
  };
  history.undo.push({ seq, kind: "structure", entry });
  history.undo.sort((left, right) => left.seq - right.seq);
  history.redo = [];
  history.pending = Math.max(0, history.pending - 1);
  useUndo.getState().push(entry);
}

/** Takes back the note's latest step, text or column change; false when it has none. */
export function undoNoteHistory(editor: Editor): boolean {
  const history = histories.get(editor);
  const stack = undoStackOf(editor);
  if (!history || !stack || history.pending > 0) return false;
  const state = useUndo.getState();
  let skipped = false;
  while (history.undo.at(-1)?.kind === "structure") {
    const top = history.undo.at(-1);
    const entry = top?.entry;
    if (entry && state.done.includes(entry)) break;
    if (!top) break;
    history.undo.pop();
    if (entry && state.undone.includes(entry)) history.redo.push(top);
    skipped = true;
  }
  const token = history.undo.at(-1);
  if (!token) return skipped ? undoNoteHistory(editor) : false;
  if (token.kind === "text") {
    if (stack.undoStack.at(-1) !== token.step) return false;
    editor.commands.undo();
    history.undo.pop();
    history.redo.push(token);
    return true;
  }
  const entry = token.entry;
  if (!entry || !useUndo.getState().done.includes(entry)) return false;
  void useUndo
    .getState()
    .undo(entry)
    .then(() => {
      const state = useUndo.getState();
      if (state.undone.includes(entry)) {
        history.undo = history.undo.filter((each) => each !== token);
        history.redo.push(token);
      } else if (!state.done.includes(entry)) {
        // Refused, or gone: it can't be tried again, so it leaves the history with its problem line.
        history.undo = history.undo.filter((each) => each !== token);
      }
    });
  return true;
}

/** Does again the note's latest undone step, text or column change; false when it has none. */
export function redoNoteHistory(editor: Editor): boolean {
  const history = histories.get(editor);
  if (!history || history.pending > 0) return false;
  const state = useUndo.getState();
  let skipped = false;
  while (history.redo.at(-1)?.kind === "structure") {
    const top = history.redo.at(-1);
    const entry = top?.entry;
    if (entry && state.undone.at(-1) === entry) break;
    if (!top) break;
    history.redo.pop();
    if (entry && state.done.includes(entry)) history.undo.push(top);
    skipped = true;
  }
  const token = history.redo.at(-1);
  if (!token) return skipped ? redoNoteHistory(editor) : false;
  if (token.kind === "text") {
    if (!editor.commands.redo()) return false;
    history.redo.pop();
    history.undo.push(token);
    return true;
  }
  const entry = token.entry;
  if (!entry || useUndo.getState().undone.at(-1) !== entry) return false;
  void useUndo
    .getState()
    .redo()
    .then(() => {
      if (useUndo.getState().done.includes(entry)) {
        history.redo.pop();
        history.undo.push(token);
      }
    });
  return true;
}

/** The note's keys, before its own Undo: while a column change is the latest step, ⌘Z asks the core. */
function installKeys(editor: Editor): void {
  if (typeof document === "undefined") return;
  const onKey = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== "z" || event.altKey) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    const target = event.target;
    if (!(target instanceof Element) || !editor.view.dom.contains(target)) return;
    if (target.closest("input, textarea")) return;
    const done = event.shiftKey ? redoNoteHistory(editor) : undoNoteHistory(editor);
    if (!done) return;
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("keydown", onKey, true);
  editor.on("destroy", () => document.removeEventListener("keydown", onKey, true));
}

/** For the Edit menu, with the note focused: the app's history first, then the note's own. */
export const undoFromMenu = undoNoteHistory;
export const redoFromMenu = redoNoteHistory;
