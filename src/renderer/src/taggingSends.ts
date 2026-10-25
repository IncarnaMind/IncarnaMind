import type { MessageKey, MessageParams } from "../../shared/i18n";

/**
 * What tagging sends, in one sentence: to the service that tags, or nowhere
 * off this computer when a model here does. Its status row says it in a
 * popover, so the row stays one line.
 */
export const taggingSends = (
  service: string | null,
  t: (key: MessageKey, params?: MessageParams) => string,
): string => (service ? t("status.sends", { service }) : t("status.sends.onThisComputer"));
