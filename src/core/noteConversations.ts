/**
 * The Conversation each Mind came from (#1940), by Mind id, kept while the note is closed. The
 * link itself is the one each Block added from an Answer keeps (shared/blockOrigins), read from
 * what is stored for the Mind, so a note made before this version counts too. Nothing is stored
 * for the index: a Mind is read again after its Blocks change, which is when a link appears, is
 * taken back, or moves.
 */
import { allOrigins, conversationOrigin } from "../shared/blockOrigins";
import type { NoteConversation } from "./api";
import type { MindContent } from "./mindContent";

export interface NoteConversationsOptions {
  content: MindContent;
  /** The Minds the app still has, by id: one in Recently deleted is left out until it is restored. */
  mindIds(): string[];
}

export function createNoteConversations(options: NoteConversationsOptions) {
  const { content } = options;
  const read = new Map<string, string | null>();

  const conversationOf = (mindId: string): string | null => {
    const known = read.get(mindId);
    if (known !== undefined) return known;
    const conversationId = content.peek(mindId, (note) => {
      const origin = note.doc ? conversationOrigin(allOrigins(note.doc)) : null;
      return origin?.from.artifactKind === "conversation" ? origin.from.artifactId : null;
    });
    read.set(mindId, conversationId);
    return conversationId;
  };

  return {
    /** The first Conversation each Mind's Blocks came from, for the Minds the app has. */
    list(): NoteConversation[] {
      return options.mindIds().flatMap((mindId) => {
        const conversationId = conversationOf(mindId);
        return conversationId ? [{ mindId, conversationId }] : [];
      });
    },

    /** The Mind's Blocks changed: its link is read again next time. */
    changed(mindId: string): void {
      read.delete(mindId);
    },
  };
}
