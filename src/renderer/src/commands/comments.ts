import type { Editor } from "@tiptap/core";
import { commentIdsOf, commentOnSelection, useCommentsUi } from "../comments";
import { mindEditor } from "../editor/openEditors";
import { editorDoc } from "../editor/proposalReview";
import type { Command, CommandContext } from "./registry";
import { mindShown, onlyOne } from "./targets";

/** The open editor of the Mind a command names, or the one in front: null when it isn't open. */
function openNote(ctx: CommandContext): Editor | null {
  const mindId = mindShown(ctx);
  const editor = mindId === null ? null : mindEditor(mindId);
  return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
}

/**
 * Comments (#328): one on the selected text, as Word's ⌥⌘M and Google
 * Docs' ⌘⌥M add one, and the Mind's list. Both are in the note's menus and
 * ⌘K, and the list opens from the count in the page's corner too.
 */
export const commentCommands: readonly Command[] = [
  {
    id: "comment.add",
    label: "comments.add",
    keywords: ["comments.keywords"],
    shortcut: { keys: "CmdOrCtrl+Alt+M" },
    group: "main",
    // From ⌘K the focus is the tab, so this acts on the Mind in front's editor and its selection.
    appliesTo: ["mind", "tab", "block"],
    // The comment's own Undo line takes it back, one step.
    reversible: true,
    when(ctx) {
      const editor = openNote(ctx);
      return editor !== null && !editor.state.selection.empty;
    },
    run(ctx) {
      const editor = openNote(ctx);
      const mindId = mindShown(ctx);
      const doc = editor && editorDoc(editor);
      if (editor && mindId && doc) commentOnSelection(editor, mindId, doc);
    },
  },
  {
    id: "comment.list",
    label: "comments.list",
    keywords: ["comments.keywords"],
    group: "main",
    appliesTo: ["mind", "tab", "block"],
    // Opening a list changes nothing.
    reversible: true,
    when(ctx) {
      const editor = openNote(ctx);
      const doc = editor && editorDoc(editor);
      return onlyOne(ctx) && doc !== null && commentIdsOf(doc).size > 0;
    },
    run(ctx) {
      const mindId = mindShown(ctx);
      if (mindId) useCommentsUi.getState().showList(mindId);
    },
  },
];
