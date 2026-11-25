import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { CITATION_NODE } from "../../../core/api";
import { notifyShiftPressTaken } from "./peek";

/**
 * Where the User's selection is: what the page shows, while it shows a
 * selection, else the editor's own. A press can follow the click that made the
 * selection by a few milliseconds, before the editor has read it, so the page
 * speaks first, and its range is the one extended; a caret on the page is
 * nothing to extend, though the editor's selection can lag behind it (#2279).
 *
 * @returns null when there is no selection to extend.
 */
function selectionRange(view: EditorView): {
  from: number;
  to: number;
  anchor: number;
} | null {
  const chosen = view.dom.ownerDocument.getSelection();
  const node = chosen?.anchorNode;
  const focus = chosen?.focusNode;
  if (chosen && node && focus && view.dom.contains(node) && view.dom.contains(focus)) {
    // A caret is nothing to extend, and the editor's own selection can lag behind the click
    // that left it, so it is not asked when the page shows a caret (#2279).
    if (chosen.isCollapsed) return null;
    try {
      const anchor = view.posAtDOM(node, chosen.anchorOffset);
      const head = view.posAtDOM(focus, chosen.focusOffset);
      return { from: Math.min(anchor, head), to: Math.max(anchor, head), anchor };
    } catch {
      // Not positions the editor knows: its own selection speaks for it.
    }
  }
  const { selection } = view.state;
  return selection.empty
    ? null
    : { from: selection.from, to: selection.to, anchor: selection.anchor };
}

/** The table cell that holds `pos`, by its position, or null outside a table. */
function cellAt(view: EditorView, pos: number): number | null {
  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === "tableCell" || name === "tableHeader") return $pos.before(depth);
  }
  return null;
}

/**
 * Where a press on a Citation's marker ends: the Citation's far side from where
 * the selection starts, which is the side the marker covers whatever half of it
 * the pointer lands on.
 *
 * @returns null when the press is not on a marker, or the Citation isn't found.
 */
function markerEnd(view: EditorView, event: MouseEvent, start: number): number | null {
  if (!(event.target instanceof Element) || !event.target.closest("[data-testid='citation']")) {
    return null;
  }
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return null;
  for (const pos of at.inside >= 0 ? [at.inside] : [at.pos, at.pos - 1]) {
    const node = pos >= 0 ? view.state.doc.nodeAt(pos) : null;
    if (node?.type.name !== CITATION_NODE) continue;
    return start <= pos ? pos + node.nodeSize : pos;
  }
  return null;
}

/**
 * Views whose last pointer press on a Citation marker was taken to extend the selection.
 * Extending a selection across a Citation can wrap it in an inline decoration (such as
 * `HeldSelection`), which unmounts and remounts the marker's React node view mid-press;
 * keeping this on the view survives the remount so the new marker ignores the browser's
 * synthetic post-remount `pointerover` (even after Shift is released) and any click from
 * that press until the pointer leaves or another press occurs (#3697).
 */
const takenMarkerPress = new WeakSet<EditorView>();

/** Whether the last marker press on `view` was taken by Shift-selection and has not ended. */
export const hasTakenMarkerPress = (view: EditorView): boolean => takenMarkerPress.has(view);

/** Clears the taken-marker-press suppression for `view` once the pointer leaves or presses anew. */
export const clearTakenMarkerPress = (view: EditorView): void => {
  takenMarkerPress.delete(view);
};

/** Whether the editor has a non-empty selection that a Shift-press would extend. */
export function hasSelectionToExtend(view: EditorView): boolean {
  const chosen = view.dom.ownerDocument.getSelection();
  const node = chosen?.anchorNode;
  const focus = chosen?.focusNode;
  if (chosen && node && focus && view.dom.contains(node) && view.dom.contains(focus)) {
    return !chosen.isCollapsed;
  }
  return !view.state.selection.empty;
}

/**
 * Copies a non-collapsed page selection into ProseMirror on pointer release.
 * Chromium defers `selectionchange` to the next rendering update; if ProseMirror's
 * focus handler's 20 ms timer fires first after a click into an unfocused editor, it
 * restores the stale selection and wipes the new double-click or drag (#3697).
 * A collapsed DOM selection is never copied here: during a drag, an inline decoration
 * (such as `HeldSelection`) can wrap the selected text while ProseMirror's `LeftMouseDown`
 * defers `selectionToDOM` (`delaySelUpdate`), temporarily collapsing `getSelection()` to
 * `(paragraph, 0)` until `LeftMouseDown.done()` restores the dragged range after `mouseup`.
 */
