import { modelName } from "../../../shared/modelName";
import { searchesTheWeb } from "../../../shared/webSearch";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { providerLabel } from "./providers/shared";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "./settings/SettingsGroup";

/**
 * Settings → Search → Search the web (#128): the switch, off by default, and
 * the route, the model's own search, the only one until #129 adds a search
 * Connector. A line says whether the default model's provider has a web
 * search of its own, or that Local mode keeps web search off.
 */
export function WebSearchSettings() {
  const t = useT();
  const language = useLanguage();
  const on = useAppStore((state) => state.settings?.user.webSearch);
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const readiness = useAppStore((state) => state.chatReadiness);
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (on === undefined) return null;

  const provider = readiness && "provider" in readiness ? readiness.provider : null;
  const model = readiness && "modelId" in readiness ? readiness.modelId : null;
  const status = localOnly
    ? t("web.settings.localMode")
    : provider && model
      ? t(searchesTheWeb(provider.kind) ? "web.settings.supported" : "web.settings.unsupported", {
          model: modelName(model, { kind: provider.kind, endpoint: provider.endpoint }),
          provider: providerLabel(provider, t, language),
        })
      : null;

  return (
    <SettingsSection title={t("web.settings.title")} testId="web-search-settings">
      <SettingsGroup>
        <SettingsSwitchRow
          label={t("web.settings.switch")}
          tip={t("web.settings.tip")}
          detail={
            on &&
            status && (
              <p data-testid="web-search-status" role="status">
                {status}
              </p>
            )
          }
          checked={on}
          onChange={(next) => void updateSettings({ user: { webSearch: next } })}
          switchTestId="web-search-switch"
        />
        <SettingsRow
          label={t("web.settings.route")}
          tip={t("web.settings.route.tip")}
          control={
            <span data-testid="web-search-route" className="text-[13px] leading-5 text-ink-meta">
              {t("web.settings.route.model")}
            </span>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
