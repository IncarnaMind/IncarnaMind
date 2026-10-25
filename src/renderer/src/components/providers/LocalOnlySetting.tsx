import { useCallback, useId, useRef, useState } from "react";
import { core } from "../../core";
import { useT } from "../../i18n";
import { localModeChosen } from "../../localMode";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { DetailsLine } from "../DetailsLine";
import { UndoLineAt } from "../UndoLine";
import { noticeClass, rowTextClass, rowTitleClass, ruledRowClass } from "../ui";

const PRIVACY_UNDO_PLACE = "settings:privacy";
const TARGET = ["local-mode"] as const;

export function LocalOnlySetting() {
  const t = useT();
  const id = useId();
  const localOnly = useAppStore((state) => state.embedding?.localOnly);
  const readiness = useAppStore((state) => state.chatReadiness);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const chatService = readiness && "provider" in readiness ? readiness.provider.service : null;
  // Showing the dialog moves the focus after this runs, as for the author name.
  const focusSwitch = useCallback(
    () => queueMicrotask(() => field.current?.focus({ preventScroll: true })),
    [],
  );
  const row = useSettingsTarget<HTMLDivElement>(TARGET, localOnly !== undefined, focusSwitch);

  if (localOnly === undefined) return null;

  const change = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await core.setLocalOnly(enabled);
      await localModeChosen(!enabled, PRIVACY_UNDO_PLACE);
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={row} data-testid="local-only-setting" className="flex flex-col">
      <div className={ruledRowClass}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={id} className={rowTitleClass}>
            {t("embeddingProviders.localOnly.label")}
          </label>
          <DetailsLine
            id={`${id}-description`}
            testId="embedding-local-only-description"
            className={rowTextClass}
            details={t("embeddingProviders.localOnly.body.details")}
          >
            {t("embeddingProviders.localOnly.body")}
          </DetailsLine>
          {localOnly && chatService && (
            <p className={`mt-1.5 ${noticeClass}`}>
              {t("embeddingProviders.localOnly.cloudChat", { service: chatService.name })}
            </p>
          )}
        </div>
        <input
          ref={field}
          id={id}
          type="checkbox"
          role="switch"
          data-testid="local-only"
          aria-describedby={`${id}-description`}
          checked={localOnly}
          aria-checked={localOnly}
          aria-busy={busy}
          onChange={(event) => void change(event.target.checked)}
          className="switch"
        />
      </div>
      <UndoLineAt place={PRIVACY_UNDO_PLACE} />
    </div>
  );
}
