import type { Editor } from "@tiptap/core";
import { CALCULATED_FIGURE_NODE } from "../../../core/api";
import { readCalculatedFigureAttributes } from "../../../shared/calculatedFigures";
import { asOneStep, offerEditorUndo } from "./editorUndo";

export function editCalculatedFigure(
  editor: Editor,
  id: string,
  pos: number | undefined,
  convert: boolean,
): boolean {
  if (!editor.isEditable || pos === undefined) return false;
  const node = editor.state.doc.nodeAt(pos);
  const attributes =
    node?.type.name === CALCULATED_FIGURE_NODE ? readCalculatedFigureAttributes(node.attrs) : null;
  if (!node || attributes?.id !== id) return false;
  asOneStep(editor, () => {
    const transaction = editor.state.tr;
    if (convert) transaction.insertText(attributes.figure.shown, pos, pos + node.nodeSize);
    else transaction.delete(pos, pos + node.nodeSize);
    editor.view.dispatch(transaction.scrollIntoView());
  });
  offerEditorUndo(editor, (say) =>
    say(convert ? "figures.inline.converted" : "figures.inline.deleted"),
  );
  editor.view.focus();
  return true;
}
