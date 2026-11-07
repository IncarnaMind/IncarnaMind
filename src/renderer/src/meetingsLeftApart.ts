import { create } from "zustand";
import type { MeetingLeftApart } from "../../core/api";
import { core } from "./core";

interface MeetingsLeftApartState {
  left: MeetingLeftApart[];
  loaded: boolean;
  load(): Promise<void>;
  dismiss(): void;
}

/**
 * The meetings this version left apart from their Transcripts, two walls lying between each Note
 * and its Transcript (#2528). The sidebar says so once: they are marked said as soon as they are read,
 * and the line stays until the User dismisses it. Nothing moves them.
 */
export const useMeetingsLeftApart = create<MeetingsLeftApartState>()((set, get) => ({
  left: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    set({ loaded: true });
    const left = await core.listMeetingsLeftApart();
    if (left.length === 0) return;
    set({ left });
    await core.meetingsLeftApartSaid(left.map((each) => each.id));
  },
  dismiss: () => set({ left: [] }),
}));
