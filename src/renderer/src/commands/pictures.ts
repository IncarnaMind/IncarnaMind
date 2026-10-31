import type { Editor } from "@tiptap/core";
import { noteHolding } from "../editor/noteKeymap";
// The Pictures extension's own commands (`choosePicture`) are typed where it declares them.
import type {} from "../editor/pictures";
import type { Command, CommandContext } from "./registry";

/** The note's keymap gives a command the Block at the cursor as its focus. */
function noteOf(ctx: CommandContext): Editor | null {
  const editor = ctx.focus?.kind === "block" ? noteHolding(ctx.focus.id) : null;
  return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
}

/**
 * Pictures in a Note (#1937): a picture chosen from the computer, as "/" and
 * the drop of an image file do. The note's own undo (⌘Z) takes it back.
 */
export const pictureCommands: readonly Command[] = [
  {
    id: "picture.insert",
    label: "editor.picture.insert",
    group: "main",
    appliesTo: ["block"],
    reversible: true,
    when: (ctx) => noteOf(ctx) !== null,
    run(ctx) {
      const editor = noteOf(ctx);
      if (editor) editor.commands.choosePicture();
    },
  },
];
