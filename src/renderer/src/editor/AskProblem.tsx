import type { AskBlock } from "../answers";
import { ProblemLine } from "../components/ProblemLine";
import { ReadinessLine } from "../components/providers/ChatReadinessNotice";
import { useT } from "../i18n";
import { skillTitle } from "../skills";

/**
 * Why a Question couldn't be asked, or an Answer written again: one line,
 * where it was asked, with the one thing that fixes it (in local mode, a
 * Question to a model that isn't on this computer, refused before anything
 * was sent: a local model, or local mode off). For a Question that
 * forces a Skill that is off or gone, asking without it, where that can be
 * done; an Answer whose Edits ask first shows its own notice instead.
 */
export function AskProblem({
  problem,
  testIds,
  className,
  onAskWithoutSkill,
}: {
  problem: AskBlock;
  /** The line's test id by kind, as the composer and an Answer name them. */
  testIds: { notReady: string; skillUnavailable: string; error: string };
  className?: string;
  onAskWithoutSkill?: () => void;
}) {
  const t = useT();
  if (problem.kind === "not-ready") {
    return (
      <ReadinessLine
        readiness={problem.readiness}
        testId={testIds.notReady}
        {...(className && { className })}
        setUpLabel={t("question.setUp")}
      />
    );
  }
  if (problem.kind === "skill-unavailable") {
    return (
      <ProblemLine
        testId={testIds.skillUnavailable}
        className={className}
        action={
          onAskWithoutSkill && { label: t("skills.unavailable.drop"), onClick: onAskWithoutSkill }
        }
      >
        {t(`skills.unavailable.${problem.state}`, { name: skillTitle(problem.skill, t) })}
      </ProblemLine>
    );
  }
  if (problem.kind === "error") {
    return (
      <ProblemLine testId={testIds.error} className={className}>
        {t("error.action", { message: problem.message })}
      </ProblemLine>
    );
  }
  return null;
}
