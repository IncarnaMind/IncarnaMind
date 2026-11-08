import { create } from "zustand";
import type { MeetingOffers } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";

/** The offers to take notes as the core holds them (#208): a call's end waiting to stop its Meeting, why calls can't be noticed. */
export const useMeetingOffers = create<{ offers: MeetingOffers; load(): Promise<void> }>()(
  (set) => ({
    offers: { offer: null, ending: null, problem: null },
    async load() {
      try {
        set({ offers: await core.getMeetingOffers() });
      } catch (error) {
        useAppStore.getState().reportError(error);
      }
    },
  }),
);

core.on("meetings.offers", (offers) => useMeetingOffers.setState({ offers }));
