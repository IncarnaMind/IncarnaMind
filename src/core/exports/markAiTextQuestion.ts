import { translate } from "../../shared/i18n";
import type { MarkAiTextChoice, UserAnswer, UserQuestion } from "../api";
import type { Language } from "../language";

/** The Word export's question about marking the text IncarnaMind wrote, for the assistant's tray (#1535), and how to read the answer. */
export function markAiTextQuestion(language: Language): {
  question: UserQuestion;
  choiceOf(answer: UserAnswer | null): MarkAiTextChoice | null;
} {
  const labels = {
    mark: translate(language, "export.markAiText.mark"),
    leave: translate(language, "export.markAiText.leave"),
  };
  const option = (label: string) => ({
    label,
    description: "",
    recommended: false,
    preselected: false,
  });
  return {
    question: {
      question: translate(language, "export.markAiText"),
      detail: translate(language, "export.markAiText.hint"),
      options: [option(labels.mark), option(labels.leave)],
      multiple: false,
      other: false,
      answer: null,
    },
    choiceOf(answer) {
      if (!answer || answer.skipped) return null;
      const [chosen] = answer.chosen;
      return chosen === labels.mark ? "mark" : chosen === labels.leave ? "leave" : null;
    },
  };
}
