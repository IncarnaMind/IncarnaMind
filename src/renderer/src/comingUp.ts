import { create } from "zustand";
import type { CalendarEvent } from "../../core/api";
import { daysAfter } from "../../shared/dates";
import { comingUpSpan } from "./calendarWords";
import { core } from "./core";
import { readNoteEvent } from "./noteEvents";
import { useAppStore } from "./store";

const MINUTE_MS = 60_000;

interface ComingUpState {
  /** The Meetings on counted calendars from when they were read to the end of tomorrow. */
  meetings: readonly CalendarEvent[];
  /** Reads them now, and again once the day turns, as tomorrow becomes today. */
  load(): Promise<void>;
}

let readOn: Date | null = null;
let watching = false;

async function read(): Promise<void> {
  const now = new Date();
  readOn = now;
  try {
    useComingUp.setState({ meetings: await core.listCalendarEvents(comingUpSpan(now)) });
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

export const useComingUp = create<ComingUpState>()(() => ({
  meetings: [],
  async load() {
    if (!watching) {
      watching = true;
      setInterval(() => {
        if (readOn && daysAfter(new Date(), readOn) !== 0) void read();
      }, MINUTE_MS);
    }
    await read();
  },
}));

core.on("calendarEvents.changed", () => void read());

/** Shows these Meetings as a calendar would give them: a test's hook, before any calendar is read. */
export function showComingUp(meetings: readonly { id: string; title: string; start: string }[]) {
  useComingUp.setState({
    meetings: meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      startsAt: meeting.start,
      endsAt: new Date(Date.parse(meeting.start) + 30 * MINUTE_MS).toISOString(),
      attendees: [],
      joinUrl: null,
      service: "google",
      mindId: null,
    })),
  });
}

/**
 * Take notes: the event's Note, made now or made before, in a tab of its own, as Record a meeting
 * opens one: never in place of the Note in front. A new one has the cursor in its text.
 */
export async function takeNotes(event: CalendarEvent): Promise<void> {
  try {
    const { mindId, created } = await core.takeEventNotes(event.id);
    void readNoteEvent(mindId);
    if (created) useAppStore.setState({ bodyToFocus: mindId });
    await useAppStore.getState().changeLayout({
      type: "open",
      item: { kind: "mind", mindId },
      where: { in: "group" },
    });
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}
