/**
 * Places in a note: where Add to note puts an Answer (#201), at the cursor or
 * at the end of the Mind when the cursor isn't in it; and, for a Question
 * asked again in the note (Enter in it), where its Answer is and the line under it.
 */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, type Selection, TextSelection } from "@tiptap/pm/state";
import { ANSWER_BLOCK, BLOCK_ID_ATTRIBUTE, QUESTION_BLOCK } from "../../../core/api";
import { findBlock } from "./blockCommands";

/** Where something goes in: it replaces `from`–`to` (an empty line), or goes in at `from` when they are equal. */
export interface NotePlace {
  from: number;
  to: number;
}

const isEmptyLine = (node: ProseMirrorNode | null | undefined) =>
  node?.type.name === "paragraph" && node.content.size === 0;

/** At `end`, the Mind's or its open tab's (#3414): on its empty last line, or after its last Block. */
function atEnd(doc: ProseMirrorNode, end: number): NotePlace {
  const last = doc.resolve(end).nodeBefore;
  return isEmptyLine(last) && last
    ? { from: end - last.nodeSize, to: end }
    : { from: end, to: end };
}

/**
 * Where Blocks put into the note now go, given the Mind's selection, or null
 * when the cursor isn't in the Mind: at its end then, or the end of the tab
 * shown (`end`). On an empty line they take the line's place; in any other
 * Block they go after the Block, never splitting its text; in a Question,
 * after that Question's Answer.
 */
export function notePlace(
  doc: ProseMirrorNode,
  selection: Selection | null,
  end = doc.content.size,
): NotePlace {
  if (!selection) return atEnd(doc, end);
  const { $to } = selection;
  // Between Blocks, or a whole Block selected: right there, or after it.
  if ($to.depth === 0) {
    const at = selection instanceof NodeSelection ? selection.to : $to.pos;
    return { from: at, to: at };
  }
  const index = $to.index(0);
  const block = doc.child(index);
  const start = $to.before(1);
  const after = start + block.nodeSize;
  if (isEmptyLine(block)) return { from: start, to: after };
  if (block.type.name === QUESTION_BLOCK && index + 1 < doc.childCount) {
    const next = doc.child(index + 1);
    const answers =
      next.type.name === ANSWER_BLOCK && next.attrs.questionId === block.attrs[BLOCK_ID_ATTRIBUTE];
    if (answers) return { from: after + next.nodeSize, to: after + next.nodeSize };
  }
  return { from: after, to: after };
}

/**
 * Resolves once the Answer is in the editor's document (true), or after
 * `timeoutMs` if it never comes (false). The core writes it as it asks, but
 * its change can reach the editor a moment after the reply to the ask.
 */
export function whenAnswerShown(editor: Editor, answerId: string, timeoutMs = 3_000) {
  if (findBlock(editor.state.doc, answerId)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const check = () => {
      if (findBlock(editor.state.doc, answerId)) done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(found: boolean) {
      clearTimeout(timer);
      editor.off("update", check);
      resolve(found);
    }
    editor.on("update", check);
  });
}

/** Puts the cursor at the start of a Block's text, scrolled into view, with the focus in the note. */
export function cursorAtBlock(editor: Editor, blockId: string): boolean {
  const block = findBlock(editor.state.doc, blockId);
  if (!block) return false;
  const { state, view } = editor;
  view.dispatch(
    state.tr.setSelection(TextSelection.near(state.doc.resolve(block.pos + 1))).scrollIntoView(),
  );
  view.focus();
  return true;
}

/**
 * Puts the Mind's cursor on an empty line right after an Answer, adding the
 * line unless one is there already, so what is typed next goes under it. The
 * focus stays where it is.
 */
export function cursorBelowAnswer(editor: Editor, answerId: string): boolean {
  const answer = findBlock(editor.state.doc, answerId);
  if (!answer) return false;
  const after = answer.pos + answer.node.nodeSize;
  const next = editor.state.doc.nodeAt(after);
  return editor.commands.command(({ tr, state }) => {
    if (!isEmptyLine(next)) {
      const paragraph = state.schema.nodes.paragraph?.create();
      if (!paragraph) return false;
      tr.insert(after, paragraph);
    }
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    return true;
  });
}
