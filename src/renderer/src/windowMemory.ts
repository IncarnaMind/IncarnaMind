import { useComposer, withReloaded } from "./composer";
import { noMoveSince, useConversations } from "./conversations";
import { core } from "./core";

/**
 * What the window keeps through a reload of its page (#1500), when a failure in it was too
 * wide to draw again in place: the conversation the assistant shows and what is typed in its
 * composer. It lives as long as the window does: quitting starts afresh, as before.
 */
const CONVERSATION_KEY = "incarnamind.window.conversation";
const DRAFTS_KEY = "incarnamind.window.drafts";

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

async function showAgain(conversationId: string): Promise<void> {
  const stayed = noMoveSince();
  try {
    const { messages } = await core.getConversation(conversationId);
    const { openId } = useConversations.getState();
    // Not over a conversation the User opened or asked in by now, nor over a New chat they chose.
    // A New chat left the open conversation empty, as it was: what a reload shows is kept here.
    if (!stayed() || openId !== null) {
      write(CONVERSATION_KEY, openId);
      return;
    }
    useConversations.setState({ openId: conversationId, messages });
  } catch {
    // Deleted meanwhile: the assistant starts a new chat, as it does without a reload.
  }
}

/** Puts back what a reload of the page left, and keeps it as it changes. */
export function installWindowMemory(): void {
  useComposer.setState((state) => ({ drafts: withReloaded(state.drafts, read(DRAFTS_KEY)) }));
  useComposer.subscribe((state, previous) => {
    if (state.drafts !== previous.drafts) write(DRAFTS_KEY, state.drafts);
  });

  const conversationId = read(CONVERSATION_KEY);
  useConversations.subscribe((state, previous) => {
    if (state.openId !== previous.openId) write(CONVERSATION_KEY, state.openId);
  });
  if (typeof conversationId === "string") void showAgain(conversationId);
}
