import { type Editor, Extension } from "@tiptap/core";
import { useUndo } from "../undo";
import { redoNoteHistory, undoNoteHistory } from "./comparisonStructureUndo";

/**
 * Undo in a Note's text, by its keys or the Edit menu (#3115): the Note's own last step, a
 * Comparison's column change among them in the order made, and with nothing of the Note's to take
 * back, the app's last change.
 */
export function undoInNote(editor: Editor): Promise<void> | undefined {
  if (undoNoteHistory(editor) || editor.commands.undo()) return undefined;
  return useUndo.getState().undo();
}

/** Redo in a Note's text, the same way round: the Note's own first, then the app's. */
export function redoInNote(editor: Editor): Promise<void> | undefined {
  if (redoNoteHistory(editor) || editor.commands.redo()) return undefined;
  return useUndo.getState().redo();
}

/**
 * ⌘Z and ⇧⌘Z in a Note, and Ctrl+Y off the Mac, before Collaboration's own keys, which know only
 * the Note's steps. ProseMirror keeps these keys from the page whatever is done with them, so the
 * app's Undo is reached from here. A key with nothing to take back is still the Note's: where
 * Shift+Z reads as "z", as on Linux, ⇧Ctrl+Z must never fall through to Undo (#2691). A field
 * drawn in the Note never reaches here: its node view keeps its keys, and its own Undo.
 */
export const NoteUndoKeys = Extension.create({
  name: "noteUndoKeys",
  priority: 1001,

  addKeyboardShortcuts() {
    const run = (step: (editor: Editor) => Promise<void> | undefined) => () => {
      // The app's Undo says its own failure where the change's line is.
      void step(this.editor);
      return true;
    };
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    return {
      "Mod-z": run(undoInNote),
      "Shift-Mod-z": run(redoInNote),
      "Shift-Mod-Z": run(redoInNote),
      ...(!mac && { "Mod-y": run(redoInNote) }),
    };
  },
});
