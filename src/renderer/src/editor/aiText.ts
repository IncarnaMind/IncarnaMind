import { Mark } from "@tiptap/core";
import type { MarkType, Mark as ProseMirrorMark } from "@tiptap/pm/model";
import {
  type Command,
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { ANSWER_BLOCK, GENERATED_MARK } from "../../../core/api";

/**
 * AI text (`GENERATED_MARK`), drawn in the Answer's ink, a step softer than
 * the User's. Copied and pasted inside IncarnaMind it stays AI text, so
 * moving it isn't a way to make it the User's; text pasted from elsewhere
 * never is.
 */
export const Generated = Mark.create({
  name: GENERATED_MARK,
  // Above the link's 1000: the outermost of a word's marks, so a link's, a change's or code's own look shows inside.
  priority: 1001,
  inclusive: false,
  parseHTML: () => [{ tag: "span[data-generated]" }],
  renderHTML: () => ["span", { "data-generated": "", class: "generated-text" }, 0],

  addProseMirrorPlugins() {
    return [ownTyping(this.type)];
  },
});

/**
 * Keeps what the User types out of AI text, wherever they type in it:
 * - at a cursor, the marks the next input takes (ProseMirror's stored marks)
 *   never hold the mark: keys, and an input method's text, whose composition
 *   starts in those marks so nothing is redrawn under it;
 * - an input method starting over selected AI text deletes the selection
 *   first, as ProseMirror does for a cursor in marks, so it composes at a cursor;
 * - text the User put in otherwise (typed over a selection, a spelling fix)
 *   has the mark taken off once it is in.
 * What comes from the Mind's document (another window, Undo), a paste or a
 * drop keeps its marks.
 */
function ownTyping(type: MarkType): Plugin {
  const holdsMark = (marks: readonly ProseMirrorMark[] | null) => !!marks && !!type.isInSet(marks);
  return new Plugin({
    key: new PluginKey("ownTyping"),
    appendTransaction(transactions, _before, state) {
      const tr = state.tr;
      for (const [from, to] of typedRanges(transactions, type)) tr.removeMark(from, to, type);
      const { selection } = tr;
      const marks = tr.storedMarks ?? (selection.empty ? selection.$from.marks() : null);
      if (selection instanceof TextSelection && selection.empty && holdsMark(marks)) {
        tr.setStoredMarks(type.removeFromSet(marks ?? []));
      }
      return tr.docChanged || tr.storedMarksSet ? tr : null;
    },
    props: {
      handleDOMEvents: {
        compositionstart(view) {
          // From the page's selection: ProseMirror's may not have caught up with the last key yet.
          const selected = view.dom.ownerDocument.getSelection();
          const { anchorNode, focusNode } = selected ?? {};
          if (!selected || selected.isCollapsed || !anchorNode || !focusNode) return false;
          if (!view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return false;
          const selection = TextSelection.create(
            view.state.doc,
            view.posAtDOM(anchorNode, selected.anchorOffset),
            view.posAtDOM(focusNode, selected.focusOffset),
          );
          if (!selection.empty && holdsMark(selection.$from.marksAcross(selection.$to))) {
            view.dispatch(view.state.tr.setSelection(selection).deleteSelection());
          }
          return false;
        },
      },
    },
  });
}

/**
 * Where the User's own transactions put in text under the mark, in the
 * document as it is after them: not those from the Mind's document, a paste,
 * a drop or an input method's composition.
 */
function typedRanges(transactions: readonly Transaction[], type: MarkType): [number, number][] {
  const ranges: [number, number][] = [];
  transactions.forEach((tr, index) => {
    if (!tr.docChanged || tr.getMeta(ySyncPluginKey) || tr.getMeta("uiEvent")) return;
    if (tr.getMeta("composition") !== undefined) return;
    tr.steps.forEach((step, at) => {
      if (!(step instanceof ReplaceStep)) return;
      const { content } = step.slice;
      let text = content.childCount > 0;
      let marked = false;
      content.forEach((node) => {
        text &&= node.isText;
        marked ||= !!type.isInSet(node.marks);
      });
      if (!text || !marked) return;
      const later = [
        tr.mapping.slice(at + 1),
        ...transactions.slice(index + 1).map((each) => each.mapping),
      ];
      ranges.push([
        later.reduce((pos, mapping) => mapping.map(pos, 1), step.from),
        later.reduce((pos, mapping) => mapping.map(pos, -1), step.from + content.size),
      ]);
    });
  });
  return ranges.filter(([from, to]) => from < to);
}

const isOlderAnswer = (attrs: Record<string, unknown>) => attrs.generatedMarks !== true;

/**
 * Whether the selection holds AI text: words under the mark, or words of an
 * older Answer, which is AI text as a whole.
 */
export function holdsAiText(state: EditorState): boolean {
  const type = state.schema.marks[GENERATED_MARK];
  const { from, to, empty } = state.selection;
  if (!type || empty) return false;
  let found = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (node.type.name === ANSWER_BLOCK && isOlderAnswer(node.attrs)) {
      const start = Math.max(from, pos + 1);
      const end = Math.min(to, pos + node.nodeSize - 1);
      found = start < end && state.doc.textBetween(start, end).trim() !== "";
      return false;
    }
    if (node.isText && type.isInSet(node.marks)) found = true;
    return !found;
  });
  return found;
}

/**
 * Makes the AI text in `from`..`to` the User's, in `tr`. An older Answer it
 * touches has its words marked first, so only that stretch changes hands and
 * the rest stays AI text.
 */
export function makeMine(state: EditorState, tr: Transaction, from: number, to: number): void {
  const type = state.schema.marks[GENERATED_MARK];
  if (!type) return;
  // Answers are top-level Blocks only.
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === ANSWER_BLOCK && isOlderAnswer(node.attrs)) {
      tr.setNodeAttribute(pos, "generatedMarks", true);
      node.descendants((child, at) => {
        const start = pos + 1 + at;
        if (child.isText) tr.addMark(start, start + child.nodeSize, type.create());
      });
    }
    return false;
  });
  tr.removeMark(from, to, type);
}

/** "Mark as mine": the AI text selected becomes the User's (`makeMine`). */
export const markAsMine: Command = (state, dispatch) => {
  if (!holdsAiText(state)) return false;
  if (!dispatch) return true;
  const { from, to } = state.selection;
  const tr = state.tr;
  makeMine(state, tr, from, to);
  dispatch(tr);
  return true;
};
