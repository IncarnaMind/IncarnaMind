import type { FieldMode } from "../../../shared/meetingPanel";

const KEY = "incarnamind.callHelp.fieldMode";

/**
 * The mode the User last chose for the panel's field (#2925), kept for the rest of its Meeting on
 * this computer: through a collapse, and a panel closed and shown again, whose page is new. Any
 * other Meeting starts in Ask: a question typed in Note is only added to the notes, with no answer.
 */
export function savedFieldMode(meetingId: string): FieldMode {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as {
      meetingId?: unknown;
      mode?: unknown;
    } | null;
    return saved?.meetingId === meetingId && saved.mode === "note" ? "note" : "ask";
  } catch {
    return "ask";
  }
}

export function saveFieldMode(meetingId: string, mode: FieldMode): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ meetingId, mode }));
  } catch {
    // Not remembered, then: a panel shown again starts in Ask.
  }
}
