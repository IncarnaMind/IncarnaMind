import { useState } from "react";
import type { Money } from "../../../../core/api";
import { checkTheRest, estimateCheckTheRest } from "../../conversations";
import { estimateLine } from "../../cost";
import { useLanguage, useT } from "../../i18n";
import { LineAction } from "../ProblemLine";

/**
 * Check the rest, past an Answer's checking limit (#2311): it says what judging the rest costs,
 * "About $A, up to $B", and checks only once the User says so, up to that most. A model with no
 * known price, a plan's or one on this computer checks at once: there is nothing to say.
 */
export function CheckTheRest({ answer }: { answer: { id: string; conversationId: string } }) {
  const t = useT();
  const language = useLanguage();
  const [asked, setAsked] = useState<{ line: string; most: Money | null } | null>(null);
  if (!asked) {
    return (
      <LineAction
        action={{
          label: t("steps.check.checkTheRest"),
          testId: "answer-check-the-rest",
          onClick: async () => {
            const estimate = await estimateCheckTheRest(answer);
            if (estimate?.billing !== "per-token") return checkTheRest(answer, null);
            const line = estimateLine(estimate, t, language, { always: true });
            const most = estimate.upTo?.cost ?? estimate.cost;
            if (!line) return checkTheRest(answer, most);
            setAsked({ line: line.title, most });
          },
        }}
      />
    );
  }
  return (
    <span data-testid="answer-check-the-rest-ask">
      {asked.line}
      <span aria-hidden="true"> · </span>
      <LineAction
        action={{
          label: t("steps.check.checkTheRest.go"),
          testId: "answer-check-the-rest-go",
          onClick: () => {
            setAsked(null);
            checkTheRest(answer, asked.most);
          },
        }}
      />
      <span aria-hidden="true"> · </span>
      <LineAction
        action={{
          label: t("steps.check.checkTheRest.cancel"),
          testId: "answer-check-the-rest-cancel",
          onClick: () => setAsked(null),
        }}
      />
    </span>
  );
}
