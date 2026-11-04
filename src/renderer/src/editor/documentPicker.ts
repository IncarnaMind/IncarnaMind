import type { Editor } from "@tiptap/core";
import { ANSWER_BLOCK, QUESTION_BLOCK } from "../../../core/api";

/** Whether the caret is in a Note's own text: not code, a Question or an Answer. */
export function inNoteText(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  if (!$from.parent.inlineContent || $from.parent.type.spec.code) return false;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === ANSWER_BLOCK || name === QUESTION_BLOCK) return false;
  }
  return true;
}

/** A trigger a command typed for the User, still to be taken out if the picker closes unchoosing. */
let typed: { editor: Editor; from: number; to: number; text: string } | null = null;

/**
 * Types the "@" that opens the picker of Documents at `at`, with the space it needs before it:
 * the one way in, from the "/" menu and from ⌘K (#281). `forCommand`: the User didn't type it, so
 * closing the picker without a choice takes it out again.
 */
export function openDocumentPicker(
  editor: Editor,
  at = editor.state.selection.from,
  { forCommand = false } = {},
): void {
  if (!inNoteText(editor)) return;
  const $at = editor.state.doc.resolve(at);
  const before = $at.parent.isTextblock
    ? $at.parent.textBetween(Math.max(0, $at.parentOffset - 1), $at.parentOffset)
    : "";
  const space = before !== "" && !/\s/u.test(before) ? " " : "";
  const text = `${space}@`;
  editor.chain().focus().insertContentAt(at, { type: "text", text }).run();
  typed = forCommand ? { editor, from: at, to: at + text.length, text } : null;
}

/**
 * The picker closed: a trigger a command typed comes out with it, unless the picker's choice
 * already took it out for its chip.
 */
export function takeTypedTrigger(): void {
  const waiting = typed;
  typed = null;
  const editor = waiting?.editor;
  if (!waiting || !editor || editor.isDestroyed) return;
  if (waiting.to > editor.state.doc.content.size) return;
  if (editor.state.doc.textBetween(waiting.from, waiting.to) !== waiting.text) return;
  editor.chain().focus().deleteRange({ from: waiting.from, to: waiting.to }).run();
}
