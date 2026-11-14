import type { CitationCheckReason } from "../../core/api";
import type { Translate } from "./objects";

/**
 * What a Citation's card says when a limit stopped its sentence's check (#2311), or kept its batch
 * too short for `model` to finish it (#2962); null for any other reason. `limit` is the Answer's
 * own, which is fixed. The monthly cap is named without an amount: the cap set now may not be the
 * one that stopped the check.
 */
export function limitReason(
  t: Translate,
  reason: CitationCheckReason | null | undefined,
  limit: string,
  model: string | null,
): string | null {
  switch (reason) {
    case "answer-limit":
      return t("citation.reason.answer-limit", { limit });
    case "monthly-limit":
      return t("citation.reason.monthly-limit");
    case "answer-limit-unfinished":
      return model
        ? t("citation.reason.answer-limit-unfinished", { limit, model })
        : t("citation.reason.answer-limit-unfinished.unnamed", { limit });
    case "monthly-limit-unfinished":
      return model
        ? t("citation.reason.monthly-limit-unfinished", { model })
        : t("citation.reason.monthly-limit-unfinished.unnamed");
    default:
      return null;
  }
}

/** The line under an Answer whose check a limit stopped or kept too short (#2311, #2962). */
export function stoppedLine(
  t: Translate,
  stopped: { by: "answer-limit" | "monthly-limit"; checked: number; total: number },
  limit: string,
): string {
  const values = { checked: stopped.checked, total: stopped.total };
  return stopped.by === "answer-limit"
    ? t("steps.check.answerLimit", { ...values, limit })
    : t("steps.check.monthlyLimit", values);
}
