import { create } from "zustand";
import type { JoinedMeeting } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";

interface JoinedMeetingsState {
  joined: JoinedMeeting[];
  loaded: boolean;
  load(): Promise<void>;
  dismiss(id: string): void;
  undo(id: string): Promise<void>;
}

/**
 * The meetings' Notes this version moved to their Transcript's Folder when it joined each pair
 * filed apart (#2528). The sidebar says each once: it is marked said as soon as it is read, and
 * stays until the User dismisses it or takes it back. Undo moves the Note back, its Transcript
 * with it, as any move does, with its own Undo line.
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
    const join = get().joined.find((each) => each.id === id);
    if (!join) return;
    get().dismiss(id);
    await useAppStore.getState().moveToFolder({ mindIds: [join.mindId] }, join.fromFolderId);
  },
}));
