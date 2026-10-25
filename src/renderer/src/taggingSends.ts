import type { MessageKey, MessageParams } from "../../shared/i18n";

/**
 * What tagging sends, in one sentence: to the service that tags, or nowhere
 * off this computer when a model here does; with page images added when
 * Organize reads scans. Each dictionary joins its own sentences. Its status
 * row says it in a popover, so the row stays one line.
 */
export const taggingSends = (
  service: string | null,
  t: (key: MessageKey, params?: MessageParams) => string,
  scans = false,
): string =>
  service
    ? t(scans ? "status.sends.scans" : "status.sends", { service })
    : t(scans ? "status.sends.onThisComputer.scans" : "status.sends.onThisComputer");
