import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { noteHolding } from "../editor/noteKeymap";
import { applyLink, requestLinkEdit } from "../editor/selectionCommands";
import type { Command, CommandContext } from "./registry";

/** The note's keymap gives a command the Block at the cursor as its focus. */
function noteOf(ctx: CommandContext): Editor | null {
  const editor = ctx.focus?.kind === "block" ? noteHolding(ctx.focus.id) : null;
  return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
}

const hasLink = (editor: Editor) => {
  const { from, to, empty } = editor.state.selection;
  const link = editor.schema.marks.link;
  return empty
    ? editor.isActive("link")
    : link !== undefined && editor.state.doc.rangeHasMark(from, to, link);
};

/**
 * Links, as in Notion and Google Docs: ⌘K (Ctrl+K) on selected text adds a
 * link to it, and in a link it edits that link. With no text selected and
 * the cursor outside a link, it isn't offered, so ⌘K stays the window's.
 */
export const linkCommands: readonly Command[] = [
  {
    id: "link.edit",
    label: "command.link.edit",
    shortcut: { keys: "CmdOrCtrl+K" },
    group: "main",
    appliesTo: ["block"],
    // One Undo step, taken back with the note's own undo (⌘Z).
    reversible: true,
    when(ctx) {
      const editor = noteOf(ctx);
      if (editor === null) return false;
      // A picture or another Block is selected, not words: ⌘K stays the window's, as it did before
      // a Block could be selected on its own (#2377).
      const { selection } = editor.state;
      const words = !selection.empty && !(selection instanceof NodeSelection);
      return words || editor.isActive("link");
    },
    run(ctx) {
      const editor = noteOf(ctx);
      if (editor) requestLinkEdit(editor);
    },
  },
  {
    id: "link.remove",
    label: "command.link.remove",
    group: "main",
    appliesTo: ["block"],
    reversible: true,
    when(ctx) {
      const editor = noteOf(ctx);
      return editor !== null && hasLink(editor);
    },
    run(ctx) {
      const editor = noteOf(ctx);
      if (editor) applyLink(editor, "");
    },
  },
];
