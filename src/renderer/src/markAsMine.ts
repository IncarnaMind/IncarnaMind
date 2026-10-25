import type { Editor } from "@tiptap/core";
import { markAsMine } from "./editor/aiText";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";

/** Mark as mine (#95) on the editor's selection: one step of its Undo, offered on the undo line. */
export function markSelectionAsMine(editor: Editor): boolean {
  const done = asOneStep(editor, () => markAsMine(editor.state, (tr) => editor.view.dispatch(tr)));
  if (done) offerEditorUndo(editor, (t) => t("aiText.markedAsMine"));
  return done;
}
