import type { ProviderError } from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";

/**
 * Why a Document couldn't be tagged, in the interface language: the core's words when it gave
 * them, else a line that names no service, since a Document doesn't record which one tagged it.
 */
export const taggingProblem = (
  error: ProviderError,
  t: (key: MessageKey, params?: MessageParams) => string,
): string =>
  error.wording ? t(error.wording.key, error.wording.values) : t(`tagging.problem.${error.kind}`);
