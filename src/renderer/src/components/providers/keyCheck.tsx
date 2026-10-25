import { useState } from "react";
import { checkKey, type KeyCheck } from "../../../../core/providers/catalog/keyForms";
import { checkApiKey } from "../../../../shared/apiKey";
import { gap } from "../../../../shared/i18n/join";
import { useLanguage, useT } from "../../i18n";
import { ProblemLine } from "../ProblemLine";

const OK: KeyCheck = { ok: true };

/**
 * Whether a key may go to the service chosen. A key whose prefix names another service waits for
 * the User to agree; one that lacks the prefix its service's keys all have never goes.
 */
export function useKeyCheck(catalogId: string | null, apiKey: string) {
  const [agreed, setAgreed] = useState<string | null>(null);
  const { key: given, stray } = checkApiKey(apiKey);
  const found =
    catalogId !== null && given !== "" && stray === null ? checkKey(catalogId, given) : OK;
  const check =
    !found.ok && found.service !== null && agreed === `${catalogId}\n${given}` ? OK : found;
  return {
    check,
    blocked: !check.ok,
    agree: (forCatalogId: string | null = catalogId) => setAgreed(`${forCatalogId}\n${given}`),
  };
}

/**
 * Under a key field: whose key the prefix says it is, or that it isn't the chosen service's.
 * `pickAbove`: the service chips are above, for the one it belongs to. `from`: the form moved to
 * the service the key names, and the User can move it back.
 */
export function KeyCheckLine({
  check,
  provider,
  nameOf,
  pickAbove = false,
  from,
  onAnyway,
}: {
  check: KeyCheck;
  provider: string;
  nameOf(catalogId: string): string;
  pickAbove?: boolean;
  from?: { name: string; back(): void };
  onAnyway(): void;
}) {
  const t = useT();
  const language = useLanguage();
  if (check.ok && !from) return null;
  if (from) {
    return (
      <ProblemLine
        testId="provider-key-wrong"
        role="status"
        action={{
          label: t("providers.form.keyAnyway", { provider: from.name }),
          testId: "provider-key-anyway",
          onClick: from.back,
        }}
      >
        {t("providers.form.keyIs", { service: provider })}
      </ProblemLine>
    );
  }
  if (check.ok) return null;
  if (check.service !== null) {
    return (
      <ProblemLine
        testId="provider-key-wrong"
        role="status"
        action={{
          label: t("providers.form.keyAnyway", { provider }),
          testId: "provider-key-anyway",
          onClick: onAnyway,
        }}
      >
        {t("providers.form.keyIs", { service: nameOf(check.service) })}
      </ProblemLine>
    );
  }
  const prefixes = check.prefixes.join(language === "zh-CN" ? " 或 " : " or ");
  const lacks = t("providers.form.keyNot", { provider, prefixes });
  const pick = t("providers.form.keyNot.pick");
  return (
    <ProblemLine testId="provider-key-wrong" role="status">
      {pickAbove ? `${lacks}${gap(language, lacks, pick)}${pick}` : lacks}
    </ProblemLine>
  );
}
