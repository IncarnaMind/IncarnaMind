import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { ANSWER_BLOCK, QUESTION_BLOCK } from "../../../core/api";
import { dialogOrMenuOpen } from "../escapeDismiss";

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
const typed = new WeakMap<
  Editor,
  { from: number; to: number; text: string; anchor: number; head: number }
>();

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
  const { anchor, head } = editor.state.selection;
  editor.view.focus();
  editor.commands.insertContentAt(at, { type: "text", text });
  if (forCommand) typed.set(editor, { from: at, to: at + text.length, text, anchor, head });
}

/** During a palette hand-off, the next key can still be addressed to the page (#2586). */
export function listenForDocumentPickerKeys(
  editor: Editor,
  take: (event: KeyboardEvent) => boolean,
): () => void {
  const view = editor.view;
  const page = view.dom.ownerDocument;
  const onKey = (event: KeyboardEvent) => {
    if (view.composing || event.isComposing || event.keyCode === 229 || event.key === "Process") {
      if (
        view.dom.contains(event.target as Node) &&
        (event.key === "Escape" || event.key === "Enter")
      )
        event.stopPropagation();
      return;
    }
    if (
      event.target !== page.body ||
      page.activeElement !== page.body ||
      event.defaultPrevented ||
      dialogOrMenuOpen()
    )
      return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      view.focus();
      view.dispatch(view.state.tr.insertText(event.key));
    } else if (["Escape", "Enter", "Tab", "ArrowDown", "ArrowUp"].includes(event.key)) {
      view.focus();
      if (!take(event)) return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  page.addEventListener("keydown", onKey, true);
  return () => page.removeEventListener("keydown", onKey, true);
}

/**
 * The picker closed: a trigger a command typed comes out with it, and the words typed after it
 * (up to the picker's `to`), unless the picker's choice already took them out for its chip.
 */
export function takeTypedTrigger(editor: Editor, to: number, cancelled: boolean): void {
  const waiting = typed.get(editor);
  typed.delete(editor);
  if (!waiting || editor.isDestroyed) return;
  const end = Math.min(Math.max(to, waiting.to), editor.state.doc.content.size);
  if (end < waiting.to) return;
  if (!editor.state.doc.textBetween(waiting.from, end).startsWith(waiting.text)) return;
  const tr = editor.state.tr.delete(waiting.from, end);
  if (cancelled) {
    const resolve = (pos: number) => tr.doc.resolve(Math.min(pos, tr.doc.content.size));
    tr.setSelection(TextSelection.between(resolve(waiting.anchor), resolve(waiting.head)));
  }
  editor.view.dispatch(tr);
}
