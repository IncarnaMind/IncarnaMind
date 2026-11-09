import { useEffect } from "react";
import { returnToBox, takeQueuedAsk, useAskQueue } from "../askQueue";
import { answerBeingWritten, askInAssistant, useAnswerBeingWritten } from "../conversations";

/**
 * Asks the Question typed while an Answer was being written (#2866) as soon as none is, however
 * the Answer ended, Stop included. Not in another conversation than the one it was typed in: a
 * move takes the Answer being written from view, so the effect runs, and the Question's words go
 * back to the box `key` instead of being asked there.
 */
export function useQueuedAsk(key: string): void {
  const queued = useAskQueue((state) => state.waiting);
  const writing = useAnswerBeingWritten();
  useEffect(() => {
    if (!queued) return;
    if (!queued.stayed()) {
      takeQueuedAsk();
      returnToBox(key, queued.draft);
      return;
    }
    // Another ask this turn may have started a new Answer already.
    if (writing !== null || answerBeingWritten() !== null) return;
    const waiting = takeQueuedAsk();
    if (!waiting) return;
    void askInAssistant(waiting.input).then((asked) => {
      if (!asked) returnToBox(key, waiting.draft);
    });
  }, [queued, writing, key]);
}
