import { useT } from "../../i18n";
import { organizeDocuments } from "../../organizeDocuments";
import { fixOrganizeProblem } from "../../organizeFix";
import { PROBLEM_FIX, PROBLEM_WORDS, type ReviewProblem } from "../../reviewProblems";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";

/**
 * One cause behind several Documents Organize couldn't sort (#2308): the
 * Library's own words for it, the one action that fixes it, and Try again.
 */
export function ReviewProblemLine({ problem }: { problem: ReviewProblem }) {
  const t = useT();
  const fixLabel = PROBLEM_FIX[problem.kind];
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
        also={fixLabel ? retry : undefined}
      >
        {t(PROBLEM_WORDS[problem.kind])}
      </ProblemLine>
    </div>
  );
}
