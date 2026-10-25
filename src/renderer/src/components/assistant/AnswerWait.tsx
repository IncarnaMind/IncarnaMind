import type { ConversationAnswer } from "../../../../core/api";
import { waitText } from "../../answerWaitWords";
import { stopAnswer } from "../../conversations";
import { useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { SLOT } from "../Slotted";

/**
 * Under the live line of an Answer with no words after 15 seconds: how long
 * its model usually takes, or that it is still working, with Stop (#899).
 */
export function AnswerWait({
  answer,
  usual,
}: {
  answer: ConversationAnswer;
  usual: number | null;
}) {
  const t = useT();
  const nameOf = useModelNames();
  const model = answer.model ? nameOf(answer.model.modelId, answer.model.providerId).name : null;
  const [before = "", after] = waitText(t, usual, model === null ? null : SLOT).split(SLOT);
  const name = (
    <span
      data-testid="answer-wait-model"
      className="inline-block max-w-full min-w-0 truncate align-bottom"
    >
      {model}
    </span>
  );
  const endsWithName = after !== undefined && after.trim() === "";
  return (
    <p data-testid="answer-wait" aria-live="polite" className="answer-steps-wait">
      {before}
      {after !== undefined && !endsWithName && name}
      {after}
      <span className="inline-flex max-w-full items-baseline whitespace-nowrap">
        {endsWithName && name}
        <span aria-hidden="true" className="mx-[3px]">
          {"\u00a0·\u00a0"}
        </span>
        <button
          type="button"
          data-testid="answer-stop"
          onClick={() => stopAnswer(answer.id)}
          className="answer-steps-wait-stop"
        >
          {t("answer.stop")}
        </button>
      </span>
    </p>
  );
}
