import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Where the User's selection starts: what the page shows, while the editor
 * holds it, else where the editor's own selection starts. A press can follow
 * the click that made the selection by a few milliseconds, before the editor
 * has read it, and the page is what the User is extending from then (#2279).
 *
 * @returns null when there is no selection to extend.
 */
function selectionStart(view: EditorView): number | null {
  const chosen = view.dom.ownerDocument.getSelection();
  const node = chosen?.anchorNode;
  if (chosen?.type === "Range" && node && view.dom.contains(node)) {
    try {
      return view.posAtDOM(node, chosen.anchorOffset);
    } catch {
      // Not a position the editor knows: its own selection speaks for it.
    }
  }
  return view.state.selection.empty ? null : view.state.selection.anchor;
}

/**
 * Extends the selection to where a Shift-press landed, from where it started,
 * as Shift+arrows does (#2279). Left to the browser, the extension carries the
 * granularity of the selection the User last made: after a double-click that
 * is a word, so a click just past a Citation snaps back to the word before it
 * and the Citation stays unselected.
 *
 * @returns whether the press was a Shift-press with something to extend, and
 * so was taken.
 */
export function extendSelectionTo(view: EditorView, event: MouseEvent): boolean {
  // A press something nearer has taken, such as a comparison cell's own range selection.
  if (event.defaultPrevented) return false;
  if (event.button !== 0 || !event.shiftKey) return false;
  const start = selectionStart(view);
  if (start === null) return false;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return false;
  if (!view.hasFocus()) view.focus();
  const { doc } = view.state;
  const head = Math.max(0, Math.min(at.pos, doc.content.size));
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.between(doc.resolve(start), doc.resolve(head), 1))
      .setMeta("pointer", true)
      .setMeta("addToHistory", false),
  );
  event.preventDefault();
  return true;
}

/**
 * A Shift-press in a Note's text extends the selection to the point pressed,
 * as Shift+arrows does, rather than by the browser's own rule (see
 * `extendSelectionTo`). A Citation's marker takes its own press before
 * ProseMirror hears it, so the marker calls this too (`CitationView`).
 */
export const ShiftClickSelection = Extension.create({
  name: "shiftClickSelection",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown: (view, event) => extendSelectionTo(view, event),
          },
        },
      }),
    ];
  },
});
