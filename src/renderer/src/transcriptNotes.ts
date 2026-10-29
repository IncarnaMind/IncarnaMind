import type { CitationAttributes, Document } from "../../core/api";
import type { Cue } from "../../core/documents/formats/vtt";
import { writingTime } from "../../shared/blockTimes";
import { core } from "./core";
import { offerEditorUndo } from "./editor/editorUndo";
import { addTranscriptLine, noteOf } from "./editor/meetingNotes";
import { translateNow } from "./i18n";
import { useMeetings } from "./meetings";
import { useAppStore } from "./store";

/**
 * "Add to note" on a Transcript line (#139): the line's words as a bullet in
 * the Meeting's notes, with a Citation that points at it, checked against the
 * Transcript like any Citation. Nothing is added unless the User asks.
 */
export type LineAdded = "added" | "already" | "failed";

/** The Citation of one line: its Unit, as the Transcript's blocks of lines number them, and its words. */
async function citationOf(document: Document, cue: Cue, page: number | null, mindId: string) {
  const found = await core.recheckCitation({
    mindId,
    documentId: document.id,
    pageFrom: page,
    pageTo: page,
    quote: cue.text,
  });
  const citation: CitationAttributes = {
    passageId: found.passageId,
    documentId: document.id,
    documentName: document.name,
    contentHash: found.contentHash,
    pageFrom: found.pageFrom,
    pageTo: found.pageTo,
    location: found.location,
    quote: cue.text,
    check: found.check,
    checkReason: found.checkReason,
  };
  return citation;
}

export async function addLineToNote(input: {
  document: Document;
  meetingId: string;
  cue: Cue;
  page: number | null;
}): Promise<LineAdded> {
  const { document, meetingId, cue, page } = input;
  const meeting = useMeetings.getState().meetings.find((each) => each.id === meetingId);
  if (!meeting) return "failed";
  try {
    const citation = await citationOf(document, cue, page, meeting.mindId);
    const note = await noteOf(meeting.mindId);
    if (!note) throw new Error(translateNow("transcript.addToNote.failed"));
    const current = useMeetings.getState().meetings.find((each) => each.id === meetingId);
    const added = addTranscriptLine(
      note,
      { text: cue.text, citation },
      writingTime(current, Date.now()),
    );
    if (added === "already") return "already";
    if (!added) throw new Error(translateNow("transcript.addToNote.failed"));
    offerEditorUndo(note.editor, (t) => t("transcript.addToNote.undo"));
    return "added";
  } catch (error) {
    useAppStore.getState().reportError(error);
    return "failed";
  }
}
