import { Extension } from "@tiptap/core";

/**
 * ⇧⌘Z (Ctrl+Shift+Z) in the note is Redo, or nothing when there is nothing to redo. Collaboration's
 * Redo declines then, and ProseMirror tries the key without Shift, Collaboration's Undo: where the
 * key reads "z" with Shift held, as in a Linux window, it took back the last change (#2691).
 */
export const RedoKeys = Extension.create({
  name: "redoKeys",
  // Before Collaboration's own keys.
  priority: 1001,

  addKeyboardShortcuts() {
    const redo = () => {
      this.editor.commands.redo();
      return true;
    };
    return { "Shift-Mod-z": redo, "Shift-Mod-Z": redo };
  },
});
