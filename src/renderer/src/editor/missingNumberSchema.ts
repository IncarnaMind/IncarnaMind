import { type Editor, mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { MISSING_NUMBER_NODE } from "../../../core/api";

export interface MissingNumberOptions {
  view: NodeViewRenderer | null;
  /** The mark's words, "[number missing]", in the interface language. */
  words: () => string;
}

const isMark = (node: ProseMirrorNode | null | undefined) =>
  node?.type.name === MISSING_NUMBER_NODE;

/**
 * The arrows step over the mark as over one character, and Shift with an arrow selects it, as one
 * thing the User can't edit inside (#2577).
 */
function step(editor: Editor, direction: 1 | -1, extend: boolean): boolean {
  const { state } = editor;
  const { selection, doc } = state;
  if (selection instanceof NodeSelection) {
    if (!isMark(selection.node)) return false;
    const { $from, $to } = selection;
    const moved = !extend
      ? TextSelection.create(doc, direction > 0 ? selection.to : selection.from)
      : direction > 0
        ? TextSelection.create(doc, selection.from, Math.min(selection.to + 1, $to.end()))
        : TextSelection.create(doc, selection.to, Math.max(selection.from - 1, $from.start()));
    editor.view.dispatch(state.tr.setSelection(moved));
    return true;
  }
  if (!extend && !selection.empty) return false;
  const $head = selection.$head;
  if (!isMark(direction > 0 ? $head.nodeAfter : $head.nodeBefore)) return false;
  const past = $head.pos + direction;
  const moved =
    extend && selection.empty
      ? NodeSelection.create(doc, Math.min($head.pos, past))
      : TextSelection.create(doc, extend ? selection.anchor : past, past);
  editor.view.dispatch(state.tr.setSelection(moved));
  return true;
}

/** Backspace after the mark, or Delete before it, takes it out whole. */
function remove(editor: Editor, direction: 1 | -1): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;
  const $head = selection.$head;
  if (!isMark(direction > 0 ? $head.nodeAfter : $head.nodeBefore)) return false;
  const from = direction > 0 ? $head.pos : $head.pos - 1;
  editor.view.dispatch(state.tr.delete(from, from + 1).scrollIntoView());
  return true;
}

/**
 * Where a figure couldn't be calculated (#2577): "[number missing]", an inline atom with no
 * attributes, in the can't-check look. Copied, it is its words.
 */
export const MissingNumber = Node.create<MissingNumberOptions>({
  name: MISSING_NUMBER_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  // Before the base keymap, which would leave the arrows and Backspace to the browser.
  priority: 1000,

  addOptions() {
    return { view: null, words: () => "[number missing]" };
  },

  parseHTML() {
    return [{ tag: `span[data-type="${MISSING_NUMBER_NODE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-type": MISSING_NUMBER_NODE }),
      this.options.words(),
    ];
  },

  renderText() {
    return this.options.words();
  },

  addNodeView() {
    return this.options.view;
  },

  addKeyboardShortcuts() {
    return {
      ArrowRight: ({ editor }) => step(editor, 1, false),
      ArrowLeft: ({ editor }) => step(editor, -1, false),
      "Shift-ArrowRight": ({ editor }) => step(editor, 1, true),
      "Shift-ArrowLeft": ({ editor }) => step(editor, -1, true),
      Backspace: ({ editor }) => remove(editor, -1),
      Delete: ({ editor }) => remove(editor, 1),
    };
  },
});
