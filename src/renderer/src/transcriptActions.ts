import type { MeetingSummarySource, TextRange } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";
import { makeInTurn, type Undoable, useUndo } from "./undo";

export async function addTranscriptAction(
  meetingId: string,
  documentId: string,
  source: MeetingSummarySource,
  excerpt?: TextRange,
): Promise<"added" | "already" | "failed"> {
  try {
    return await makeInTurn(async () => {
      const add = () => core.addMeetingTranscriptAction(meetingId, documentId, source, excerpt);
      const result = await add();
      if (!result.added) return "already";
      let itemId = result.itemId;
      const change: Undoable = {
        name: (t) => t("transcript.action.add"),
        said: (t) => t("meetings.summary.candidate.added"),
        undo: () => core.undoAddMeetingTranscriptAction(meetingId, itemId),
        redo: async () => {
          const next = await add();
          if (next.added) itemId = next.itemId;
          else {
            useUndo.getState().withdraw(change);
            useUndo.getState().tell({ says: (t) => t("transcript.action.already") });
          }
        },
      };
      useUndo.getState().push(change);
      return "added";
    });
  } catch (error) {
    useAppStore.getState().reportError(error);
    return "failed";
  }
}
