import { create } from "zustand";
import type { JoinedMeeting } from "../../core/api";
import { core } from "./core";
import { CONFIRMATION_SHOWN_MS } from "./notices";

/** A join, and whether its Undo just ran: the line then says it worked for a few seconds (#2579). */
export type ShownJoin = JoinedMeeting & { undone?: boolean };

interface JoinedMeetingsState {
  joined: ShownJoin[];
  loaded: boolean;
  load(): Promise<void>;
  dismiss(id: string): void;
  undo(id: string): Promise<void>;
}

const undoneTimers = new Map<string, ReturnType<typeof setTimeout>>();
const undoing = new Set<string>();

/**
 * The meetings this version joined on the walled side of the one wall between a Note and its
 * Transcript (#2528). The sidebar says each once: it is marked said as soon as it is read, and
 * stays until the User dismisses it or takes it back. Undo puts the pair back exactly as it was,
 * so nothing walled comes out, and its line says so for a few seconds (#2579).
 */
export const useJoinedMeetings = create<JoinedMeetingsState>()((set, get) => ({
  joined: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    set({ loaded: true });
    const joined = await core.listJoinedMeetings();
    if (joined.length === 0) return;
    set({ joined });
    await core.joinedMeetingsSaid(joined.map((each) => each.id));
  },
  dismiss: (id) => {
    clearTimeout(undoneTimers.get(id));
    undoneTimers.delete(id);
    set((state) => ({ joined: state.joined.filter((each) => each.id !== id) }));
  },
  async undo(id) {
    if (undoing.has(id) || !get().joined.some((each) => each.id === id && !each.undone)) return;
    undoing.add(id);
    try {
      await core.undoMeetingJoin(id);
    } finally {
      undoing.delete(id);
    }
    if (!get().joined.some((each) => each.id === id)) return;
    set((state) => ({
      joined: state.joined.map((each) => (each.id === id ? { ...each, undone: true } : each)),
    }));
    clearTimeout(undoneTimers.get(id));
    undoneTimers.set(
      id,
      setTimeout(() => {
        undoneTimers.delete(id);
        set((state) => ({ joined: state.joined.filter((each) => each.id !== id) }));
      }, CONFIRMATION_SHOWN_MS),
    );
  },
}));
