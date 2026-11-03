import { create } from "zustand";
import { useComposer } from "./composer";
import { useConversations } from "./conversations";
import { useFirstOpen } from "./firstOpen";
import { useAppStore } from "./store";

const useRevealed = create<{ revealed: boolean }>(() => ({ revealed: false }));

// The pill and ⌘J ask for the panel by asking for the composer.
useComposer.subscribe((state) => {
  if (state.focusWanted) useRevealed.setState({ revealed: true });
});

/** Shows the assistant, with its composer and any setup card: revealed if it is still quiet, and unfolded. */
export function revealAssistant(): void {
  useRevealed.setState({ revealed: true });
  const { layout, placeAssistant } = useAppStore.getState();
  if (layout?.assistant.folded) void placeAssistant({ folded: false });
}

export function useQuietAssistant(): boolean {
  const firstOpen = useFirstOpen();
  const asked = useConversations((state) => state.list.length > 0 || state.openId !== null);
  const askedOwn = useAppStore((state) => state.settings?.device.gettingStarted.askedOwn === true);
  const revealed = useRevealed((state) => state.revealed);
  return firstOpen && !revealed && !asked && !askedOwn;
}
