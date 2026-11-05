import { create } from "zustand";
import type { JoinedMeeting } from "../../core/api";
import { core } from "./core";

interface JoinedMeetingsState {
  joined: JoinedMeeting[];
  loaded: boolean;
  load(): Promise<void>;
  dismiss(id: string): void;
  undo(id: string): Promise<void>;
}

/**
 * The meetings this version joined on the walled side of the one wall between a Note and its
 * Transcript (#2528). The sidebar says each once: it is marked said as soon as it is read, and
 * stays until the User dismisses it or takes it back. Undo puts the pair back exactly as it was,
 * so nothing walled comes out.
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
  dismiss: (id) => set((state) => ({ joined: state.joined.filter((each) => each.id !== id) })),
  async undo(id) {
    get().dismiss(id);
    await core.undoMeetingJoin(id);
  },
}));
