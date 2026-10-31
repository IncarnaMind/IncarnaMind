import { canInsertPageBreak, insertPageBreak, PAGE_BREAK_KEYS } from "../editor/pageBreakSchema";
import { noteToWrite } from "./handles";
import type { Command } from "./registry";

/**
 * Insert page break (#746), in any Note, as in Word: one where the selection
 * starts, from ⌘K and the selection menu. The note binds ⌘↵ (Ctrl+Enter) to
 * it itself, after its keymap's commands, so ⌘↵ in a waiting change still
 * accepts that change.
 */
export const pageBreakCommands: readonly Command[] = [
  {
    id: "pageBreak.insert",
    label: "editor.pageBreak.insert",
    rowKeys: PAGE_BREAK_KEYS,
    group: "main",
    // The note's own undo (⌘Z) takes it back.
    reversible: true,
    when: (ctx) => noteToWrite(ctx) !== null,
    enabled(ctx) {
      const editor = noteToWrite(ctx);
      return editor && canInsertPageBreak(editor.state)
        ? true
        : { reason: "editor.pageBreak.unavailable" };
    },
    run(ctx) {
      const editor = noteToWrite(ctx);
      if (editor) insertPageBreak(editor);
    },
  },
];
