import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  INCLUDE_IN_CONTEXT_ATTRIBUTE,
  NOTE_BLOCK_TYPES,
  QUESTION_BLOCK,
} from "../../../core/api";

/** Ends the Undo step being gathered, so the next change starts one of its own. */
const stopUndoCapturing = (state: EditorState) =>
  yUndoPluginKey.getState(state)?.undoManager.stopCapturing();

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blocks: {
      /**
       * Deletes the top-level Block starting at `pos`, or, without `pos`, every
       * top-level Block the selection touches. A Question goes with its Answer.
       */
      deleteBlock: (pos?: number) => ReturnType;
    };
  }
}

interface Range {
  from: number;
  to: number;
}

/** The top-level Block with this ID, and the position just before it. */
export function findBlock(
  doc: ProseMirrorNode,
  id: string,
): { node: ProseMirrorNode; pos: number } | null {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  doc.forEach((node, pos) => {
    if (!found && node.attrs[BLOCK_ID_ATTRIBUTE] === id) found = { node, pos };
  });
  return found;
}

/**
 * Whether your text's Block with this ID is in the Question context, or null for a Block that
 * isn't your text (a Question, an Answer), which has no such flag.
 */
export function contextFlag(editor: Editor, id: string): boolean | null {
  const found = findBlock(editor.state.doc, id);
  if (!found || !(NOTE_BLOCK_TYPES as readonly string[]).includes(found.node.type.name)) {
    return null;
  }
  return found.node.attrs[INCLUDE_IN_CONTEXT_ATTRIBUTE] !== false;
}

/** Puts your text's Block with this ID in the Question context, or out of it, as one Undo step. */
export function setContextFlag(editor: Editor, id: string, included: boolean): void {
  const found = findBlock(editor.state.doc, id);
  if (!found) return;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      // On is the default, so it isn't stored.
      tr.setNodeAttribute(found.pos, INCLUDE_IN_CONTEXT_ATTRIBUTE, included ? null : false);
      return true;
    })
    .run();
}

/** The Answer to the Question with this ID, wherever it is in the Mind. */
function answerTo(doc: ProseMirrorNode, questionId: unknown): Range | null {
  if (typeof questionId !== "string") return null;
  let found: Range | null = null;
  doc.forEach((node, pos) => {
    if (!found && node.type.name === ANSWER_BLOCK && node.attrs.questionId === questionId) {
      found = { from: pos, to: pos + node.nodeSize };
    }
  });
  return found;
}

/**
 * Where a Question and its Answer are together, when the Block at `pos` is
 * either of them and the Answer comes right after its Question: they are
 * dragged as one. Null for any other Block.
 */
export function questionWithAnswer(doc: ProseMirrorNode, pos: number): Range | null {
  const block = blockAt(doc, pos);
  const node = block && doc.nodeAt(block.from);
  if (!block || !node) return null;
  if (node.type.name === QUESTION_BLOCK) {
    const answer = answerTo(doc, node.attrs[BLOCK_ID_ATTRIBUTE]);
    return answer?.from === block.to ? { from: block.from, to: answer.to } : null;
  }
  if (node.type.name === ANSWER_BLOCK) {
    const $before = doc.resolve(block.from);
    const question = $before.nodeBefore;
    if (question?.type.name !== QUESTION_BLOCK) return null;
    if (question.attrs[BLOCK_ID_ATTRIBUTE] !== node.attrs.questionId) return null;
    return { from: block.from - question.nodeSize, to: block.to };
  }
  return null;
}

/** The Answers to the Questions in a range of top-level Blocks that lie outside it. */
function answersOutside(doc: ProseMirrorNode, range: Range): Range[] {
  const answers: Range[] = [];
  doc.nodesBetween(range.from, range.to, (node) => {
    if (node.type.name !== QUESTION_BLOCK) return false;
    const answer = answerTo(doc, node.attrs[BLOCK_ID_ATTRIBUTE]);
    if (answer && (answer.to <= range.from || answer.from >= range.to)) answers.push(answer);
    return false;
  });
  return answers;
}

function blockAt(doc: ProseMirrorNode, pos: number): Range | null {
  if (pos < 0 || pos >= doc.content.size || doc.resolve(pos).depth !== 0) return null;
  const node = doc.nodeAt(pos);
  return node ? { from: pos, to: pos + node.nodeSize } : null;
}

function selectedBlocks({ $from, $to }: Selection): Range | null {
  const from = $from.depth > 0 ? $from.before(1) : $from.pos;
  const to = $to.depth > 0 ? $to.after(1) : $to.pos;
  return from < to ? { from, to } : null;
}

/** Deleting Blocks as a whole: `deleteBlock`, which the "block.delete" command runs (⇧⌘⌫). */
export const BlockCommands = Extension.create({
  name: "blockCommands",

  // A Block dropped where it was dragged is an Undo step of its own, as Turn into
  // is: ⌘Z takes back the move (and the footnote numbers it changed), not the typing before it.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("dropUndoStep"),
        filterTransaction: (transaction, state) => {
          if (transaction.getMeta("uiEvent") === "drop") stopUndoCapturing(state);
          return true;
        },
      }),
    ];
  },

  onTransaction({ transaction }) {
    if (transaction.getMeta("uiEvent") === "drop") stopUndoCapturing(this.editor.state);
  },

  addCommands() {
    return {
      deleteBlock:
        (pos) =>
        ({ state, tr, dispatch }) => {
          const range =
            pos === undefined ? selectedBlocks(state.selection) : blockAt(state.doc, pos);
          if (!range) return false;
          if (dispatch) {
            // A Question's Answer goes with it: an Answer answers exactly one Question.
            const answers = answersOutside(state.doc, range);
            for (const answer of [...answers].sort((a, b) => b.from - a.from)) {
              if (answer.from >= range.to) tr.delete(answer.from, answer.to);
            }
            const empty = state.schema.topNodeType.createAndFill();
            if (range.from === 0 && range.to === tr.doc.content.size && empty) {
              // A Mind always holds a Block: deleting them all leaves an empty paragraph.
              tr.replaceWith(0, tr.doc.content.size, empty.content);
            } else {
              tr.delete(range.from, range.to);
            }
            for (const answer of answers.filter((each) => each.to <= range.from)) {
              tr.delete(tr.mapping.map(answer.from), tr.mapping.map(answer.to));
            }
            const near = Math.min(tr.mapping.map(range.from), tr.doc.content.size);
            tr.setSelection(Selection.near(tr.doc.resolve(near))).scrollIntoView();
          }
          return true;
        },
    };
  },
});
