import type { AnswerToolCall, ConversationAnswer } from "../../../../core/api";
import { useT } from "../../i18n";
import type { Translate } from "../../objects";
import { ChatLineIcon } from "../lineIcons";

/** What a question the assistant asked comes to, in its row: waiting, chosen, or skipped. */
export function askCallText(t: Translate, call: AnswerToolCall): string {
  const asked = call.asked;
  const answer = asked?.answer;
  if (!asked || !answer) return t("asks.call.waiting");
  if (answer.skipped) {
    const recommended = asked.options.find((option) => option.recommended);
    return recommended
      ? t("asks.call.skipped", { choice: recommended.label })
      : t("asks.call.skippedNone");
  }
  const choices = [
    ...answer.chosen,
    ...(answer.wrote === null ? [] : [t("asks.call.wrote", { words: answer.wrote })]),
  ];
  return t("asks.call.chose", { choice: choices.join(t("asks.call.separator")) });
}

/** The row of a question the assistant asked the User (#1374), kept in the thread once answered. */
export function AskCall({ call }: { call: AnswerToolCall }) {
  const t = useT();
  const text = askCallText(t, call);
  return (
    <div
      contentEditable={false}
      data-testid="answer-ask-call"
      data-status={call.status}
      className="answer-call"
    >
      <span className="answer-call-summary answer-call-summary--static">
        <ChatLineIcon className="answer-call-icon" />
        <span className="answer-call-text" title={text}>
          {text}
        </span>
      </span>
    </div>
  );
}

/** One line in the thread for each question the User answered or skipped, outside the folded steps. */
export function AskedLines({ answer }: { answer: ConversationAnswer }) {
  const t = useT();
  const asked = answer.toolCalls.filter((call) => call.asked?.answer);
  if (asked.length === 0) return null;
  return (
    <div className="answer-asked">
      {asked.map((call) => (
        <p key={call.id} data-testid="answer-asked" className="answer-asked-line">
          {askCallText(t, call)}
        </p>
      ))}
    </div>
  );
}
