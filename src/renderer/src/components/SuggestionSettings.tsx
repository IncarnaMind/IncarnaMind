import { useCallback, useEffect, useState } from "react";
import type { SuggestionStatus } from "../../../core/api";
import { core } from "../core";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { SettingsGroup, SettingsSection, SettingsSwitchRow } from "./settings/SettingsGroup";

/**
 * Settings → General → Writing: the switch for suggestions as the User
 * writes (#282), off by default, what it does, today's counts once there is
 * a suggestion (#2870), and why suggestions that are on can't be made now. Turning it on asks for consent
 * first when the chat model sends to a service (the core asks, naming it).
 */
export function SuggestionSettings() {
  const t = useT();
  const on = useAppStore((state) => state.settings?.user.suggestWhileWriting);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const reportError = useAppStore((state) => state.reportError);
  const [status, setStatus] = useState<SuggestionStatus | null>(null);

  // Settings keeps its pages mounted: the status is read again each time General shows, and
  // when what it depends on changes (the switch, the chat model, whether it can be used).
  const shown = useAppStore((state) => state.settingsOpen && state.settingsPage === "general");
  const chatModel = useAppStore((state) => state.settings?.user.chatModel);
  const readiness = useAppStore((state) => state.chatReadiness);

  const refresh = useCallback(
    () => core.getSuggestionStatus().then(setStatus, reportError),
    [reportError],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model and readiness are when to read the status again, not what it is read from.
  useEffect(() => {
    if (on !== undefined && shown) void refresh();
  }, [on, shown, chatModel, readiness, refresh]);
  if (on === undefined) return null;

  const turn = async (next: boolean) => {
    await updateSettings({ user: { suggestWhileWriting: next } });
    await refresh();
  };
  const paused = on ? status?.paused : null;
  const counted = status && status.today.shown > 0 ? status.today : null;

  return (
    <SettingsSection title={t("suggestions.settings.title")} testId="suggestion-settings">
      <SettingsGroup>
        <SettingsSwitchRow
          label={t("suggestions.settings.switch")}
          tip={t("suggestions.settings.tip")}
          detail={
            (counted || paused) && (
              <>
                {counted && (
                  <p data-testid="suggestion-counts">{t("suggestions.settings.today", counted)}</p>
                )}
                {paused && (
                  <p data-testid="suggestion-paused" role="status">
                    {paused.reason === "consent"
                      ? t("suggestions.settings.paused.consent", { service: paused.service.name })
                      : t(`suggestions.settings.paused.${paused.reason}`)}
                    {paused.reason === "consent" && (
                      <>
                        <span aria-hidden="true"> · </span>
                        <button
                          type="button"
                          data-testid="suggestion-allow"
                          onClick={() => void turn(true)}
                          className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
                        >
                          {t("suggestions.settings.allow")}
                        </button>
                      </>
                    )}
                  </p>
                )}
              </>
            )
          }
          checked={on}
          onChange={(next) => void turn(next)}
          switchTestId="suggestion-switch"
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
