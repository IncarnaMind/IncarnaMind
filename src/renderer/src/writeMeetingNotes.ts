import { askFirstAgent } from "./askYourAi";
import { checkFromAssistant } from "./mindCheck";
import { askInNote, type NoteAsk, useNoteAsks } from "./ownAiInNote";
import { useAppStore } from "./store";

/** The Note's request once it has ended: what it changed, or null when it didn't land. */
function landed(mindId: string, turnId: string): Promise<NoteAsk | null> {
  return new Promise((resolve) => {
    const settled = (ask: NoteAsk | undefined) => {
      if (!ask || ask.turnId !== turnId) return false;
      if (ask.state === "working") return false;
      resolve(ask.state === "landed" ? ask : null);
      return true;
    };
    if (settled(useNoteAsks.getState().byMind[mindId])) return;
    const stop = useNoteAsks.subscribe((state) => {
      if (settled(state.byMind[mindId])) stop();
    });
  });
}

/**
 * Write notes (#3762): the meeting's Note asks its own AI to write the notes from the call, as
 * the Note's input asks, then checks what it wrote in the same press. An AI reached only through
 * its own app gets the request by its link, as the input sends one. Whether the request went.
 */
export async function writeMeetingNotes(
  meeting: { id: string; mindId: string },
  words: string,
): Promise<boolean> {
  const { mindId } = meeting;
  const went = await askInNote(mindId, { words, quote: "", selection: null, caret: "" });
  if (went === "link") {
    return (await askFirstAgent(mindId, { kind: "meeting", meetingId: meeting.id })) === "asked";
  }
  // A problem is said on the line above the input, with what to do.
  if (went !== "started") return false;
  const turnId = useNoteAsks.getState().byMind[mindId]?.turnId;
  if (!turnId) return true;
  const ask = await landed(mindId, turnId);
  if (ask && ask.changed > 0) {
    await checkFromAssistant(mindId).catch(useAppStore.getState().reportError);
  }
  return true;
}
