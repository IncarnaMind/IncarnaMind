import { type UnrunSteps, unrunToolLines } from "../../../../shared/unrunTools";
import { useT } from "../../i18n";
import { ProblemLine } from "../ProblemLine";

/** Under a reply that still says a Tool ran when none did, which stays above them (`unrunToolLines`). */
export function UnrunToolLines({ steps, onRetry }: { steps: UnrunSteps; onRetry(): void }) {
  const t = useT();
  return unrunToolLines(t, steps).map(({ tool, text, retry }) => (
    <ProblemLine
      key={tool}
      role="status"
      testId={`answer-unrun-${tool}`}
      action={
        retry
          ? { label: t("answer.notWritten.retry"), testId: "answer-unrun-retry", onClick: onRetry }
          : undefined
      }
    >
      {text}
    </ProblemLine>
  ));
}
