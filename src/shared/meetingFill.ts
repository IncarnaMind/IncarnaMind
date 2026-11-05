import type { MeetingFill } from "../core/api";

export function isPartialMeetingFill(fill: MeetingFill | null): boolean {
  return (
    fill !== null &&
    ((fill.omitted ?? 0) > 0 || (fill.unfinishedParts ?? 0) > 0 || fill.problem !== null)
  );
}
