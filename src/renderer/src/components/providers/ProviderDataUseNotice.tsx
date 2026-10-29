import type { ExternalService } from "../../../../core/api";
import type { DataUse } from "../../../../core/providers/catalog";
import { dataUseForService } from "../../../../core/providers/serviceDataUse";
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
          <a href={href} target="_blank" rel="noreferrer" className="underline whitespace-nowrap">
            {link}
          </a>
        </>
      )}
    </p>
  );
}

export function ProviderDataUseNotice({ service }: { service: ExternalService }) {
  const dataUse = dataUseForService(service.id);
  if (!dataUse || dataUse.training === "no") return null;
  return <ProviderDataUseLine dataUse={dataUse} testId="provider-training-data-use" />;
}
