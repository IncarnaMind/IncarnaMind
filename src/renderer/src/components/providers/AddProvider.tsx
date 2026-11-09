import type { ChatProvider } from "../../../../core/api";
import { catalogProvider } from "../../../../core/providers/catalog/providers";
import { useLanguage, useT } from "../../i18n";
import type { KeyRefusal } from "../../keyRefusals";
import { SettingsBackLink } from "../SettingsBackLink";
import { SettingsGroup, SettingsRow, SettingsSection } from "../settings/SettingsGroup";
import { KeepLocalChoice } from "./KeepLocalChoice";
import { LocalModeUnavailable } from "./LocalModeUnavailable";
import { OllamaAction, OllamaProgress, ollamaDescription, useOllama } from "./OllamaCard";
import { ProviderForm } from "./ProviderForm";
import { ProviderLogo } from "./ProviderLogo";
import { keyProviderName, MODELS_UNDO_PLACE } from "./shared";

export function AddProvider({
  catalogId,
  endpoint,
  providers,
  refused,
  onBack,
  onAdded,
}: {
  catalogId: string;
  endpoint: string | null;
  providers: readonly ChatProvider[];
  refused: KeyRefusal | null;
  onBack(): void;
  onAdded(provider: ChatProvider, keyNotChecked?: boolean): void;
}) {
  const t = useT();
  const language = useLanguage();
  const group = catalogProvider(catalogId)?.group;
  const hosted = group === "international" || group === "china";
  const name =
    catalogId === "openai-compatible"
      ? t("providers.form.title.server")
      : keyProviderName(catalogId, t, language);
  return (
    <section data-testid="provider-add" data-catalog-id={catalogId} className="flex flex-col gap-6">
      <SettingsBackLink label={t("settings.pages.ai")} testId="models-back" onBack={onBack} />
      <header className="flex items-center gap-3">
        <ProviderLogo id={catalogProvider(catalogId) ? catalogId : null} large />
        <h4
          data-testid="provider-page-title"
          className="min-w-0 truncate text-[17px] leading-6 font-semibold text-ink"
          title={name}
        >
          {name}
        </h4>
      </header>
      {hosted && <LocalModeUnavailable />}
      {catalogId === "ollama" ? (
        <AddOllama onAdded={onAdded} />
      ) : (
        <ProviderForm
          key={`${catalogId}:${endpoint ?? ""}`}
          only={catalogId}
          initialEndpoint={endpoint}
          providers={providers}
          refused={refused}
          onSaved={onAdded}
          keepDefault
          grouped
        />
      )}
    </section>
  );
}

function AddOllama({ onAdded }: { onAdded(provider: ChatProvider): void }) {
  const t = useT();
  const ollama = useOllama(onAdded, MODELS_UNDO_PLACE, { keepDefault: true });
  return (
    <div className="flex flex-col gap-6">
      <SettingsSection>
        <SettingsGroup>
          <SettingsRow
            label={<span data-testid="ollama-status">{ollamaDescription(ollama, t)}</span>}
          />
          {ollama.status?.running && (
            <KeepLocalChoice keepLocal={ollama.keepLocal} disabled={ollama.pulling} />
          )}
        </SettingsGroup>
      </SettingsSection>
      <OllamaProgress ollama={ollama} />
      <div>
        <OllamaAction ollama={ollama} />
      </div>
    </div>
  );
}
