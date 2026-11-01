import { type ReactNode, useState } from "react";
import type { Money } from "../../../../core/api";
import { checkTheRest, estimateCheckTheRest } from "../../conversations";
import { estimateLine } from "../../cost";
import { useLanguage, useT } from "../../i18n";
import { LineAction, type ProblemAction } from "../ProblemLine";

/**
 * Check the rest of an Answer's sentences, or Check again on a Citation's card (#2311): it says
 * what judging those not checked costs, "About $A, up to $B", and checks only once the User says
 * so, up to that most. A model with no known price, a plan's or one on this computer checks at
 * once: there is nothing to say.
 */
export function CheckTheRest({
  answer,
  label,
  testId = "answer-check-the-rest",
  action = (each) => <LineAction action={each} />,
}: {
  answer: { id: string; conversationId: string };
  /** Its words; Check the rest when left out. */
  label?: string;
  testId?: string;
  /** How each of its actions is drawn where it stands. */
  action?: (action: ProblemAction) => ReactNode;
}) {
  const t = useT();
  const language = useLanguage();
  const [asked, setAsked] = useState<{ line: string; most: Money | null } | null>(null);
  if (!asked) {
    return action({
      label: label ?? t("steps.check.checkTheRest"),
      testId,
      onClick: async () => {
        const estimate = await estimateCheckTheRest(answer);
        if (estimate?.billing !== "per-token") return checkTheRest(answer, null);
        const line = estimateLine(estimate, t, language, { always: true });
        const most = estimate.upTo?.cost ?? estimate.cost;
        if (!line) return checkTheRest(answer, most);
        setAsked({ line: line.title, most });
      },
    });
  }
  return (
    <span data-testid={`${testId}-ask`}>
      {asked.line}
      <span aria-hidden="true"> · </span>
      {action({
        label: t("steps.check.checkTheRest.go"),
        testId: `${testId}-go`,
        onClick: () => {
          setAsked(null);
          checkTheRest(answer, asked.most);
        },
      })}
      <span aria-hidden="true"> · </span>
      {action({
        label: t("steps.check.checkTheRest.cancel"),
        testId: `${testId}-cancel`,
        onClick: () => setAsked(null),
      })}
    </span>
  );
}
