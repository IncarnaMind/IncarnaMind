import { Extension, isMacOS } from "@tiptap/core";
import { AllSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Chromium can deliver a key before selectionchange after a click (#3414) or a native caret
 * move. Read the visible caret before commands such as opening a link or splitting a paragraph.
 */
export function caretFromPage(view: EditorView): boolean {
  const { selection } = view.state;
  if (view.composing || !(selection instanceof TextSelection || selection instanceof AllSelection))
    return false;
  const shown = view.dom.ownerDocument.getSelection();
  const node = shown?.focusNode;
  if (!shown?.isCollapsed || !node || !view.dom.contains(node) || !view.hasFocus()) return false;
  let at: number;
  try {
    at = view.posAtDOM(node, shown.focusOffset);
  } catch {
    return false;
  }
  if (at < 0 || at > view.state.doc.content.size) return false;
  if (selection.empty && selection.from === at) return true;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))));
  return true;
}

function movement(
  selection: EditorView["state"]["selection"],
  event: KeyboardEvent,
): readonly [direction: string, granularity: string] | null {
  if (event.shiftKey || event.altKey) return null;
  if (selection instanceof AllSelection && !event.ctrlKey && !event.metaKey) {
    if (event.key === "ArrowLeft") return ["left", "character"];
    if (event.key === "ArrowRight") return ["right", "character"];
  }
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const mac = isMacOS();
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  if (event.key === (mac ? "ArrowUp" : "Home")) return ["backward", "documentboundary"];
  if (event.key === (mac ? "ArrowDown" : "End")) return ["forward", "documentboundary"];
  return null;
}

function moveOnKey(view: EditorView, event: KeyboardEvent): boolean {
  if (view.composing) return false;
  const move = movement(view.state.selection, event);
  if (!move || !view.hasFocus()) return false;
  const shown = view.dom.ownerDocument.getSelection();
  if (
    !shown ||
    shown.isCollapsed !== view.state.selection.empty ||
    !view.dom.contains(shown.anchorNode) ||
    !view.dom.contains(shown.focusNode) ||
    typeof shown.modify !== "function"
  )
    return false;
  // A focus redraw can restore the old selection before Chromium reports the native key's move.
  shown.modify("move", ...move);
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
            if (event.isComposing) return false;
            const moved = moveOnKey(view, event);
            return caretFromPage(view) && moved;
          },
        },
      }),
    ];
  },
});
