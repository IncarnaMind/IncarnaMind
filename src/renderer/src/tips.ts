import { useEffect } from "react";
import { create } from "zustand";
import { chooseNudge } from "./nudges";
import { useAppStore } from "./store";

export type TipId = "add-answer" | "citation-style" | "connect-app";

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
export function offerTip(id: TipId, key: string): boolean {
  if (useShowing.getState().showing || countOf(id) >= TIP_SHOWS) return false;
  useShowing.setState({ showing: { id, key } });
  remember(id, countOf(id) + 1);
  return true;
}

export function releaseTip(id: TipId, key: string): void {
  const shown = useShowing.getState().showing;
  if (shown?.id === id && shown.key === key) useShowing.setState({ showing: null });
}

/** Undo restores a dismissal explicitly; it is not another automatic offer. */
export function restoreTip(id: TipId, key: string): void {
  useShowing.setState({ showing: { id, key } });
}

export function closeTip(id: TipId): void {
  if (useShowing.getState().showing?.id === id) useShowing.setState({ showing: null });
  if (countOf(id) < TIP_SHOWS) remember(id, TIP_SHOWS);
}

export function useTipShown(id: TipId, key: string): boolean {
  const shown = useShowing((state) => state.showing?.id === id && state.showing.key === key);
  const quiet = useAppStore((state) => chooseNudge(state) === null);
  return shown && quiet;
}

/**
 * Whether the tip could show next. Its room is kept from the start, so nothing under or above it
 * moves when it comes; another ask keeps it quiet.
 */
export function useTipRoom(id: TipId, key: string | null): boolean {
  const left = useAppStore((state) => (state.settings?.device.tips[id] ?? 0) < TIP_SHOWS);
  const free = useShowing(
    (state) =>
      state.showing === null ||
      (state.showing.id === id && key !== null && state.showing.key === key),
  );
  const quiet = useAppStore((state) => chooseNudge(state) === null);
  return left && free && quiet;
}

/**
 * A tip a feature offers while it is useful: it is offered once for what it teaches, at most
 * twice on the device, and goes with the feature or its own ✕. Two surfaces showing the same
 * feature (a note kept in a background tab, too) offer it once between them.
 */
const offered = new Set<string>();

export function useFeatureTip(id: TipId, key: string, wanted: boolean): boolean {
  const room = useTipRoom(id, key);
  const shown = useTipShown(id, key);
  useEffect(() => {
    if (!wanted) {
      releaseTip(id, key);
      return;
    }
    const identity = `${id}:${key}`;
    if (room && !offered.has(identity) && offerTip(id, key)) offered.add(identity);
  }, [wanted, room, id, key]);
  useEffect(() => () => releaseTip(id, key), [id, key]);
  return wanted && shown;
}
