import type { Editor } from "@tiptap/core";
import type { Selection } from "@tiptap/pm/state";

/**
 * Where the cursor is as the page shows it. An arrow key moves the page's cursor at once and the
 * editor's state only once the page says so, a moment later: an editor ending in between, as a tab
 * switch ends it, would keep the place from before the last keys (#3115).
 */
export function shownSelection(editor: Editor): { anchor: number; head: number } {
  const { view } = editor;
  const { anchor, head } = view.state.selection;
  const shown = view.dom.ownerDocument.getSelection();
  const inText = (node: Node | null): node is Node => {
    if (node === null || !view.dom.contains(node)) return false;
    const element = node instanceof Element ? node : node.parentElement;
    const fixed = element?.closest('[contenteditable="false"]');
    return !fixed || !view.dom.contains(fixed);
  };
  if (!shown || !inText(shown.anchorNode) || !inText(shown.focusNode)) return { anchor, head };
  return {
    anchor: view.posAtDOM(shown.anchorNode, shown.anchorOffset),
    head: view.posAtDOM(shown.focusNode, shown.focusOffset),
  };
}

/** Where the cursor was as the focus left the editor: as the page showed it, and as the editor held it. */
export interface CursorAtLeaving {
  shown: { anchor: number; head: number };
  held: Selection;
}

export const cursorAtLeaving = (editor: Editor): CursorAtLeaving => ({
  shown: shownSelection(editor),
  held: editor.state.selection,
});

/**
 * The cursor to keep as the editor ends. The focus leaving it, as ⌘T moves it to make a Note, can
 * take the page's cursor along before the editor's state has caught up with the last keys: then
 * the place the page showed as the focus left counts, unless the editor's own selection has moved
 * since, as a change made while it had no focus moves it.
 */
export function cursorToKeep(
  editor: Editor,
  left: CursorAtLeaving | null,
): { anchor: number; head: number } {
  if (left && !editor.view.hasFocus() && editor.state.selection.eq(left.held)) return left.shown;
  return shownSelection(editor);
}
