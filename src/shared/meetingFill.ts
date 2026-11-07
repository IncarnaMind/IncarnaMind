import type { EditCause, MeetingFill } from "../core/api";

export function isPartialMeetingFill(fill: MeetingFill | null): boolean {
  return (
    fill !== null &&
    ((fill.omitted ?? 0) > 0 || (fill.unfinishedParts ?? 0) > 0 || fill.problem !== null)
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
