/**
 * The first own Question with no model set (#103): it waits in the assistant's conversation while
 * the composer becomes the setup card, and is asked as it was once a model is chosen, without
 * being typed again (`askWaitingQuestion`, in ./conversations). "Set up later" gives its words
 * back to the composer.
 */
import { create } from "zustand";
import type { AskInConversationInput } from "../../core/api";
import { NO_MIND, quotesFrom, useComposer, withQuotes } from "./composer";

export type WaitingQuestion = Omit<AskInConversationInput, "conversationId"> & {
  mindId: string | null;
  /** The conversation it was typed in (null: a new chat), where it is asked once a model is set. */
  conversationId: string | null;
};

export const useModelSetup = create<{
  waiting: WaitingQuestion | null;
  wanted: boolean;
  /** A model works: the card says what each job uses, and waits for Continue. */
  ready: boolean;
}>(() => ({
  waiting: null,
  wanted: false,
  ready: false,
}));

const KEPT = "incarnamind.setup.waiting";

function keepWaiting(question: WaitingQuestion | null): void {
  try {
    if (question) {
      const { mindId, text, quotes } = question;
      localStorage.setItem(KEPT, JSON.stringify({ mindId, text, quotes: quotes ?? [] }));
    } else localStorage.removeItem(KEPT);
  } catch (error) {
    console.warn("A Question waiting for a model couldn't be kept on this computer.", error);
  }
}

function restoreWaiting(): void {
  try {
    const kept = localStorage.getItem(KEPT);
    if (!kept) return;
    localStorage.removeItem(KEPT);
    const { mindId, text, quotes } = JSON.parse(kept) as {
      mindId: string | null;
      text: string;
      quotes?: unknown;
    };
    giveBack({ mindId, text, quotes: quotesFrom(quotes) });
  } catch (error) {
    console.warn("The Question kept while waiting for a model couldn't be read.", error);
  }
}

// Quitting before Continue would lose a Question that waits for a model, so its words are kept and
// put back in the composer they were typed in at the next start.
restoreWaiting();
useModelSetup.subscribe((state, before) => {
  if (state.waiting !== before.waiting) keepWaiting(state.waiting);
});

/** The setup card with no Question waiting, which the first open's steps card asks for (#1027). */
export const openModelSetup = (): void => useModelSetup.setState({ wanted: true });

export const useSettingUp = (): boolean =>
  useModelSetup((state) => state.waiting !== null || state.wanted);

/** Keeps a Question that couldn't be asked for want of a model, for the setup card to wait on. */
export const waitForModel = (question: WaitingQuestion): void =>
  useModelSetup.setState({ waiting: question });

/** "Set up later": the Question's words and quotes go back to the composer they were typed in. */
export function giveUpWaiting(): void {
  const { waiting } = useModelSetup.getState();
  useModelSetup.setState({ waiting: null, wanted: false, ready: false });
  if (waiting) giveBack(waiting);
}

// The words only into an empty composer; the quotes whatever it holds, each once.
function giveBack({ mindId, text, quotes }: Pick<WaitingQuestion, "mindId" | "text" | "quotes">) {
  const key = mindId ?? NO_MIND;
  const draft = useComposer.getState().draft(key);
  useComposer.getState().update(key, {
    ...(draft.text === "" && typeof text === "string" && { text }),
    quotes: withQuotes(quotes ?? [], draft.quotes ?? []),
  });
}
