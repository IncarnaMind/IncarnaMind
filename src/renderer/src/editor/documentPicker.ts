import type { Editor } from "@tiptap/core";

/**
 * Types the "@" that opens the picker of Documents at `at`, with the space it
 * needs before it: the one way in, from the "/" menu and from ⌘K (#281).
 */
export function openDocumentPicker(editor: Editor, at = editor.state.selection.from): void {
  const $at = editor.state.doc.resolve(at);
  const before = $at.parent.isTextblock
    ? $at.parent.textBetween(Math.max(0, $at.parentOffset - 1), $at.parentOffset)
    : "";
  const space = before !== "" && !/\s/u.test(before) ? " " : "";
  editor
    .chain()
    .focus()
    .insertContentAt(at, { type: "text", text: `${space}@` })
    .run();
}
