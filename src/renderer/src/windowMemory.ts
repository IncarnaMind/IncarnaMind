import { useComposer, withReloaded } from "./composer";
import { followShownConversation, showKeptConversation } from "./conversations";
import { useAppStore } from "./store";

/**
 * What the window keeps through a reload of its page (#1500), when a failure in it was too
 * wide to draw again in place: what is typed in its composer, and the conversation the
 * assistant shows, which the window's layout keeps (#258).
 */
const DRAFTS_KEY = "incarnamind.window.drafts";

/** Whether the window follows the assistant's moves, once per page however often it is installed. */
let following = false;

function read(key: string): unknown {
  try {
    const text = sessionStorage.getItem(key);
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not kept, then: a reload starts without it.
  }
}

/** Puts back what a reload of the page left, and keeps it as it changes. */
export function installWindowMemory(): void {
  // Only the window's own page writes the layout: other pages import the conversations module too.
  if (!following) {
    following = true;
    followShownConversation();
  }
  useComposer.setState((state) => ({ drafts: withReloaded(state.drafts, read(DRAFTS_KEY)) }));
  useComposer.subscribe((state, previous) => {
    if (state.drafts !== previous.drafts) write(DRAFTS_KEY, state.drafts);
  });

  // The window's layout is read after the page draws: the conversation it keeps shows once it is.
  let restored = false;
  const restore = () => {
    if (restored) return;
    const layout = useAppStore.getState().layout;
    if (!layout) return;
    restored = true;
    if (layout.conversationId !== null) void showKeptConversation(layout.conversationId);
  };
  useAppStore.subscribe(restore);
  restore();
}
