/**
 * One meeting is one item (#2528): a Meeting's Transcript has no row of its
 * own, in the sidebar, the Library, ⌘K's names, the pickers or the counts. It
 * is reached through its Note, and a hit inside it is the Note's. Pure: no
 * store, no bridge, so the tests import it.
 */
import type { Document, Mind } from "../../core/api";
import { clockTime } from "../../shared/clock";
import { mindName } from "../../shared/naming";
import type { Translate } from "./objects";

/** Whether a Document has a row of its own: a Meeting's Transcript is its Note's. */
export const isListedDocument = (document: Pick<Document, "meetingMindId">): boolean =>
  (document.meetingMindId ?? null) === null;

/** The Note a Meeting's Transcript belongs to, while it is here. */
export const noteOf = (
  document: Pick<Document, "meetingMindId">,
  minds: readonly Mind[],
): Mind | undefined =>
  isListedDocument(document) ? undefined : minds.find((mind) => mind.id === document.meetingMindId);

/**
 * A Transcript named as its Note's, "Weekly call · Transcript", and with the time the words were
 * said when there is one: "Weekly call · Transcript, 12:07".
 */
export function transcriptInNote(note: Mind, atMs: number | null, t: Translate): string {
  const meeting = mindName(note) || t("mind.untitled");
  return atMs === null
    ? t("meetings.transcript.inNote", { meeting })
    : t("meetings.transcript.inNoteAt", { meeting, time: clockTime(atMs) });
}
