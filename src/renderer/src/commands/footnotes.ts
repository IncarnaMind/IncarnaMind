import { canInsertFootnote, insertFootnote } from "../editor/footnoteSchema";
import { editableNoteAt } from "../editor/noteKeymap";
import type { Command, CommandContext } from "./registry";

const noteOf = (ctx: CommandContext) => editableNoteAt(ctx.focus);

/**
 * Insert footnote (#284), as in Word and Google Docs: ⌥⌘F (Ctrl+Alt+F) adds
 * a footnote after the selection and opens it to be written, or opens the
 * footnote selected. The "/" menu and the selection menu do the same.
 */
export const footnoteCommands: readonly Command[] = [
  {
    id: "footnote.insert",
    label: "editor.footnote.insert",
    shortcut: { keys: "CmdOrCtrl+Alt+F" },
    group: "main",
    appliesTo: ["block"],
    // The note's own undo (⌘Z) takes it back.
    reversible: true,
    when: (ctx) => noteOf(ctx) !== null,
    enabled(ctx) {
      const editor = noteOf(ctx);
      return editor && canInsertFootnote(editor.state)
        ? true
        : { reason: "editor.footnote.unavailable" };
    },
    run(ctx) {
      const editor = noteOf(ctx);
      if (editor) insertFootnote(editor);
    },
  },
];
