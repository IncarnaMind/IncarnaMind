import { useMemo } from "react";
import { noModelSetUp } from "./noModelSetUp";
import { pagesOffered, type SettingsPage } from "./settingsPages";
import { useAppStore } from "./store";

export function useSettingsPagesOffered(): readonly SettingsPage[] {
  const noModel = useAppStore((state) => noModelSetUp(state.chatReadiness));
  const connectorsOn = useAppStore((state) => state.connectorsOn);
  return useMemo(() => pagesOffered({ noModel, connectorsOn }), [noModel, connectorsOn]);
}

export const useSettingsPageOffered = (page: SettingsPage): boolean =>
  useSettingsPagesOffered().includes(page);

export function settingsPageOfferedNow(page: SettingsPage): boolean {
  const { chatReadiness, connectorsOn } = useAppStore.getState();
  return pagesOffered({ noModel: noModelSetUp(chatReadiness), connectorsOn }).includes(page);
}
