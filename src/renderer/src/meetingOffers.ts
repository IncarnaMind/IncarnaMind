import { create } from "zustand";
import type { MeetingOffers } from "../../core/api";
import { TranslatableError } from "../../core/errors";
import { core } from "./core";
import { useAppStore } from "./store";

/** Meeting reminders, the call ending countdown, and call detection status as held by the core. */
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
core.on("meetings.offerShown", () => void useAppStore.getState().openHome());
core.on("meetings.offerLinkFailed", () => {
  useAppStore.getState().reportError(new TranslatableError({ key: "error.meetingOffer.link" }));
});
