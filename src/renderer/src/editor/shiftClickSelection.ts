import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Extends the selection to where a Shift-press landed, from where the
 * selection started, as Shift+arrows does (#2279). Left to the browser, the
 * extension carries the granularity of the selection the User last made: after
 * a double-click that is a word, so a click just past a Citation snaps back to
 * the word before it and the Citation stays unselected.
 *
 * @returns whether the press was a Shift-press with something to extend, and
 * so was taken.
 */
export function extendSelectionTo(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0 || !event.shiftKey) return false;
  const { selection } = view.state;
  // Nothing to extend from: the browser's caret extension is right.
  if (selection.empty) return false;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return false;
  if (!view.hasFocus()) view.focus();
  const { doc } = view.state;
  view.dispatch(
    view.state.tr
      .setSelection(
        TextSelection.create(doc, selection.anchor, Math.max(0, Math.min(at.pos, doc.content.size))),
      )
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
