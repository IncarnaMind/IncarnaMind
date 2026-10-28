/**
 * A comparison table's column move (#1833): the core moves it, so Undo and
 * Redo ask the core to move it back or forward. An Answer a fill wrote after
 * the move then stays under its Question; a note's own Undo would take away
 * the cells the move put there, and the Answers written into them with it.
 */
import type { Editor } from "@tiptap/core";
import type { ComparisonColumnHandle } from "../comparisonColumnState";
import { useComparisonColumns } from "../comparisonColumnState";
import { core } from "../core";
import { flushMindUpdates } from "../mindCopies";
import { useAppStore } from "../store";
import { type Undoable, useUndo } from "../undo";
import { undoStackOf } from "./editorUndo";

/** What a move took: the column, where it was, where it is, and the words for its line. */
export interface ColumnMoved {
  questionId: string;
  label: string;
  from: number;
  to: number;
}

/** The moves on the app's undo stack, apart from the note's own steps. */
const moves = new WeakSet<Undoable>();

/** The editors whose keys are watched, so ⌘Z takes a move back through the core. */
const watched = new WeakSet<Editor>();

async function moveTo(
  handle: ComparisonColumnHandle,
  questionId: string,
  to: number,
): Promise<void> {
  await flushMindUpdates(handle.mindId);
  await core.moveComparisonColumn({
    mindId: handle.mindId,
    tableId: handle.tableId,
    questionId,
    to,
  });
  useComparisonColumns.getState().focusColumn(handle.tableId, questionId);
}

/**
 * Puts a move on the app's undo stack, with its line, until the note is
 * edited: an edit after it is what ⌘Z takes back first, as for any change the
 * note keeps in its own history.
 */
export function offerMoveUndo(
  editor: Editor,
  handle: ComparisonColumnHandle,
  moved: ColumnMoved,
): void {
  watchMoveUndoKeys(editor);
  const entry: Undoable = {
    said: (t, cut) => t("comparison.column.moved", { label: cut(moved.label) }),
    undo: () => moveTo(handle, moved.questionId, moved.from),
    redo: () => moveTo(handle, moved.questionId, moved.to),
  };
  moves.add(entry);
  const stack = undoStackOf(editor);
  const forget = () => {
    stack?.off("stack-item-added", forget);
    editor.off("destroy", forget);
    useUndo.getState().withdraw(entry);
  };
  stack?.on("stack-item-added", forget);
  editor.on("destroy", forget);
  useUndo.getState().push(entry);
}

/** Whether Undo or Redo, now, would take back or do again a move of this table's columns. */
export function moveUndoAt(step: "undo" | "redo"): boolean {
  const state = useUndo.getState();
  const change = step === "undo" ? state.done.at(-1) : state.undone.at(-1);
  return change !== undefined && moves.has(change);
}

/**
 * Takes back, or does again, the move on top of the app's undo stack, through
 * the core; false when ⌘Z belongs to the note, which handles it itself.
 */
export function undoMove(step: "undo" | "redo"): boolean {
  if (!moveUndoAt(step)) return false;
  const state = useUndo.getState();
  const run = step === "undo" ? state.undo() : state.redo();
  run.catch((error: unknown) => useAppStore.getState().reportError(error));
  return true;
}

/**
 * Watches the editor's keys, before the note's own Undo: while a move is the
 * last change, ⌘Z and ⌘⇧Z go to the core, and a later edit hands them back to
 * the note. Typing in a field keeps its own Undo.
 */
export function watchMoveUndoKeys(editor: Editor): void {
  if (watched.has(editor) || typeof document === "undefined") return;
  watched.add(editor);
  const onKey = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== "z" || event.altKey) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    const target = event.target;
    if (!(target instanceof Element) || !editor.view.dom.contains(target)) return;
    if (target.closest("input, textarea")) return;
    const step = event.shiftKey ? "redo" : "undo";
    if (!moveUndoAt(step)) return;
    event.preventDefault();
    event.stopPropagation();
    undoMove(step);
  };
  document.addEventListener("keydown", onKey, true);
  editor.on("destroy", () => document.removeEventListener("keydown", onKey, true));
}
