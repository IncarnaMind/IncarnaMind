import { useT } from "../../i18n";
import { organizeDocuments } from "../../organizeDocuments";
import { fixOrganizeProblem } from "../../organizeFix";
import { PROBLEM_FIX, problemAction, problemLine, type ReviewProblem } from "../../reviewProblems";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";

/**
 * One cause behind several Documents Organize couldn't sort (#2308): the
 * Library's own words for it and the one action that fits it. A cause it
 * can't name offers Try again alone (#2308).
 */
export function ReviewProblemLine({
  problem,
  serviceName,
}: {
  problem: ReviewProblem;
  serviceName: string | null;
}) {
  const t = useT();
  const fixLabel =
    problemAction(problem.kind, serviceName) === "fix" ? PROBLEM_FIX[problem.kind] : undefined;
  const retry = {
    label: t("answer.error.retry"),
    testId: "library-review-problem-retry",
    onClick: () =>
      void organizeDocuments(problem.documentIds).catch(useAppStore.getState().reportError),
  };
  return (
    <div
      data-testid="library-review-problem"
      data-kind={problem.kind}
      className="pr-1.5 pb-1 pl-14"
    >
      <ProblemLine
        role="status"
        action={
          fixLabel
            ? {
                label: t(fixLabel),
                testId: "library-review-problem-fix",
                onClick: () => void fixOrganizeProblem(problem.kind),
              }
            : retry
        }
      >
        {problemLine(problem.kind, problem.documentIds.length, serviceName, t)}
      </ProblemLine>
    </div>
  );
}
