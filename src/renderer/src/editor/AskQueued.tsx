import { giveBackQueuedAsk, useAskQueue } from "../askQueue";
import { ProblemLine } from "../components/ProblemLine";
import { useT } from "../i18n";

/**
 * The Question typed while an Answer was being written (#2866): one line above the box, so
 * pressing Enter shows what it did. Cancel puts its words back in the box `draftKey`.
 */
export function AskQueued({ draftKey }: { draftKey: string }) {
  const t = useT();
  const queued = useAskQueue((state) => state.waiting);
  if (!queued) return null;
  return (
    <ProblemLine
      role="status"
      testId="ask-queued"
      className="composer-problem"
      action={{
        label: t("composer.queued.cancel"),
        testId: "ask-queued-cancel",
        onClick: () => giveBackQueuedAsk(draftKey),
      }}
    >
      {t("composer.queued")}
    </ProblemLine>
  );
}
