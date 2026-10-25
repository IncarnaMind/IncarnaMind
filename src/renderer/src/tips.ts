import { create } from "zustand";
import { chooseNudge, stepsShownOf } from "./nudges";
import { useAppStore } from "./store";

export type TipId = "add-answer";

/** Interaction rule 14: a tip never shows a third time on a device. */
export const TIP_SHOWS = 2;

interface Showing {
  id: TipId;
  key: string;
}

const useShowing = create<{ showing: Showing | null }>(() => ({ showing: null }));

const countOf = (id: TipId) => useAppStore.getState().settings?.device.tips[id] ?? 0;

function remember(id: TipId, count: number): void {
  const { settings, updateSettings } = useAppStore.getState();
  if (!settings) return;
  void updateSettings({ device: { tips: { ...settings.device.tips, [id]: count } } });
}

/** Shows a tip at `key`, if none is showing and it hasn't shown twice on this device. */
export function offerTip(id: TipId, key: string): void {
  if (useShowing.getState().showing || countOf(id) >= TIP_SHOWS) return;
  useShowing.setState({ showing: { id, key } });
  remember(id, countOf(id) + 1);
}

export function closeTip(id: TipId): void {
  if (useShowing.getState().showing?.id === id) useShowing.setState({ showing: null });
  if (countOf(id) < TIP_SHOWS) remember(id, TIP_SHOWS);
}

export const useTipShown = (id: TipId, key: string): boolean =>
  useShowing((state) => state.showing?.id === id && state.showing.key === key);

/**
 * Whether the tip could show next. Its room is kept from the start, so nothing under or above it
 * moves when it comes: no tip shows during the first-run steps or beside another ask.
 */
export function useTipRoom(id: TipId, key: string | null): boolean {
  const left = useAppStore((state) => (state.settings?.device.tips[id] ?? 0) < TIP_SHOWS);
  const free = useShowing(
    (state) =>
      state.showing === null ||
      (state.showing.id === id && key !== null && state.showing.key === key),
  );
  const quiet = useAppStore(
    (state) => !stepsShownOf(state.settings?.device.gettingStarted) && chooseNudge(state) === null,
  );
  return left && free && quiet;
}
