/**
 * An Explain asked while an Answer is being written (#2348): it waits, in view, until that
 * Answer is done, and it can be cancelled. One waits at most — a second replaces the first —
 * and switching Note drops it, as Stop does.
 */
import { create } from "zustand";
import type { ChatModelChoice, MindFocus, SearchScope } from "../../core/api";

export interface QueuedExplain {
  mindId: string;
  text: string;
  focus: MindFocus;
  scope: SearchScope;
  model: ChatModelChoice | null;
}

export const useExplainQueue = create<{ waiting: QueuedExplain | null }>(() => ({
  waiting: null,
}));

/** Puts a Question in the queue, one at most: a second replaces the first. */
export const queueExplain = (item: QueuedExplain): void =>
  useExplainQueue.setState({ waiting: item });

/** Takes the queued Question once it may be asked, and clears it; null when none waits. */
export function takeExplain(): QueuedExplain | null {
  const { waiting } = useExplainQueue.getState();
  if (waiting) useExplainQueue.setState({ waiting: null });
  return waiting;
}

/** Drops the queued Question: the User cancelled, stopped the Answer, or moved to another Note. */
export const cancelExplain = (): void => useExplainQueue.setState({ waiting: null });
