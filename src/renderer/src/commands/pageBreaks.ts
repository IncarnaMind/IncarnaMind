import { editableNoteAt } from "../editor/noteKeymap";
import { canInsertPageBreak, insertPageBreak } from "../editor/pageBreakSchema";
import type { Command, CommandContext } from "./registry";

const noteOf = (ctx: CommandContext) => editableNoteAt(ctx.focus);

/**
 * Insert page break (#746), in any Note, as in Word: ⌘↵ (Ctrl+Enter) puts one
 * where the selection starts, unless the cursor is in a waiting change, which
 * ⌘↵ accepts. The selection menu does the same.
 */
export const pageBreakCommands: readonly Command[] = [
  {
    id: "pageBreak.insert",
    label: "editor.pageBreak.insert",
    shortcut: { keys: "CmdOrCtrl+Enter", yields: "proposal.accept" },
    group: "main",
    appliesTo: ["block"],
    // The note's own undo (⌘Z) takes it back.
    reversible: true,
    when: (ctx) => noteOf(ctx) !== null,
    enabled(ctx) {
      const editor = noteOf(ctx);
      return editor && canInsertPageBreak(editor.state)
        ? true
        : { reason: "editor.pageBreak.unavailable" };
    },
    run(ctx) {
      const editor = noteOf(ctx);
      if (editor) insertPageBreak(editor);
    },
  },
];
