import type { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { updateRequest } from "../../shared/citationUpdate";
import { requestEdit } from "./editWithAi";

/**
 * Asks Edit with AI to bring the sentence at `range` in line with the new words its Citation now
 * quotes. It comes back as the usual change, applied at once with Undo or held for the User to
 * accept; the sentence stays as it was where the request can't be sent.
 */
export async function updateSentenceToNewWords(
  editor: Editor,
  mindId: string,
  range: { from: number; to: number },
  newWords: string,
): Promise<boolean> {
  const doc = ySyncPluginKey.getState(editor.state)?.binding?.doc;
  if (!doc) return false;
  return requestEdit(editor, mindId, doc, "instruction", updateRequest(newWords), range);
}
