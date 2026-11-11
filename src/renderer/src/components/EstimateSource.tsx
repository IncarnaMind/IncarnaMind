import { type ReactNode, useEffect } from "react";
import type { Language } from "../../../core/language";
import { pricesOfProvider } from "../../../core/providers/catalog/providers";
import { formatDate } from "../../../shared/dates";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import type { EstimateLine } from "../cost";
import { useLanguage, useT } from "../i18n";
import { loadSavedProviders, useSavedProviders } from "../savedProviders";
import { MetaLine } from "./MetaLine";
import { providerName } from "./providers/shared";

type Translate = (key: MessageKey, params?: MessageParams) => string;

export function estimateTip(
  t: Translate,
  language: Language,
  provider: string,
  checked: string,
): string {
  return t("models.provider.cost.tip", {
    provider,
    date: formatDate(checked, language, { timeZone: "UTC" }),
  });
}

export interface EstimateSource {
  url: string;
  tip: string;
}

/**
 * Where the estimate worked out from the saved provider `providerId`'s price comes from (#1257);
 * null until the saved providers are listed, which this asks for, and for a provider with no prices.
 */
export function useEstimateSource(providerId: string | undefined): EstimateSource | null {
  const t = useT();
  const language = useLanguage();
  const provider = useSavedProviders((state) =>
    providerId === undefined ? undefined : state.providers.find((each) => each.id === providerId),
  );
  useEffect(loadSavedProviders, []);
  const prices = provider && pricesOfProvider(provider);
  if (!provider || !prices) return null;
  return {
    url: prices.url,
    tip: estimateTip(t, language, providerName(provider, t, language), prices.checked),
  };
}

/**
 * An estimate that says where it comes from: the tip shows on hover, and the Tab key reaches it,
 * where a screen reader reads the tip as its description.
 */
export function EstimateTip({
  tip,
  testId,
  children,
}: {
  tip: string | undefined;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-testid={testId}
      title={tip}
      aria-description={tip}
      tabIndex={tip ? 0 : undefined}
      className="rounded-sm"
    >
      {children}
    </span>
  );
}

export function PricingLink({
  url,
  testId = "estimate-pricing",
}: {
  url: string;
  testId?: string;
}) {
  const t = useT();
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
      className="whitespace-nowrap underline underline-offset-2 hover:text-ink"
    >
      {t("models.provider.pricing")} ↗
    </a>
  );
}

/**
 * An estimate's line (`estimateLine`) with its source: its price takes the tip and "Pricing ↗"
 * ends the line. A line with no price, or whose provider is not known yet, is as it was.
 */
export function EstimateMeta({ line, testId }: { line: EstimateLine; testId?: string }) {
  const source = useEstimateSource(line.providerId);
  if (!source) return <MetaLine data-testid={testId} parts={line.parts} title={line.title} />;
  const [price, ...rest] = line.parts;
  return (
    <MetaLine
      data-testid={testId}
      parts={[
        <EstimateTip key="price" tip={source.tip} testId="estimate-price">
          {price}
        </EstimateTip>,
        ...rest,
        <PricingLink key="pricing" url={source.url} />,
      ]}
    />
  );
}
