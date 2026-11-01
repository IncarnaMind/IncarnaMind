import { type CommandClaimSteps, unbackedCommandLines } from "../../../../shared/unbackedCommands";
import { useT } from "../../i18n";
import { ProblemLine } from "../ProblemLine";

/** Under a reply that still says it did something in the app no call did, which stays above them (`unbackedCommandLines`). */
export function UnbackedCommandLines({
  steps,
  onRetry,
}: {
  steps: CommandClaimSteps;
  onRetry(): void;
}) {
  const t = useT();
  return unbackedCommandLines(t, steps).map(({ what, text, retry }) => (
    <ProblemLine
      key={what}
      role="status"
      testId="answer-unbacked-command"
      action={
        retry
          ? {
              label: t("answer.notWritten.retry"),
              testId: "answer-unbacked-command-retry",
              onClick: onRetry,
            }
          : undefined
      }
    >
      {text}
    </ProblemLine>
  ));
}
