import type { AnswerToolCall, ConversationAnswer, UserAnswer } from "../../../../core/api";
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
  return t("asks.call.chose", { choice: answeredWords(t, answer, true) });
}

/**
 * The User's answer in their own words: the options they chose, and what they
 * wrote under Other…. The row quotes what they wrote; their bubble says it as
 * they did.
 */
function answeredWords(
  t: Translate,
  answer: Extract<UserAnswer, { skipped: false }>,
  quote: boolean,
): string {
  const choices = [
    ...answer.chosen,
    ...(answer.wrote === null
      ? []
      : [quote ? t("asks.call.wrote", { words: answer.wrote }) : answer.wrote]),
  ];
  return choices.join(t("asks.call.separator"));
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

/**
 * The question the assistant asked, folded to its words, and the User's answer
 * to it as their own bubble (#2530): once answered, the card's options go and
 * the thread shows only the question and what the User chose.
 */
export function AskedLines({ answer }: { answer: ConversationAnswer }) {
  const t = useT();
  const asked = answer.toolCalls.filter((call) => call.asked?.answer);
  if (asked.length === 0) return null;
  return (
    <div className="answer-asked">
      {asked.map((call) => {
        const question = call.asked;
        if (!question?.answer) return null;
        return (
          <div key={call.id} data-testid="answer-asked-turn" className="answer-asked-turn">
            <p data-testid="answer-asked-question" className="answer-asked-question">
              {question.question}
            </p>
            {question.answer.skipped ? (
              <p data-testid="answer-asked" className="answer-asked-line">
                {askCallText(t, call)}
              </p>
            ) : (
              <div data-testid="answer-asked-answer" className="assistant-question">
                <p className="assistant-question-bubble">
                  <span className="sr-only" data-testid="answer-asked-chose">
                    {t("asks.call.chose", { choice: answeredWords(t, question.answer, true) })}
                  </span>
                  <span aria-hidden="true" data-testid="answer-asked-words">
                    {answeredWords(t, question.answer, false)}
                  </span>
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
