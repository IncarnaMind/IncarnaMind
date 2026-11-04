import type { AnswerToolCall } from "../../../../core/api";
import { pythonProblem } from "../../analysisCall";
import { useT } from "../../i18n";
import { ProblemLine } from "../ProblemLine";

/** Under an Answer whose `run_code` couldn't get Python: why, and Try again, which gets it again. */
export function PythonProblemLine({
  calls,
  onRetry,
}: {
  calls: readonly AnswerToolCall[];
  onRetry(): void;
}) {
  const t = useT();
  const problem = pythonProblem(t, calls);
  if (!problem) return null;
  return (
    <ProblemLine
      role="status"
      testId="answer-python-problem"
      action={{
        label: t("answer.notWritten.retry"),
        testId: "answer-python-retry",
        onClick: onRetry,
      }}
    >
      {problem}
    </ProblemLine>
  );
}
