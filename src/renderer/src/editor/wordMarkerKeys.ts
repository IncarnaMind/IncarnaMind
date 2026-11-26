import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { WORD_ATOM_NODE } from "../../../core/api";
import { INVISIBLE_WORD_ATOMS, readWordAtom } from "../../../shared/wordFiles";

/** A Word file's marker that shows nothing, such as where a bookmark starts or ends. */
const unseen = (node: ProseMirrorNode) =>
  node.type.name === WORD_ATOM_NODE && INVISIBLE_WORD_ATOMS.has(readWordAtom(node.attrs).kind);

/** Whether a marker ends what it marks ("w:bookmarkEnd#3"), rather than starting it. */
const ends = (node: ProseMirrorNode) => /End(?:#|$)/.test(readWordAtom(node.attrs).source ?? "");

interface WordMarkerKeysStorage {
  /** While Enter splits a line it moved the cursor to the start of: put it back past the markers. */
  movedToStart: boolean;
}

/**
 * Enter beside a Word file's unseen markers splits on the side that keeps each with the words it
 * marks: a click at the start of a clause puts the cursor after where its bookmark starts, and
 * Enter there would leave the bookmark a cross-reference names on the new line before the clause,
 * where Word keeps it with the clause (#746). An arrow can select a marker, which Enter would
 * otherwise delete.
 */
export const WordMarkerKeys = Extension.create<object, WordMarkerKeysStorage>({
  name: "wordMarkerKeys",
  // Before Enter splits the Block.
  priority: 1000,

  addStorage() {
    return { movedToStart: false };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state, view } = editor;
        const { selection } = state;
        const marker =
          selection instanceof NodeSelection && unseen(selection.node) ? selection.node : null;
        if (!selection.empty && !marker) return false;
        const { $from, $to } = selection;
        const line = $from.parent;
        if (!line.isTextblock) return false;
        let shownBefore = false;
        let shownAfter = false;
        line.forEach((child, offset) => {
          if (unseen(child)) return;
          if (offset < $from.parentOffset) shownBefore = true;
          if (offset + child.nodeSize > $to.parentOffset) shownAfter = true;
        });
        let at: number | null = null;
        if (!shownBefore && (marker || $from.parentOffset > 0)) at = $from.start();
        else if (!shownAfter && (marker || $to.parentOffset < line.content.size)) at = $from.end();
        else if (marker) at = ends(marker) ? $to.pos : $from.pos;
        if (at === null) return false;
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)));
        if (at === $from.start()) {
          const storage = this.storage;
          storage.movedToStart = true;
          // The split comes in this same key press, or not at all.
          queueMicrotask(() => {
            storage.movedToStart = false;
          });
        }
        // Enter as anywhere else splits the Block where the cursor is now.
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        // The cursor goes on in front of the words, past the markers that start them, where a
        // click there puts it.
        appendTransaction(transactions, _before, state) {
          if (!storage.movedToStart || !transactions.some((each) => each.docChanged)) return null;
          storage.movedToStart = false;
          const { $head, empty } = state.selection;
          if (!empty || $head.parentOffset !== 0) return null;
          let past = $head.pos;
          $head.parent.forEach((child, offset) => {
            if (offset === past - $head.start() && unseen(child) && !ends(child))
              past += child.nodeSize;
          });
          return past === $head.pos
            ? null
            : state.tr.setSelection(TextSelection.create(state.doc, past));
        },
      }),
    ];
  },
});
