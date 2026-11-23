import { Extension } from "@tiptap/core";
import { AllSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Chromium can deliver a key before selectionchange after a click (#3414) or a native caret
 * move. Read the visible caret before commands such as opening a link or splitting a paragraph.
 */
export function caretFromPage(view: EditorView): void {
  const { selection } = view.state;
  if (view.composing || !(selection instanceof TextSelection || selection instanceof AllSelection))
    return;
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
  if (selection.empty && selection.from === at) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))));
}

function collapseAll(view: EditorView, event: KeyboardEvent): boolean {
  if (
    !(view.state.selection instanceof AllSelection) ||
    (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.isComposing ||
    view.composing ||
    !view.hasFocus()
  )
    return false;
  const shown = view.dom.ownerDocument.getSelection();
  if (
    !shown ||
    shown.isCollapsed ||
    !view.dom.contains(shown.anchorNode) ||
    !view.dom.contains(shown.focusNode) ||
    typeof shown.modify !== "function"
  )
    return false;
  // The focus redraw can restore Select All before Chromium reports its arrow movement.
  // Let Chromium choose the visual edge (including right-to-left text), then commit it on this key.
  shown.modify("move", event.key === "ArrowLeft" ? "left" : "right", "character");
  return shown.isCollapsed;
}

export const PageCaret = Extension.create({
  name: "pageCaret",
  // Before every other key handler of the editor, and the window's shortcuts after it.
  priority: 10000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const moved = collapseAll(view, event);
            caretFromPage(view);
            return moved;
          },
        },
      }),
    ];
  },
});
