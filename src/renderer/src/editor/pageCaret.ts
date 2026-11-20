import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * The caret a click left in a selection, read before the key that follows it. A click inside
 * selected words leaves the caret to the page, which tells the editor only after a key pressed
 * at once has been handled: ⌘K then saw the words still selected, as after find's match, and
 * opened the link field instead of ⌘K (#3414, as #2279 does for Shift-click).
 */
export function caretFromPage(view: EditorView): void {
  const { selection } = view.state;
  if (view.composing || selection.empty || !(selection instanceof TextSelection)) return;
  const shown = view.dom.ownerDocument.getSelection();
  const node = shown?.focusNode;
  if (!shown?.isCollapsed || !node || !view.dom.contains(node) || !view.hasFocus()) return;
  let at: number;
  try {
    at = view.posAtDOM(node, shown.focusOffset);
  } catch {
    return;
  }
  if (at < 0 || at > view.state.doc.content.size) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))));
}

export const PageCaret = Extension.create({
  name: "pageCaret",
  // Before every other key handler of the editor, and the window's shortcuts after it.
  priority: 10000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view) {
            caretFromPage(view);
            return false;
          },
        },
      }),
    ];
  },
});
