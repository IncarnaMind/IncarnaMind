/**
 * One meeting is one item (#2528): a Meeting's Transcript has no row of its
 * own, in the sidebar, the Library, ⌘K's names, the pickers or the counts. It
 * is reached through its Note, and a hit inside it is the Note's. Pure: no
 * store, no bridge, so the tests import it.
 */
import type { Document, DocumentGroupAssignment, DocumentTextMatch, Mind } from "../../core/api";
import { paddedClockTime } from "../../shared/clock";
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
 * The Library's filings, with each meeting's Transcript filed, by the User, where its Note is: the
 * one place the window reads a Document's Folder and wall from (#2528). Only for placing
 * Documents; Organize's own lists keep the real filings.
 */
export function withTranscriptsFiled<
  Filing extends Pick<DocumentGroupAssignment, "documentId" | "groupId">,
>(
  assignments: readonly Filing[],
  documents: readonly Pick<Document, "id" | "meetingMindId">[],
  minds: readonly Pick<Mind, "id" | "folderId">[],
): (Filing | DocumentGroupAssignment)[] {
  const folderOf = new Map(minds.map((mind) => [mind.id, mind.folderId]));
  const owned = documents.flatMap((document): DocumentGroupAssignment[] => {
    if (isListedDocument(document)) return [];
    const groupId = folderOf.get(document.meetingMindId ?? "") ?? null;
    return groupId === null
      ? []
      : [
          {
            documentId: document.id,
            groupId,
            source: "user",
            suggested: false,
            status: "classified",
            error: null,
            model: null,
          },
        ];
  });
  return owned.length === 0 ? [...assignments] : [...assignments, ...owned];
}

/** The meetings words found inside Documents were said in, each with its Note. */
export function meetingHitsOf(
  matches: ReadonlyMap<string, DocumentTextMatch> | null,
  documents: readonly Pick<Document, "id" | "meetingMindId">[],
  minds: readonly Mind[],
): { match: DocumentTextMatch; note: Mind }[] {
  if (!matches) return [];
  return documents.flatMap((document) => {
    const match = matches.get(document.id);
    const note = match && noteOf(document, minds);
    return match && note ? [{ match, note }] : [];
  });
}

/** The Folder a Document is in, as the window places it: a meeting's Transcript's is its Note's. */
export function folderIdOfDocument(
  state: {
    library: {
      assignments: readonly Pick<DocumentGroupAssignment, "documentId" | "groupId">[];
    } | null;
    minds: readonly Pick<Mind, "id" | "folderId">[];
  },
  document: Pick<Document, "id" | "meetingMindId">,
): string | null {
  const filings = withTranscriptsFiled(state.library?.assignments ?? [], [document], state.minds);
  return filings.find((each) => each.documentId === document.id)?.groupId ?? null;
}

/**
 * A Transcript named as its Note's, "Weekly call · Transcript", and with the time the words were
 * said, as the Transcript's own lines show it, when there is one: "Weekly call · Transcript, 12:07".
 */
export function transcriptInNote(note: Mind, atMs: number | null, t: Translate): string {
  const meeting = mindName(note) || t("mind.untitled");
  return atMs === null
    ? t("meetings.transcript.inNote", { meeting })
    : t("meetings.transcript.inNoteAt", { meeting, time: paddedClockTime(atMs) });
}
