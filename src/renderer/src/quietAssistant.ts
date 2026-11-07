import { create } from "zustand";
import { useComposer } from "./composer";
import { useConversations } from "./conversations";
import { useFirstOpen } from "./firstOpen";
import { stepsShownOf } from "./nudges";
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

const isQuiet = (firstOpen: boolean, revealed: boolean, asked: boolean, askedOwn: boolean) =>
  firstOpen && !revealed && !asked && !askedOwn;

export function useQuietAssistant(): boolean {
  const firstOpen = useFirstOpen();
  const asked = useConversations((state) => state.list.length > 0 || state.openId !== null);
  const askedOwn = useAppStore((state) => state.settings?.device.gettingStarted.askedOwn === true);
  const revealed = useRevealed((state) => state.revealed);
  return isQuiet(firstOpen, revealed, asked, askedOwn);
}

/** The same, read once rather than followed, for a change that isn't a render (#2270). */
export function quietAssistantNow(): boolean {
  const { examples, settings } = useAppStore.getState();
  const firstOpen = Boolean(examples?.mindId) && stepsShownOf(settings?.device.gettingStarted);
  const conversations = useConversations.getState();
  const asked = conversations.list.length > 0 || conversations.openId !== null;
  return isQuiet(
    firstOpen,
    useRevealed.getState().revealed,
    asked,
    settings?.device.gettingStarted.askedOwn === true,
  );
}
