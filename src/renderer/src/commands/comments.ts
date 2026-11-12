import type { Editor } from "@tiptap/core";
import { commentIdsOf, commentOnSelection, useCommentsUi } from "../comments";
import { mindEditor } from "../editor/openEditors";
import { editorDoc } from "../editor/proposalReview";
import { useAppStore } from "../store";
import { viewerHandleInUse } from "./handles";
import type { Command, CommandContext } from "./registry";
import { mindShown, onlyOne } from "./targets";

/** The viewer selection whose note a comment opens, there while its words are selected (#327). */
const viewerComment = () => {
  const selection = viewerHandleInUse("selection", useAppStore.getState().layout);
  return selection?.note ? selection : null;
};

/** The open editor of the Mind a command names, or the one in front: null when it isn't open. */
function openNote(ctx: CommandContext): Editor | null {
  const mindId = mindShown(ctx);
  const editor = mindId === null ? null : mindEditor(mindId);
  return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
}

/**
 * Comments (#328): one on the selected text, as Word's ⌥⌘M and Google
 * Docs' ⌘⌥M add one, and the Mind's list. Both are in the note's menus and
 * ⌘K, and the list opens from the count in the page's corner too. The same
 * keys put a comment on words selected in a viewer (#327): that is the
 * highlight's comment, so one command has the keys wherever words are selected.
 */
export const commentCommands: readonly Command[] = [
  {
    id: "comment.add",
    label: "comments.add",
    keywords: ["comments.keywords"],
    shortcut: { keys: "CmdOrCtrl+Alt+M" },
    group: "main",
    appliesToText: true,
    // From ⌘K the focus is the tab, so this acts on the Mind in front's editor and its selection;
    // in a viewer it is the Document whose words are selected.
    // The comment's own Undo line takes it back, one step.
    reversible: true,
    when(ctx) {
      const editor = openNote(ctx);
      return editor !== null && !editor.state.selection.empty ? true : viewerComment() !== null;
    },
    run(ctx) {
      const editor = openNote(ctx);
      const mindId = mindShown(ctx);
      const doc = editor && editorDoc(editor);
      if (editor && mindId && doc && !editor.state.selection.empty) {
        commentOnSelection(editor, mindId, doc);
        return;
      }
      viewerComment()?.note?.();
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
