import { useEffect, useState } from "react";
import { create } from "zustand";
import type { Meeting, NoteTurn } from "../../core/api";
import { translate } from "../../shared/i18n";
import { askFirstAgent } from "./askYourAi";
import { core } from "./core";
import { checkFromAssistant } from "./mindCheck";
import { askInNote, type NoteAsk, useNoteAsks } from "./ownAiInNote";
import { useAppStore } from "./store";

/** The words Write notes asks with, in either language: the Note's conversation keeps them. */
const REQUESTS: ReadonlySet<string> = new Set(
  (["en", "zh-CN"] as const).map((language) =>
    translate(language, "meetings.foot.writeNotesRequest"),
  ),
);

type CallStop = Pick<Meeting, "id" | "mindId" | "stoppedAt">;

/**
 * Write notes asked and not settled yet, or handed to the User's own app by its link, which the
 * Note's conversation never holds: by Meeting, the Stop it was asked after.
 */
const useWriting = create<{ asked: Readonly<Record<string, string | null>> }>(() => ({
  asked: {},
}));

function setWriting(meeting: CallStop, asked: boolean): void {
  useWriting.setState((state) => {
    const { [meeting.id]: _, ...rest } = state.asked;
    return { asked: asked ? { ...rest, [meeting.id]: meeting.stoppedAt } : rest };
  });
}

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
export async function writeMeetingNotes(meeting: CallStop, words: string): Promise<boolean> {
  const { mindId } = meeting;
  setWriting(meeting, true);
  let byLink = false;
  try {
    const went = await askInNote(mindId, { words, quote: "", selection: null, caret: "" });
    if (went === "link") {
      byLink =
        (await askFirstAgent(mindId, { kind: "meeting", meetingId: meeting.id })) === "asked";
      return byLink;
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
  } finally {
    if (!byLink) setWriting(meeting, false);
  }
}

const sinceStop = (at: string | null, meeting: CallStop) =>
  meeting.stoppedAt === null || (at !== null && Date.parse(at) >= Date.parse(meeting.stoppedAt));

const asksForNotes = (words: string, state: NoteTurn["outcome"]) =>
  REQUESTS.has(words) && (state === "working" || state === "landed");

/**
 * Whether Write notes was asked for the call since its last Stop, read from the Note's
 * conversation, so a Note opened again knows: a request of its words working or done, or one
 * asked in this window that hasn't settled or went by the link. Null until the conversation is
 * read; nothing is read while `readable` is false.
 */
export function useNotesAsked(meeting: CallStop, readable: boolean): boolean | null {
  const writing = useWriting(
    (state) => meeting.id in state.asked && state.asked[meeting.id] === meeting.stoppedAt,
  );
  const ask = useNoteAsks((state) => state.byMind[meeting.mindId]);
  const [read, setRead] = useState<{ mindId: string; turns: readonly NoteTurn[] } | null>(null);
  const changed = `${ask?.turnId ?? ""}:${ask?.state ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as each request starts and ends.
  useEffect(() => {
    if (!readable) return;
    let current = true;
    core
      .noteConversation(meeting.mindId)
      .then((turns) => {
        if (current) setRead({ mindId: meeting.mindId, turns });
      })
      .catch(useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [meeting.mindId, readable, changed]);
  if (writing) return true;
  if (ask && asksForNotes(ask.asked.words, ask.state) && sinceStop(ask.startedAt, meeting))
    return true;
  if (read?.mindId !== meeting.mindId) return null;
  return read.turns.some(
    (turn) => asksForNotes(turn.request, turn.outcome) && sinceStop(turn.at, meeting),
  );
}
