import type { DocumentPlace, Meeting } from "../../core/api";
import { groupsMerged } from "./layoutSlice";
import { showMeetingNoteView } from "./meetingViews";
import { useAppStore } from "./store";

/**
 * A Meeting's Transcript as a tab (#136): shown in its Note's page (#138) until "Open beside"
 * opens it in the group beside, kept open (not a preview). It stays searchable and citable
 * either way.
 */

/** Opens the Transcript in the group beside `fromGroupId`, the meeting's Mind's. */
export function showTranscript(documentId: string, fromGroupId: string | undefined): void {
  void useAppStore.getState().changeLayout({
    type: "open",
    item: { kind: "document", documentId },
    preview: false,
    where: { in: "side", ...(fromGroupId && { from: fromGroupId }) },
    // A merged window shows one group: what opens to the side comes to the front.
    focus: groupsMerged(),
  });
}

/**
 * "Open beside": the meeting's Transcript as a tab in the next group, and its page back on the
 * notes, so a wide window shows the notes and the Transcript together.
 */
export function openTranscriptBeside(page: {
  meeting: Meeting;
  tabId: string;
  groupId: string | undefined;
}): void {
  const documentId = page.meeting.transcript?.documentId;
  if (!documentId) return;
  showMeetingNoteView(page.tabId, page.meeting.mindId, "notes");
  showTranscript(documentId, page.groupId);
}

/**
 * A hit inside a Meeting's Transcript is its Note's (#2528): the Note opens where the User is,
 * then its Transcript beside it at the words found, as Show transcript opens it.
 */
export async function openTranscriptOfNote(
  mindId: string,
  documentId: string,
  place: DocumentPlace,
): Promise<void> {
  const store = useAppStore.getState();
  const layout = await store.changeLayout({
    type: "open",
    item: { kind: "mind", mindId },
    where: { in: "place" },
  });
  const noteGroup = layout?.groups.find((group) =>
    group.tabs.some((tab) => tab.item.kind === "mind" && tab.item.mindId === mindId),
  );
  await store.changeLayout({
    type: "open",
    item: { kind: "document", documentId },
    ...(Object.keys(place).length > 0 && { place }),
    preview: false,
    where: { in: "side", ...(noteGroup && { from: noteGroup.id }) },
    focus: groupsMerged(),
  });
}
