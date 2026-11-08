import { useEffect } from "react";
import { create } from "zustand";
import type { NoteEvent } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";

/** The calendar event each Note shown was made for (#190), by the Note's id: null for none. */
const useNoteEvents = create<{ events: Readonly<Record<string, NoteEvent | null>> }>()(() => ({
  events: {},
}));

const reading = new Set<string>();

async function read(mindId: string): Promise<void> {
  if (reading.has(mindId)) return;
  reading.add(mindId);
  try {
    const event = await core.getNoteEvent(mindId);
    useNoteEvents.setState((state) => ({ events: { ...state.events, [mindId]: event } }));
  } catch (error) {
    useAppStore.getState().reportError(error);
  } finally {
    reading.delete(mindId);
  }
}

/** Reads a Note's event again, as after Take notes made it. */
export const readNoteEvent = (mindId: string) => read(mindId);

/** The event `mindId` was made for, as the calendar has it now; undefined until it is read. */
export function useNoteEvent(mindId: string | null): NoteEvent | null | undefined {
  const known = useNoteEvents((state) => (mindId === null ? false : mindId in state.events));
  useEffect(() => {
    if (mindId !== null && !known) void read(mindId);
  }, [mindId, known]);
  return useNoteEvents((state) => (mindId === null ? null : state.events[mindId]));
}

core.on("calendarEvents.changed", () => {
  for (const mindId of Object.keys(useNoteEvents.getState().events)) void read(mindId);
});
