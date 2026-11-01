import { ANSWER_CHECKING_LIMIT } from "../../shared/answerChecking";
import { formatMoney } from "./cost";
import { useLanguage } from "./i18n";
import { useAppStore } from "./store";

/** The two limits as the interface says them: the Answer's own, and the monthly cap the User set. */
export function useJudgementLimit(): { limit: string; cap: string } {
  const language = useLanguage();
  const cap = useAppStore((state) => state.settings?.user.monthlyCap ?? null);
  return {
    limit: formatMoney(ANSWER_CHECKING_LIMIT, language),
    cap: cap ? formatMoney(cap, language) : "",
  };
}
