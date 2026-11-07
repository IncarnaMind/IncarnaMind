import type { Editor } from "@tiptap/core";
import { noteHolding } from "../editor/noteKeymap";
// The Pictures extension's own commands (`choosePicture`) are typed where it declares them.
import type {} from "../editor/pictures";
import {
  openPictureFromEditor,
  selectedPictureAt,
  usePictureViewer,
  viewerActions,
} from "../pictureViewer";
import { noteToWrite } from "./handles";
import type { Command, CommandContext } from "./registry";

/**
 * The note a command acts on: the Block the keymap's focus is in, or, from ⌘K,
 * the Note the User last wrote in, whose cursor may be anywhere in it. A
 * picture selected in the Note is the mind's selection, with no focus.
 */
function noteOf(ctx: CommandContext): Editor | null {
  const ref =
    ctx.focus ??
    ctx.selection.find(
      (each) => each.kind === "block" || each.kind === "answer" || each.kind === "mind",
    ) ??
    null;
  if (ref?.kind === "block" || ref?.kind === "answer") {
    const editor = noteHolding(ref.id);
    return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
  }
  return ref?.kind === "mind" ? noteToWrite(ctx) : null;
}

/**
 * Pictures in a Note (#1937): a picture chosen from the computer, as "/" and
 * the drop of an image file do, and the selected picture at full size
 * (#2377), which a double-click and Space also open. The note's own undo (⌘Z)
 * takes an insert back.
 */
export const pictureCommands: readonly Command[] = [
  {
    id: "picture.insert",
    label: "editor.picture.insert",
    group: "main",
    // From the note's keymap, the Block at the cursor; from ⌘K or the Note's own menu, the Note.
    appliesTo: ["block", "mind"],
    // It opens the system's file picker, which the assistant can't answer: the User does.
    assistant: false,
    reversible: true,
    when: (ctx) => noteOf(ctx) !== null,
    run(ctx) {
      const editor = noteOf(ctx);
      if (editor) editor.commands.choosePicture();
    },
  },
  {
    id: "picture.open",
    label: "editor.picture.open",
    keywords: ["editor.picture.openKeywords"],
    group: "open",
    // From ⌘K the focus is the Note in front or the Answer whose picture is selected.
    appliesTo: ["block", "mind", "answer"],
    assistant: false,
    reversible: true,
    when(ctx) {
      const editor = noteOf(ctx);
      return editor !== null && selectedPictureAt(editor) !== null;
    },
    run(ctx) {
      const editor = noteOf(ctx);
      const at = editor && selectedPictureAt(editor);
      if (editor && at !== null) openPictureFromEditor(editor, at);
    },
  },
  {
    id: "picture.copy",
    label: "menu.copy",
    shortcut: { keys: "CmdOrCtrl+C", outsideText: true },
    palette: false,
    group: "main",
    assistant: false,
    reversible: true,
    when: () => usePictureViewer.getState().target !== null,
    run: () => viewerActions.copy(),
  },
];
