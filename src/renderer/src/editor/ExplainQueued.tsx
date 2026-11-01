import { ProblemLine } from "../components/ProblemLine";
import { cancelExplain, useExplainQueue } from "../explainQueue";
import { useT } from "../i18n";

/**
 * An Explain asked while an Answer was being written (#2348): it waits there, in view, and the
 * User can cancel it. It goes when its Question is asked.
 */
export function ExplainQueued({ mindId }: { mindId: string }) {
  const t = useT();
  const queued = useExplainQueue((state) => state.waiting);
  if (!queued || queued.mindId !== mindId) return null;
  return (
    <ProblemLine
      role="status"
      testId="explain-queued"
      className="composer-problem"
      action={{
        label: t("explain.queued.cancel"),
        testId: "explain-queued-cancel",
        onClick: cancelExplain,
      }}
    >
      {t("explain.queued")}
    </ProblemLine>
  );
}
