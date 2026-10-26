import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import type { WordsInLine } from "../lineNames";
import { type Undoable, useUndo } from "../undo";

type StackEvent = "stack-item-added" | "stack-item-popped";
type StackListener = (event: { stackItem: UndoStep; type: "undo" | "redo" }) => void;
type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

/** One step of Undo: what it inserted and deleted, by Yjs item. */
export interface UndoStep {
  insertions: DeleteSet;
  deletions: DeleteSet;
}

export interface UndoStack {
  undoStack: UndoStep[];
  redoStack: UndoStep[];
  /** A change soon after the last one joins its step. */
  lastChange: number;
  stopCapturing(): void;
  addTrackedOrigin(origin: unknown): void;
  addToScope: Y.UndoManager["addToScope"];
  on(event: StackEvent, listener: StackListener): void;
  on(event: "stack-cleared", listener: () => void): void;
  off(event: StackEvent, listener: StackListener): void;
  off(event: "stack-cleared", listener: () => void): void;
}

export const undoStackOf = (editor: Editor): UndoStack | undefined =>
  yUndoPluginKey.getState(editor.state)?.undoManager;

/**
 * Makes what `change` does to the note one step of its Undo, apart from the
 * typing before and after it, so ⌘Z in the note takes back that and nothing else.
 */
export function asOneStep<T>(editor: Editor, change: () => T): T {
  const stack = undoStackOf(editor);
  stack?.stopCapturing();
  try {
    return change();
  } finally {
    stack?.stopCapturing();
  }
}

/**
 * Puts the note's last step on the app's undo stack, with its line ("Accepted
 * 2 changes · Undo", or under an Answer with `shownAt`). Once the User edits
 * again, takes it back in the note, or closes the note, it leaves the stack.
 * `onUndone` puts back what the step left behind outside the note's history,
 * such as a check's result the core wrote over (#1247).
 */
export function offerEditorUndo(
  editor: Editor,
  said: WordsInLine,
  shownAt?: string,
  onUndone?: () => void,
): void {
  const manager = undoStackOf(editor);
  const step = manager?.undoStack.at(-1);
  if (!manager || step === undefined) return;
  const change: Undoable = {
    said,
    undo: async () => {
      if (!editor.isDestroyed && manager.undoStack.at(-1) === step) editor.commands.undo();
    },
    ...(shownAt && { shownAt }),
  };
  const forget = () => {
    manager.off("stack-item-added", added);
    manager.off("stack-item-popped", popped);
    editor.off("destroy", forget);
    useUndo.getState().withdraw(change);
  };
  // An Undo puts its reversal on the other stack just before it pops this one: only that isn't an edit.
  const added = (event: { type: "undo" | "redo" }) => {
    if (event.type !== "redo") forget();
  };
  const popped = (event: { stackItem: UndoStep; type: "undo" | "redo" }) => {
    forget();
    if (event.type === "undo" && event.stackItem === step) onUndone?.();
  };
  manager.on("stack-item-added", added);
  manager.on("stack-item-popped", popped);
  editor.on("destroy", forget);
  useUndo.getState().push(change);
}

/**
 * Steps of a note's Undo, followed as ⌘Z takes them back and ⌘⇧Z does them
 * again, each time as a new step: whether they are in the note ("done"),
 * taken back ("undone"), or no longer in its history ("gone", as when it closed).
 */
export interface FollowedSteps {
  state(): "done" | "undone" | "gone";
  /** Done, and nothing done in the note since: Undo takes back these steps alone. */
  onTop(): boolean;
  add(step: UndoStep): void;
  undo(): void | Promise<void>;
  redo?(): void | Promise<void>;
  canRedo?(): boolean;
  observe(listener: () => void): () => void;
}

export function followSteps(editor: Editor, first: readonly UndoStep[]): FollowedSteps | null {
  const manager = undoStackOf(editor);
  if (!manager) return null;
  const done = new Set(first);
  const undone = new Set<UndoStep>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  // Undo and Redo add the step that reverses the one they pop, just before they pop it.
  let added: UndoStep | null = null;
  const onAdded: StackListener = ({ stackItem }) => {
    added = stackItem;
    changed();
  };
  const onPopped: StackListener = ({ stackItem, type }) => {
    const from = type === "undo" ? done : undone;
    const to = type === "undo" ? undone : done;
    if (from.delete(stackItem) && added) to.add(added);
    changed();
  };
  const closed = () => {
    manager.off("stack-item-added", onAdded);
    manager.off("stack-item-popped", onPopped);
    manager.off("stack-cleared", changed);
    editor.off("destroy", closed);
    changed();
  };
  manager.on("stack-item-added", onAdded);
  manager.on("stack-item-popped", onPopped);
  manager.on("stack-cleared", changed);
  editor.on("destroy", closed);
  const inStack = () => manager.undoStack.filter((step) => done.has(step));
  const followed: FollowedSteps = {
    state() {
      if (editor.isDestroyed) return "gone";
      if (inStack().length > 0) return "done";
      return undone.size > 0 ? "undone" : "gone";
    },
    onTop() {
      const ours = inStack().length;
      return (
        !editor.isDestroyed &&
        ours > 0 &&
        manager.undoStack.slice(-ours).every((step) => done.has(step))
      );
    },
    add(step) {
      done.add(step);
      changed();
    },
    undo() {
      let top = manager.undoStack.at(-1);
      while (!editor.isDestroyed && top !== undefined && done.has(top)) {
        editor.commands.undo();
        if (manager.undoStack.at(-1) === top) break;
        top = manager.undoStack.at(-1);
      }
    },
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return followed;
}
