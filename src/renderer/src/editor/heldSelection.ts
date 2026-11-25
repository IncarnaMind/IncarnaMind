import { type Editor, Extension } from "@tiptap/core";
import { AllSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { CITATION_NODE } from "../../../core/api";

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
          // A press that brings the focus back lets ProseMirror's focus timer restore the old
          // selection or caret before `selectionchange` arrives (#3697), so a click, double-click
          // or drag starts from the wrong place. Move the selection to where it landed first.
          handleDOMEvents: {
            mousedown(view, event) {
              if (view.hasFocus()) return false;
              if (event.button !== 0 || event.shiftKey || event.defaultPrevented) return false;
              if (
                event.target instanceof Element &&
                event.target.closest('[contenteditable="false"], button, a, input, textarea')
              ) {
                return false;
              }
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at) return false;
              const selection = TextSelection.near(view.state.doc.resolve(at.pos));
              if (view.state.selection.eq(selection)) return false;
              view.dispatch(view.state.tr.setSelection(selection).setMeta("addToHistory", false));
              return false;
            },
          },
          decorations(state) {
            const { selection } = state;
            const { from, to, empty } = selection;
            if (empty) return DecorationSet.empty;
            const marks: Decoration[] = [];
            if (KEY.getState(state)) {
              marks.push(Decoration.inline(from, to, { class: "held-selection" }));
            }
            // The browser draws no selection over a Citation's marker, which can't be selected as
            // text, so the stylesheet is told which ones this selection covers.
            if (selection instanceof TextSelection || selection instanceof AllSelection) {
              state.doc.nodesBetween(from, to, (node, pos) => {
                if (node.type.name === CITATION_NODE && pos >= from && pos + node.nodeSize <= to) {
                  marks.push(
                    Decoration.node(pos, pos + node.nodeSize, { class: "citation-in-selection" }),
                  );
                }
              });
            }
            return marks.length === 0
              ? DecorationSet.empty
              : DecorationSet.create(state.doc, marks);
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
