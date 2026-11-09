/**
 * The help replies the floating panel asked for itself (#2847). Once the panel no longer shows one
 * (the next press replaced it and it isn't pinned, or it was unpinned), its check ends; the reply
 * goes on. A reply asked in the assistant or through ⌘K is never its to end, though the panel shows
 * it, and a pinned one keeps its check. Main hears which it shows, to end theirs when it closes.
 */
import type { ShownHelp } from "../../../shared/meetingPanel";

export function createOwnHelps({
  end,
  tell,
}: {
  /** Ends a reply's check, never the reply. */
  end(help: ShownHelp): void;
  /** The replies it asked that it shows now. */
  tell(helps: ShownHelp[]): void;
}) {
  const own = new Map<string, ShownHelp>();
  let shown = new Set<string>();
  const report = () => tell([...own.values()].filter((help) => shown.has(help.answerId)));
  return {
    /** A press of the panel's own was asked. */
    asked(help: ShownHelp): void {
      own.set(help.answerId, help);
      report();
    },
    /** The replies the panel shows now, by Answer, the latest and the pinned ones. */
    showing(answerIds: readonly string[]): void {
      const now = new Set(answerIds);
      for (const [answerId, help] of own) {
        if (shown.has(answerId) && !now.has(answerId)) {
          own.delete(answerId);
          end(help);
        }
      }
      shown = now;
      report();
    },
  };
}
