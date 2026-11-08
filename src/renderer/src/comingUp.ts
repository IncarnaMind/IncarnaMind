import { create } from "zustand";

export interface CalendarMeeting {
  id: string;
  title: string;
  /** ISO 8601, UTC. */
  start: string;
}

// Filled by the calendars of #190; empty, and no calendar connected, until then.
export const useComingUp = create<{
  meetings: readonly CalendarMeeting[];
  /** A calendar is connected: Settings › General shows the switch for its offers (#189). */
  connected: boolean;
}>()(() => ({
  meetings: [],
  connected: false,
}));
