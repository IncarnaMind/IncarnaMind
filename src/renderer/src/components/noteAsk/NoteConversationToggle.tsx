import { useEffect, useState } from "react";
import { core } from "../../core";
import { useT } from "../../i18n";
import {
  showConversation,
  useConversationShown,
  useNoteAskShown,
  useNoteAsks,
} from "../../ownAiInNote";
import { useAppStore } from "../../store";

/**
 * Show conversation, at the Note's top right beside its menu (#3677), as the User's AI app has
 * Show chat in its page's header: for a Note with its own input and a conversation to show.
 */
export function NoteConversationToggle({ mindId }: { mindId: string }) {
  const shown = useNoteAskShown(mindId);
  return shown ? <Toggle mindId={mindId} /> : null;
}

function Toggle({ mindId }: { mindId: string }) {
  const t = useT();
  const state = useNoteAsks((each) => each.byMind[mindId]?.state ?? null);
  const open = useConversationShown((each) => each.byMind[mindId] === true);
  const kept = useKeptConversation(mindId, state);
  if (!kept && state === null) return null;
  return (
    <button
      type="button"
      data-testid="note-ask-conversation-toggle"
      aria-expanded={open}
      onClick={() => showConversation(mindId, !open)}
      className="note-ask-toggle"
    >
      {t(open ? "noteAsk.hideConversation" : "noteAsk.showConversation")}
    </button>
  );
}

/** Whether the Note has a conversation kept, read as it opens and as each request ends. */
function useKeptConversation(mindId: string, state: string | null): boolean {
  const [kept, setKept] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as each request ends.
  useEffect(() => {
    let current = true;
    core.noteConversation(mindId).then((turns) => {
      if (current) setKept(turns.length > 0);
    }, useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [mindId, state]);
  return kept;
}
