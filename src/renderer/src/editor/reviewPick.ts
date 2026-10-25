import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** A part of what the reviewing pane's selected card is: a run of words, or a node (a Block, a comment's mark). */
export interface PickedRange {
  from: number;
  to: number;
  node?: true;
}

const reviewPickKey = new PluginKey<DecorationSet>("reviewPick");

/**
 * The change or comment the reviewing pane's selected card is (#697), washed
 * in the text as the change the cursor is in is, without moving the cursor:
 * the focus stays in the pane while ↑ and ↓ go through it.
 */
export const ReviewPick = Extension.create({
  name: "reviewPick",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: reviewPickKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const picked = tr.getMeta(reviewPickKey) as readonly PickedRange[] | undefined;
            if (!picked) return set.map(tr.mapping, tr.doc);
            const size = tr.doc.content.size;
            return DecorationSet.create(
              tr.doc,
              picked
                .filter((range) => range.from < range.to && range.to <= size)
                .map((range) =>
                  range.node
                    ? Decoration.node(range.from, range.to, { class: "review-picked" })
                    : Decoration.inline(range.from, range.to, { class: "review-picked" }),
                ),
            );
          },
        },
        props: { decorations: (state) => reviewPickKey.getState(state) ?? null },
      }),
    ];
  },
});

export function pickInMind(editor: Editor, picked: readonly PickedRange[]): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(reviewPickKey, picked));
}

// The count and the check badge fade the text at the page's foot.
const FOOT_PX = 48;

/**
 * Scrolls the Mind so a range shows whole, a third of the way down, or, when
 * it is taller than the view, from its start; unless it already shows. At
 * once, as the cursor's own scrolling is.
 */
export function scrollMindTo(editor: Editor, from: number, to = from): void {
  if (editor.isDestroyed) return;
  const scroller = editor.view.dom.closest<HTMLElement>(".mind-scroller");
  if (!scroller) return;
  const size = editor.state.doc.content.size;
  const start = editor.view.coordsAtPos(Math.min(Math.max(from, 0), size));
  const end = editor.view.coordsAtPos(Math.min(Math.max(to, from, 0), size));
  const box = scroller.getBoundingClientRect();
  // The bar of changes stays at the Mind's top as it scrolls: a change under it doesn't show.
  const covered =
    editor.view.dom.closest(".mind-editor-frame")?.querySelector(".proposals-bar")?.clientHeight ??
    0;
  const top = box.top + covered;
  const bottom = box.bottom - FOOT_PX;
  if (start.top >= top && end.bottom <= bottom) return;
  const room = bottom - top;
  const height = end.bottom - start.top;
  const above = height < room ? (room - height) / 3 : 0;
  scroller.scrollTop += start.top - top - above;
}
