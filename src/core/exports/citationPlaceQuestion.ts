import { type CitedCount, citedCountText } from "../../shared/exportOptions";
import { translate } from "../../shared/i18n";
import type { CitationPlace, UserAnswer, UserQuestion } from "../api";
import type { Language } from "../language";

/** The Word and PDF export's question about where Citations go, for the assistant's tray (#1600), and how to read the answer. */
export function citationPlaceQuestion(
  language: Language,
  cited: CitedCount,
): {
  question: UserQuestion;
  choiceOf(answer: UserAnswer | null): CitationPlace | null;
} {
  const labels = {
    footnotes: translate(language, "export.citationPlace.footnotes"),
    list: translate(language, "export.citationPlace.list"),
  };
  const option = (label: string) => ({
    label,
    description: "",
    recommended: false,
    preselected: false,
  });
  return {
    question: {
      question: translate(language, "export.citationPlace"),
      detail: citedCountText((key, params) => translate(language, key, params), cited),
      options: [option(labels.footnotes), option(labels.list)],
      multiple: false,
      other: false,
      answer: null,
    },
    choiceOf(answer) {
      if (!answer || answer.skipped) return null;
      const [chosen] = answer.chosen;
      return chosen === labels.footnotes ? "footnotes" : chosen === labels.list ? "list" : null;
    },
  };
}
