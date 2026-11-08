import { create } from "zustand";
import type { ChatModelChoice } from "../../core/api";
import { sameModel } from "../../shared/mindModel";

/**
 * The model of the conversation the assistant shows, which the chip picks for with no Note in view
 * (#2836). `conversations.ts` keeps `openId` and `lastQuestion` as the conversation it shows
 * changes; a store of its own, so the composer reads it without importing the conversations.
 */
interface ConversationModelState {
  /** The conversation shown; null for a New chat. */
  openId: string | null;
  /** Its last Question, and the model that Question was asked with. */
  lastQuestion: { id: string; model: ChatModelChoice | null } | null;
  /** A model picked for that conversation since `after` was its last Question. */
  pick: { choice: ChatModelChoice; openId: string | null; after: string | null } | null;
}

export const useConversationModel = create<ConversationModelState>()(() => ({
  openId: null,
  lastQuestion: null,
  pick: null,
}));

/**
 * What the conversation shown goes on with: the model picked for it since its last Question, else
 * the one that Question was asked with. Null for a New chat with nothing picked.
 */
export const conversationModel = (state: ConversationModelState): ChatModelChoice | null =>
  state.pick &&
  state.pick.openId === state.openId &&
  state.pick.after === (state.lastQuestion?.id ?? null)
    ? state.pick.choice
    : (state.lastQuestion?.model ?? null);

/** A model picked for the conversation shown: its next Question is asked with it, and keeps it. */
export function pickForConversation(choice: ChatModelChoice): void {
  useConversationModel.setState((state) => ({
    pick: { choice, openId: state.openId, after: state.lastQuestion?.id ?? null },
  }));
}

/** The assistant shows another conversation, or the same one has a new last Question. */
export function showConversationModel(
  openId: string | null,
  lastQuestion: ConversationModelState["lastQuestion"],
): void {
  const now = useConversationModel.getState();
  const was = now.lastQuestion?.model ?? null;
  const is = lastQuestion?.model ?? null;
  // Unchanged as an Answer streams in, so nothing that reads it draws again.
  if (
    now.openId === openId &&
    now.lastQuestion?.id === lastQuestion?.id &&
    (was === is || sameModel(was, is))
  ) {
    return;
  }
  useConversationModel.setState({ openId, lastQuestion });
}

/** A New chat, or a conversation opened afresh: nothing picked for it yet. */
export function forgetConversationPick(): void {
  useConversationModel.setState({ pick: null });
}
