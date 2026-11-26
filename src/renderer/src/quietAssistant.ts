import { create } from "zustand";
import { useAgentsToAskRead, useReadAgentsToAsk } from "./askYourAi";
import { useComposer } from "./composer";
import { useConversations } from "./conversations";
import { noModelSetUp } from "./noModelSetUp";
import { stepsShownOf } from "./nudges";
import { hiddenForOwnAiNow, ownAiOnlyNow, useHiddenForOwnAi, useOwnAiOnly } from "./ownAiPanel";
import { type AppState, useAppStore } from "./store";

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

// The assistant comes on by its own trigger, the User's first ask or opening it, not with the first
// file of their own that ends the rest of the first open (`firstOpenNow`).
const exampleShown = (state: Pick<AppState, "examples" | "settings">) =>
  Boolean(state.examples?.mindId) && stepsShownOf(state.settings?.device.gettingStarted);

// For a User with only their own AI it is quiet while folded for that AI, until they open it (#3373).
export function useQuietAssistant(): boolean {
  const firstOpen = useAppStore(exampleShown);
  const asked = useConversations((state) => state.list.length > 0 || state.openId !== null);
  const askedOwn = useAppStore((state) => state.settings?.device.gettingStarted.askedOwn === true);
  const revealed = useRevealed((state) => state.revealed);
  const ownAiOnly = useOwnAiOnly() === true;
  const hidden = useHiddenForOwnAi();
  return ownAiOnly ? hidden : isQuiet(firstOpen, revealed, asked, askedOwn);
}

/**
 * Whether the quiet assistant floats its Ask pill: it asks IncarnaMind's own model, so it shows only
 * where one is set up, working or not (the assistant says what it needs), and no AI app of the
 * User's is connected; otherwise a Note's foot is the one place to ask (#3791).
 */
export function useAskPillShown(): boolean {
  const quiet = useQuietAssistant();
  const hidden = useHiddenForOwnAi();
  const modelSetUp = useAppStore(
    (state) => state.chatReadiness !== null && !noModelSetUp(state.chatReadiness),
  );
  useReadAgentsToAsk(null);
  const connected = (useAgentsToAskRead(null)?.length ?? 0) > 0;
  return quiet && !hidden && modelSetUp && !connected;
}

/** The same, read once rather than followed, for a change that isn't a render (#2270). */
export function quietAssistantNow(): boolean {
  const state = useAppStore.getState();
  const { settings } = state;
  const firstOpen = exampleShown(state);
  const conversations = useConversations.getState();
  const asked = conversations.list.length > 0 || conversations.openId !== null;
  if (ownAiOnlyNow()) return hiddenForOwnAiNow();
  return isQuiet(
    firstOpen,
    useRevealed.getState().revealed,
    asked,
    settings?.device.gettingStarted.askedOwn === true,
  );
}
