import { ANSWER_CHECKING_LIMIT } from "../../shared/answerChecking";
import { formatMoney } from "./cost";
import { useLanguage } from "./i18n";

/** The Answer's own checking limit as the interface says it. */
export function useJudgementLimit(): string {
  return formatMoney(ANSWER_CHECKING_LIMIT, useLanguage());
}
