import type { ChatProvider } from "../../../../core/api";
import { catalogProvider } from "../../../../core/providers/catalog/providers";
import { useLanguage, useT } from "../../i18n";
import type { KeyRefusal } from "../../keyRefusals";
import { SettingsBackLink } from "../SettingsBackLink";
import { LocalModeUnavailable } from "./LocalModeUnavailable";
import { ProviderForm } from "./ProviderForm";
import { ProviderLogo } from "./ProviderLogo";
import { keyProviderName } from "./shared";

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
          className="min-w-0 truncate text-body leading-6 text-ink"
          title={name}
        >
          {name}
        </h4>
      </header>
      {hosted && <LocalModeUnavailable />}
      <ProviderForm
        key={`${catalogId}:${endpoint ?? ""}`}
        only={catalogId}
        initialEndpoint={endpoint}
        providers={providers}
        refused={refused}
        onSaved={onAdded}
        keepDefault="always"
        grouped
      />
    </section>
  );
}
