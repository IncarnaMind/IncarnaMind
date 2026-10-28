/**
 * A comparison table's column changes (#1833): the core is the one writer of
 * its structure, so Undo and Redo ask the core to take a change back or do it
 * again. An Answer a fill wrote after a change then stays under its Question;
 * the note's own Undo would take away the cells the change put there, and the
 * Answers written into them with it.
 */
import type { Editor } from "@tiptap/core";
import { useComparisonColumns } from "../comparisonColumnState";
import { core } from "../core";
import { flushMindUpdates } from "../mindCopies";
import { useAppStore } from "../store";
import { type Undoable, useUndo } from "../undo";
import { undoStackOf } from "./editorUndo";

/** A column change the core made, and the column a line names. */
export interface StructureChange {
  mindId: string;
  tableId: string;
  /** The column to take the focus after Undo or Redo, when it is there. */
  questionId?: string;
  said: Undoable["said"];
}

/** The structure changes on the app's undo stack, apart from the note's own steps. */
const changes = new WeakSet<Undoable>();

/** The editors whose keys are watched, so ⌘Z takes a change back through the core. */
const watched = new WeakSet<Editor>();

async function applyStructure(change: StructureChange, step: "undo" | "redo"): Promise<void> {
  await flushMindUpdates(change.mindId);
  const result =
    step === "undo"
      ? await core.undoComparisonStructure({ mindId: change.mindId, tableId: change.tableId })
      : await core.redoComparisonStructure({ mindId: change.mindId, tableId: change.tableId });
  if (result.moved && change.questionId) {
    useComparisonColumns.getState().focusColumn(change.tableId, change.questionId);
  }
}

/**
 * Puts a column change on the app's undo stack, with its line, until the note
 * is edited: an edit after it is what ⌘Z takes back first, as for any change
 * the note keeps in its own history.
 */
export function offerStructureUndo(editor: Editor, change: StructureChange): void {
  watchStructureUndoKeys(editor);
  const entry: Undoable = {
    said: change.said,
    undo: () => applyStructure(change, "undo"),
    redo: () => applyStructure(change, "redo"),
  };
  changes.add(entry);
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

export function structureUndoAt(step: "undo" | "redo"): boolean {
  const state = useUndo.getState();
  const change = step === "undo" ? state.done.at(-1) : state.undone.at(-1);
  return change !== undefined && changes.has(change);
}

/**
 * Takes back, or does again, the column change on top of the app's undo stack,
 * through the core; false when ⌘Z belongs to the note, which handles it itself.
 */
export function undoStructure(step: "undo" | "redo"): boolean {
  if (!structureUndoAt(step)) return false;
  const state = useUndo.getState();
  const run = step === "undo" ? state.undo() : state.redo();
  run.catch((error: unknown) => useAppStore.getState().reportError(error));
  return true;
}

/**
 * Watches the editor's keys, before the note's own Undo: while a column
 * change is the last one, ⌘Z and ⌘⇧Z go to the core, and a later edit hands
 * them back to the note. Typing in a field keeps its own Undo.
 */
export function watchStructureUndoKeys(editor: Editor): void {
  if (watched.has(editor) || typeof document === "undefined") return;
  watched.add(editor);
  const onKey = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== "z" || event.altKey) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    const target = event.target;
    if (!(target instanceof Element) || !editor.view.dom.contains(target)) return;
    if (target.closest("input, textarea")) return;
    const step = event.shiftKey ? "redo" : "undo";
    if (!structureUndoAt(step)) return;
    event.preventDefault();
    event.stopPropagation();
    undoStructure(step);
  };
  document.addEventListener("keydown", onKey, true);
  editor.on("destroy", () => document.removeEventListener("keydown", onKey, true));
}
