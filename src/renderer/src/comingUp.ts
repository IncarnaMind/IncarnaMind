import { create } from "zustand";

export interface CalendarMeeting {
  id: string;
  title: string;
  /** ISO 8601, UTC. */
  start: string;
}

// Filled by the calendars of #190; empty until then.
export const useComingUp = create<{ meetings: readonly CalendarMeeting[] }>()(() => ({
  meetings: [],
}));
