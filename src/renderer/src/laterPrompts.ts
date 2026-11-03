import { ownMindsOf, useOwnMinds } from "./home";
import { useAppStore } from "./store";

export function laterPromptsAllowedNow(): boolean {
  const state = useAppStore.getState();
  return ownMindsOf(state).length >= 2 || state.settings?.device.gettingStarted.exported === true;
}

export function useLaterPromptsAllowed(): boolean {
  const secondNote = useOwnMinds().length >= 2;
  const exported = useAppStore((state) => state.settings?.device.gettingStarted.exported === true);
  return secondNote || exported;
}
