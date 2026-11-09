import { create } from "zustand";
import type { AskedQuote } from "../../core/api";
import { type Draft, type Paste, useComposer, withQuotes } from "./composer";
import type { askInAssistant } from "./conversations";

/** What the composer hands the assistant to ask. */
export type AskInput = Parameters<typeof askInAssistant>[0];

/** What the box held when the Question was queued, to give back if it is cancelled or not asked. */
export interface QueuedDraft {
  text: string;
  pastes: Paste[];
  skill: string | null;
  analyse: boolean;
  quotes: AskedQuote[];
}

/** A Question typed while an Answer was being written (#2866). */
export interface QueuedAsk {
  input: AskInput;
  draft: QueuedDraft;
  /** Whether the assistant is still in the conversation it was typed in. */
  stayed(): boolean;
}

/** The Question waiting for the Answer being written: one at most, a second replaces it. */
export const useAskQueue = create<{ waiting: QueuedAsk | null }>(() => ({ waiting: null }));

export const queueAsk = (item: QueuedAsk): void => useAskQueue.setState({ waiting: item });

/** Takes the queued Question once it may be asked, and clears it; null when none waits. */
export function takeQueuedAsk(): QueuedAsk | null {
  const { waiting } = useAskQueue.getState();
  if (waiting) useAskQueue.setState({ waiting: null });
  return waiting;
}

/**
 * The box as it is once a Question comes back to it: its words ahead of anything typed since,
 * so neither is lost.
 */
export function draftWithQueued(queued: QueuedDraft, now: Draft): Partial<Draft> {
  const text = [queued.text, now.text].filter((part) => part.trim() !== "").join("\n");
  return {
    text,
    pastes: [...queued.pastes, ...now.pastes],
    skill: now.skill ?? queued.skill,
    analyse: now.analyse === true || queued.analyse,
    quotes: withQuotes(queued.quotes, now.quotes ?? []),
  };
}

/** Puts the queued Question's words back in the box `key`, unsent, and gives it the cursor. */
export function giveBackQueuedAsk(key: string): void {
  const queued = takeQueuedAsk();
  if (!queued) return;
  returnToBox(key, queued.draft);
}

/** Puts a Question's words back in the box `key`, unsent, and gives it the cursor. */
export function returnToBox(key: string, draft: QueuedDraft): void {
  const composer = useComposer.getState();
  composer.update(key, draftWithQueued(draft, composer.draft(key)));
  composer.requestFocus();
}