export function syncSelectionFromDOM(view: EditorView): boolean {
  if (view.isDestroyed || view.composing || !view.hasFocus()) return false;
  if (!(view.state.selection instanceof TextSelection)) return false;
  const chosen = view.dom.ownerDocument.getSelection();
  const node = chosen?.anchorNode;
  const focus = chosen?.focusNode;
  if (
    !chosen ||
    chosen.isCollapsed ||
    !node ||
    !focus ||
    !view.dom.contains(node) ||
    !view.dom.contains(focus)
  ) {
    return false;
  }
  let anchor: number;
  let head: number;
  try {
    anchor = view.posAtDOM(node, chosen.anchorOffset);
    head = view.posAtDOM(focus, chosen.focusOffset);
  } catch {
    return false;
  }
  const { doc, selection } = view.state;
  if (anchor < 0 || head < 0 || anchor > doc.content.size || head > doc.content.size) {
    return false;
  }
  const next = TextSelection.between(doc.resolve(anchor), doc.resolve(head), 1);
  if (next.empty || selection.eq(next)) return false;
  view.dispatch(
    view.state.tr.setSelection(next).setMeta("pointer", true).setMeta("addToHistory", false),
  );
  return true;
}

/**
 * Extends the selection to where a Shift-press landed, as Shift+arrows does
 * (#2279). Left to the browser, the extension carries the granularity of the
 * selection the User last made: after a double-click that is a word, so a click
 * just past a Citation snaps back to the word before it and the Citation stays
 * unselected. A press outside the selection keeps its far end, as the browser
 * and Shift+arrows do.
 *
 * @returns whether the press was a Shift-press with something to extend, and
 * so was taken.
 */
export function extendSelectionTo(view: EditorView, event: MouseEvent): boolean {
  // A press something nearer has taken, such as a comparison cell's own range selection.
  if (event.defaultPrevented) return false;
  if (event.button !== 0 || !event.shiftKey) return false;
  const range = selectionRange(view);
  if (!range) return false;
  const { from, to, anchor } = range;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return false;
  const head =
    markerEnd(view, event, anchor) ?? Math.max(0, Math.min(at.pos, view.state.doc.content.size));
  // A press in another table cell is the table's own: it selects a range of cells.
  if (cellAt(view, head) !== cellAt(view, from)) return false;
  if (!view.hasFocus()) view.focus();
  const { doc } = view.state;
  const fixed = head < from ? to : head > to ? from : anchor;
  const next = TextSelection.between(doc.resolve(fixed), doc.resolve(head), 1);
  // ProseMirror skips `selectionToDOM` when `next` equals `view.state.selection`. If a quick
  // double-click updated the DOM before `selectionchange` reached ProseMirror, the stale state
  // can already equal `next` from an earlier selection, leaving the page unextended (#3697).
  if (view.state.selection.eq(next)) {
    const page = TextSelection.between(
      doc.resolve(anchor),
      doc.resolve(anchor === from ? to : from),
      1,
    );
    if (!page.eq(next)) {
      view.dispatch(
        view.state.tr.setSelection(page).setMeta("pointer", true).setMeta("addToHistory", false),
      );
    }
  }
  view.dispatch(
    view.state.tr.setSelection(next).setMeta("pointer", true).setMeta("addToHistory", false),
  );
  event.preventDefault();
  return true;
}

/**
 * A Shift-press in a Note's text extends the selection to the point pressed,
 * as Shift+arrows does, rather than by the browser's own rule (see
 * `extendSelectionTo`).
 */
export const ShiftClickSelection = Extension.create({
  name: "shiftClickSelection",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => {
          // A Citation's marker takes a press of its own inside its node view before ProseMirror
          // hears it, so a Shift-press on it is taken here, ahead of that.
          const onMarkerPress = (event: MouseEvent) => {
            if (!(event.target instanceof Element)) return;
            const citation = event.target.closest("[data-testid='citation']");
            if (!citation) return;
            const chip = citation.querySelector("[data-testid='citation-chip']");
            if (extendSelectionTo(view, event)) {
              takenMarkerPress.add(view);
              if (chip) notifyShiftPressTaken(chip);
            } else {
              takenMarkerPress.delete(view);
            }
          };
          const onRelease = (event: MouseEvent) => {
            if (
              event.button === 0 &&
              !event.defaultPrevented &&
              (event.detail >= 2 || view.state.selection.empty)
            ) {
              syncSelectionFromDOM(view);
            }
          };
          view.dom.addEventListener("mousedown", onMarkerPress, true);
          view.dom.addEventListener("mouseup", onRelease);
          return {
            destroy: () => {
              view.dom.removeEventListener("mousedown", onMarkerPress, true);
              view.dom.removeEventListener("mouseup", onRelease);
            },
          };
        },
        props: {
          handleDOMEvents: {
            mousedown: (view, event) => {
              // A marker press is taken in capture, above, before the Citation's node view and
              // ProseMirror's own press handling can change the selection.
              if (
                event.target instanceof Element &&
                event.target.closest("[data-testid='citation']")
              ) {
                return false;
              }
              return extendSelectionTo(view, event);
            },
          },
        },
      }),
    ];
  },
});
