import type { EditCause, MeetingFill } from "../core/api";

/**
 * Whether the note lacks something: an item the reply held that couldn't be added, a Transcript
 * part never finished, or a stretch of the call whose notes are missing or may be incomplete. A
 * section placed under its own title instead of the User's heading lacks nothing (#3099).
 */
export function isPartialMeetingFill(fill: MeetingFill | null): boolean {
  return (
    fill !== null &&
    ((fill.omitted ?? 0) > 0 ||
      (fill.unfinishedParts ?? 0) > 0 ||
      (fill.stretches?.length ?? 0) > 0)
  );
}

/**
 * What a Meeting's fill is written into its Note with: the editor showing the Note takes it as
 * one step of its own Undo, so ⌘Z there takes back the fill and ⇧⌘Z puts it back (#2527).
 */
export function meetingFillCause(meetingId: string): EditCause {
  const request = `meeting-fill:${meetingId}`;
  return { requestId: request, request, apply: false };
}
