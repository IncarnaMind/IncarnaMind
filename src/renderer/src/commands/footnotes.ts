import type { Editor } from "@tiptap/core";
import { canInsertFootnote, insertFootnote } from "../editor/footnoteSchema";
import { noteHolding } from "../editor/noteKeymap";
import { mindEditor } from "../editor/openEditors";
import type { Command, CommandContext } from "./registry";
import { mindInFront } from "./targets";

/**
 * The note's keymap gives a command the Block at the cursor as its focus; in
 * ⌘K nothing does, and the Note in front takes it at its cursor.
 */
function noteOf(ctx: CommandContext): Editor | null {
  const editor = ctx.focus?.kind === "block" ? noteHolding(ctx.focus.id) : openNoteInFront();
  return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
}

function openNoteInFront(): Editor | null {
  const mind = mindInFront();
  return mind === null ? null : mindEditor(mind);
}

/**
 * Insert footnote (#284) adds a footnote after the selection and opens it to
 * be written, or opens the footnote selected. The "/" menu, the selection menu
 * and ⌘K do it; ⌥⌘F is Find and Replace (#1935).
 */
export const footnoteCommands: readonly Command[] = [
  {
    id: "footnote.insert",
    label: "editor.footnote.insert",
    group: "main",
    appliesTo: ["block", "mind", "tab"],
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
