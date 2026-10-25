import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const KEY = new PluginKey<boolean>("heldSelection");

/**
 * Keeps the Mind's selection drawn while the focus is elsewhere (#565).
 * Chromium stops drawing a selection once its field loses the focus, so the
 * selected text is marked instead, in the inactive-selection grey; the
 * stylesheet hides the mark while the editor itself has the focus.
 */
export const HeldSelection = Extension.create({
  name: "heldSelection",

  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: KEY,
        state: {
          init: () => false,
          apply: (tr, held) => (tr.getMeta(KEY) as boolean | undefined) ?? held,
        },
        props: {
          // A press that brings the focus back puts the editor's old selection back into the page
          // before the browser places the caret, so a click or a drag starts nowhere. The press
          // moves the selection to where it landed first.
          handleDOMEvents: {
            mousedown(view, event) {
              if (view.hasFocus() || view.state.selection.empty) return false;
              if (event.button !== 0 || event.shiftKey) return false;
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at) return false;
              const selection = TextSelection.near(view.state.doc.resolve(at.pos));
              view.dispatch(view.state.tr.setSelection(selection).setMeta("addToHistory", false));
              return false;
            },
          },
          decorations(state) {
            const { from, to, empty } = state.selection;
            if (!KEY.getState(state) || empty) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, { class: "held-selection" }),
            ]);
          },
        },
      }),
    ];
  },
});

const holders = new WeakMap<Editor, Set<string>>();

/** Whether `holder` needs the selection drawn when the editor has no focus; it is drawn while any holder does. */
export function holdSelection(editor: Editor, held: boolean, holder = "composer"): void {
  if (editor.isDestroyed) return;
  const all = holders.get(editor) ?? new Set<string>();
  holders.set(editor, all);
  if (held) all.add(holder);
  else all.delete(holder);
  const drawn = all.size > 0;
  if (KEY.getState(editor.state) === drawn) return;
  editor.view.dispatch(editor.state.tr.setMeta(KEY, drawn).setMeta("addToHistory", false));
}
