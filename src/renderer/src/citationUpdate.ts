import type { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { requestEdit } from "./editWithAi";

/** The most of the new words sent with the request, in characters. */
const MOST_NEW_WORDS = 1_200;

/**
 * What Edit with AI is asked when a Citation moves to its Document's new version (#99): to make the
 * sentence agree with the words it now cites, changing only what they changed. The edit keeps the
 * sentence's Citation marker, as every edit does.
 */
export function updateRequest(newWords: string): string {
  const words = [...newWords.replace(/\s+/g, " ").trim()].slice(0, MOST_NEW_WORDS).join("");
  return `The source this sentence cites now says: “${words}”. Rewrite the sentence so it agrees with that source, changing only what the new wording changes. Keep the sentence's Citation marker.`;
}

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
