import type { ExternalService, ProviderError } from "../../core/api";
import type { Language } from "../../core/language";
import { CHATGPT_SERVICE } from "../../core/providers/chatgpt/service";
import { CLAUDE_ACCOUNT_SERVICE } from "../../core/providers/claudeAccount/service";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { formatResetTime } from "./cost";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * Why a Document couldn't be tagged, in the interface language: the core's words when it gave
 * them, else a line that names no service, since a Document doesn't record which one tagged it.
 */
export const taggingProblem = (error: ProviderError, t: Translate): string =>
  error.wording ? t(error.wording.key, error.wording.values) : t(`tagging.problem.${error.kind}`);

/** The plans whose limit Tagging and Organize wait out (src/core/library/planPace), by their service. */
const WAITING_PLANS: ReadonlySet<string> = new Set([CHATGPT_SERVICE.id, CLAUDE_ACCOUNT_SERVICE.id]);

/**
 * What the sidebar says while Tagging and Organize wait for a plan's limit: the plan by name when
 * `service`, the one they send to, is one, and when it resets while that is still ahead.
 */
export function planLimitLine(
  service: ExternalService | null,
  resetsAt: string | null,
  t: Translate,
  language: Language,
  now = new Date(),
): string {
  const plan = service && WAITING_PLANS.has(service.id) ? service.name : null;
  const time =
    resetsAt && Date.parse(resetsAt) > now.getTime()
      ? formatResetTime(resetsAt, language, now)
      : null;
  if (plan) {
    return time ? t("status.planLimit.until", { plan, time }) : t("status.planLimit", { plan });
  }
  return time ? t("status.planLimit.unnamed.until", { time }) : t("status.planLimit.unnamed");
}
