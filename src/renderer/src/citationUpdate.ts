import type { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { noteBusy, requestEdit, useEdits } from "./editWithAi";

/**
 * Update the sentence… on a Citation (#99): the Citation moves to the Document's new version, and, where
 * its words changed, Edit with AI is asked to bring the sentence at `range` in line with them. It comes
 * back as the usual change, applied at once with Undo or held for the User to accept.
 *
 * Where the words changed and another edit is running in the Note, the Note says it is busy and
 * nothing changes: the Citation stays as it was, so the User can ask again once the edit is done.
 * A quote that only moved needs no rewrite, so it switches whatever the Note is doing.
 * Says whether the Citation switched.
 */
export function followNewVersion({
  editor,
  mindId,
  range,
  wordsChanged,
  switchCitation,
}: {
  editor: Editor;
  mindId: string | null;
  range: { from: number; to: number } | null;
  wordsChanged: boolean;
  switchCitation(): void;
}): boolean {
  const asks = wordsChanged && mindId !== null && range !== null;
  if (asks && useEdits.getState().pending[mindId]) {
    noteBusy(mindId);
    return false;
  }
  switchCitation();
  const doc = ySyncPluginKey.getState(editor.state)?.binding?.doc;
  if (asks && doc) void requestEdit(editor, mindId, doc, "follow-citation", undefined, range);
  return true;
}
