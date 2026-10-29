import type { ExternalService } from "../../../../core/api";
import type { DataUse } from "../../../../core/providers/catalog";
import { CATALOG_PROVIDERS, dataUseOf } from "../../../../core/providers/catalog/providers";
import { OLLAMA_CLOUD } from "../../../../core/providers/ollamaCloud";
import { gap } from "../../../../shared/i18n/join";
import { useLanguage, useT } from "../../i18n";
import { hintClass } from "../ui";

export function ProviderDataUseLine({
  dataUse,
  testId = "provider-data-use",
}: {
  dataUse: DataUse;
  testId?: string;
}) {
  const t = useT();
  const language = useLanguage();
  const words = language === "zh-CN" ? "zh" : "en";
  const summary = t("providers.form.dataUse", { summary: dataUse.summary[words] });
  const link = `${t("providers.form.dataUseLink")} ↗`;
  const href = (words === "zh" && dataUse.zhUrl) || dataUse.url;
  return (
    <p data-testid={testId} className={`${hintClass} mt-0`}>
      {summary}
      {href && (
        <>
          {gap(language, summary, link)}
          <a href={href} target="_blank" rel="noreferrer" className="underline">
            {link}
          </a>
        </>
      )}
    </p>
  );
}

export function ProviderDataUseNotice({ service }: { service: ExternalService }) {
  const provider = CATALOG_PROVIDERS.find((each) =>
    each.endpoints.some((endpoint) => new URL(endpoint.baseUrl).origin === service.id),
  );
  if (!provider) return null;
  const dataUse = dataUseOf(provider, service.id !== OLLAMA_CLOUD.id);
  if (dataUse.training !== "opt-out" && dataUse.training !== "free-tier") return null;
  return <ProviderDataUseLine dataUse={dataUse} testId="provider-training-data-use" />;
}
