import type { Editor } from "@tiptap/core";
import { noteHolding } from "../editor/noteKeymap";
import { mindEditor } from "../editor/openEditors";
// The Pictures extension's own commands (`choosePicture`) are typed where it declares them.
import type {} from "../editor/pictures";
import type { Command, CommandContext } from "./registry";

/**
 * The note a command acts on: the Block the keymap's focus is in, or, from ⌘K,
 * the Note in front, whose cursor may be anywhere in it.
 */
function noteOf(ctx: CommandContext): Editor | null {
  const focus = ctx.focus;
  const editor =
    focus?.kind === "block"
      ? noteHolding(focus.id)
      : focus?.kind === "mind"
        ? mindEditor(focus.id)
        : null;
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
    // From the note's keymap, the Block at the cursor; from ⌘K or the Note's own menu, the Note.
    appliesTo: ["block", "mind"],
    reversible: true,
    when: (ctx) => noteOf(ctx) !== null,
    run(ctx) {
      const editor = noteOf(ctx);
      if (editor) editor.commands.choosePicture();
    },
  },
];
