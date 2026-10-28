import type { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { noteBusy, requestEdit, useEdits } from "./editWithAi";

/**
 * Asks Edit with AI to bring the sentence at `range` in line with the new words its Citation now
 * quotes. It comes back as the usual change, applied at once with Undo or held for the User to
 * accept. Where another edit is running in the Mind, the Mind says it is busy, as it does for the
 * composer, and the sentence stays as it was.
 */
export function updateSentenceToNewWords(
  editor: Editor,
  mindId: string,
  range: { from: number; to: number },
): void {
  const doc = ySyncPluginKey.getState(editor.state)?.binding?.doc;
  if (!doc) return;
  if (useEdits.getState().pending[mindId]) {
    noteBusy(mindId);
    return;
  }
  void requestEdit(editor, mindId, doc, "follow-citation", undefined, range);
}
