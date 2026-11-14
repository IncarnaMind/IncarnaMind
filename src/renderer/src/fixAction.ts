import type { ProviderErrorKind } from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { signInAgain } from "./chatGptSignIn";
import { useKeyRefusals } from "./keyRefusals";
import { requestModelMenu } from "./modelMenu";
import type { AnswerFix } from "./problems";
import type { SettingsPage, SettingsTarget } from "./settingsPages";

/** A failed request, as the action that fixes it needs to know it. */
export interface FailedRequest {
  kind: ProviderErrorKind;
  providerId: string | null;
  modelId: string | null;
  /** When it failed (ISO 8601), said beside a refused key. */
  failedAt: string | null;
  /** The composer's model menu is here: "Choose another model" opens it, not Settings. */
  chooseHere?: boolean;
  onOpenSettings(page: SettingsPage, at?: SettingsTarget): void;
  onRetry?: (() => void) | undefined;
}

/**
 * The action a failed request's line offers for its problem's `fix` (`answerProblem`): checking a
 * refused key, a page of Settings, signing in again, the provider's own page, or trying again.
 * Undefined where there is nothing to offer.
 */
export function fixAction(
  fix: AnswerFix,
  failed: FailedRequest,
  t: (key: MessageKey, params?: MessageParams) => string,
): { label: string; onClick(): void } | undefined {
  const { kind, providerId, modelId, failedAt, onOpenSettings, onRetry } = failed;
  if (kind === "auth") {
    return {
      label: t("answer.error.checkKey"),
      onClick: () => void useKeyRefusals.getState().check(providerId, modelId ?? "", failedAt),
    };
  }
  if (fix.kind === "settings") {
    const chooseModel = fix.page === "ai" && fix.at === undefined;
    return {
      label: t(fix.label),
      onClick: () =>
        chooseModel && failed.chooseHere ? requestModelMenu() : onOpenSettings(fix.page, fix.at),
    };
  }
  if (fix.kind === "sign-in") {
    return {
      label: t(fix.label),
      onClick: () =>
        void signInAgain(onOpenSettings).then((signedIn) => {
          if (signedIn) onRetry?.();
        }),
    };
  }
  if (fix.kind === "link") {
    // The main process opens it in the User's browser.
    return {
      label: `${t(fix.label)} ↗`,
      onClick: () => {
        if (kind === "out-of-credit") useKeyRefusals.getState().openBilling(providerId, fix.url);
        else window.open(fix.url, "_blank", "noreferrer");
      },
    };
  }
  if (fix.kind === "retry" && onRetry) return { label: t(fix.label), onClick: onRetry };
  return undefined;
}
