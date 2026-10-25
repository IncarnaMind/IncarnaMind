import { useId } from "react";
import { modelName } from "../../../shared/modelName";
import { searchesTheWeb } from "../../../shared/webSearch";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { InfoTip } from "./InfoTip";
import { providerLabel } from "./providers/shared";
import {
  hintClass,
  rowStatusClass,
  rowTitleClass,
  ruledListClass,
  ruledRowClass,
  sectionTitleClass,
} from "./ui";

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
  const id = useId();
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
    <section data-testid="web-search-settings">
      <h4 className={`mb-2 ${sectionTitleClass}`}>{t("web.settings.title")}</h4>
      <div className={ruledListClass}>
        <div className={ruledRowClass}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center">
              <label htmlFor={id} className={rowTitleClass}>
                {t("web.settings.switch")}
              </label>
              <InfoTip id={`${id}-description`} text={t("web.settings.tip")} />
            </div>
            {on && status && (
              <p data-testid="web-search-status" role="status" className={hintClass}>
                {status}
              </p>
            )}
          </div>
          <input
            id={id}
            type="checkbox"
            role="switch"
            aria-checked={on}
            aria-describedby={`${id}-description`}
            data-testid="web-search-switch"
            checked={on}
            onChange={(event) => void updateSettings({ user: { webSearch: event.target.checked } })}
            className="switch"
          />
        </div>
        <div className={ruledRowClass}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center">
              <p className={rowTitleClass}>{t("web.settings.route")}</p>
              <InfoTip text={t("web.settings.route.tip")} />
            </div>
          </div>
          <p data-testid="web-search-route" className={`shrink-0 ${rowStatusClass}`}>
            {t("web.settings.route.model")}
          </p>
        </div>
      </div>
    </section>
  );
}
