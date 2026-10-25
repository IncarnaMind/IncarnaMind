/**
 * The chat a note was made from (#1940), remembered on this computer so that
 * History can name that chat under the note's title while the note is closed.
 * An open note's Blocks keep the link back themselves (src/shared/blockOrigins),
 * and that is what its menu and History use first; this only outlives its tab.
 * A label, not the User's data: a store that refuses it only loses the label.
 */
const KEY = "incarnamind.noteChats";

/** The note each chat made, by note id, as remembered. */
function remembered(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof saved !== "object" || saved === null) return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** Remember that a note was made from a chat, by the note's id. */
export function rememberNoteChat(mindId: string, conversationId: string): void {
  const saved = remembered();
  if (saved[mindId] === conversationId) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...saved, [mindId]: conversationId }));
  } catch {
    // A full or blocked store keeps only the note's own link, which an open note still reads.
  }
}

/** The note id remembered for a chat, if any: null for a chat no note is remembered from. */
export function noteRememberedFor(conversationId: string): string | null {
  for (const [mindId, chat] of Object.entries(remembered())) {
    if (chat === conversationId) return mindId;
  }
  return null;
}
