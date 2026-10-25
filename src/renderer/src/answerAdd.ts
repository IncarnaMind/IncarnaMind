import { answerSentences } from "../../shared/answerSentences";

export const LONG_ANSWER_SENTENCES = 3;

export function addNamesItsMind(
  answer: { text: string; citations: readonly unknown[] },
  mindEmpty: boolean,
): boolean {
  return (
    mindEmpty ||
    (answer.citations.length > 0 && answerSentences(answer.text).length > LONG_ANSWER_SENTENCES)
  );
}
