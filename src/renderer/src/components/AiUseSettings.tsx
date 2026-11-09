import { useEffect, useRef, useState } from "react";
import type { AiUseCleared } from "../../../core/api";
import { core } from "../core";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { SettingsGroup, SettingsRow, SettingsSection } from "./settings/SettingsGroup";
import { buttonStyle } from "./ui";

const reportError = (failure: unknown) => useAppStore.getState().reportError(failure);

/**
 * Settings → Privacy: the record of AI use stays on this computer (#292). One
 * line saying so, and, once it holds entries, how many and Clear, which
 * happens at once and offers Undo here, where the button was, since the
 * sidebar's undo line is behind this dialog (#2870).
 */
export function AiUseSettings() {
  const t = useT();
  const [entries, setEntries] = useState<number | null>(null);
  const [cleared, setCleared] = useState<AiUseCleared | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const holdsEntries = entries !== null && entries > 0;

  useEffect(() => {
    core.getAiUseStatus().then((status) => setEntries(status.entries), reportError);
    return core.on("aiUse.changed", (status) => setEntries(status.entries));
  }, []);

  // Clear leaves with the entries it cleared, so the focus goes to the Undo that takes its place.
  useEffect(() => {
    if (cleared) undoButton.current?.focus();
  }, [cleared]);

  const clear = async () => {
    try {
      const result = await core.clearAiUse();
      setCleared(result.count > 0 ? result : null);
    } catch (failure) {
      reportError(failure);
    }
  };
  const undo = async () => {
    if (!cleared) return;
    setCleared(null);
    try {
      await core.restoreAiUse(cleared.clearedAt);
    } catch (failure) {
      reportError(failure);
    }
  };

  return (
    <SettingsSection
      title={t("privacy.aiUse.title")}
      testId="ai-use-record"
      help={
        <>
          <p>{t("privacy.aiUse.body")}</p>
          <p>{t("privacy.aiUse.private")}</p>
        </>
      }
    >
      {(holdsEntries || cleared) && (
        <SettingsGroup>
          {holdsEntries && (
            <SettingsRow
              label={
                <span data-testid="ai-use-entries">
                  {t("privacy.aiUse.entries", { count: entries })}
                </span>
              }
              control={
                <button
                  type="button"
                  data-testid="ai-use-clear"
                  onClick={() => void clear()}
                  className={buttonStyle("secondary", "sm")}
                >
                  {t("privacy.aiUse.clear")}
                </button>
              }
            />
          )}
          {cleared && (
            <SettingsRow
              role="status"
              label={<span data-testid="ai-use-cleared">{t("privacy.aiUse.cleared")}</span>}
              control={
                <button
                  ref={undoButton}
                  type="button"
                  data-testid="ai-use-undo"
                  onClick={() => void undo()}
                  className={buttonStyle("secondary", "sm")}
                >
                  {t("move.undo")}
                </button>
              }
            />
          )}
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}
