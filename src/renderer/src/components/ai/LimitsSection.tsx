import { useEffect, useState } from "react";
import type { RegisteredDataFlow } from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { LocalOnlyRow } from "../providers/LocalOnlySetting";
import { SpendingCapRow } from "../SpendingCapSettings";
import { SettingsGroup, SettingsRow, SettingsSection } from "../settings/SettingsGroup";

/** How many services the User allowed something to go to, as Privacy lists them. */
const allowedServices = (flows: readonly RegisteredDataFlow[]): number =>
  new Set(
    flows.flatMap((flow) =>
      flow.services
        .filter((each) => each.consent === "accepted")
        .map((each) => each.flow.service.id),
    ),
  ).size;

/**
 * Settings › AI › Limits: Local mode and the monthly spending cap, and a link to what each
 * service may read, whose record stays in Privacy.
 */
export function LimitsSection() {
  const t = useT();
  const showPage = useAppStore((state) => state.showSettingsPage);
  const localOnly = useAppStore((state) => state.embedding?.localOnly);
  const [allowed, setAllowed] = useState<number | null>(null);
  useEffect(() => {
    const read = () =>
      core.listRegisteredDataFlows().then(
        (flows) => setAllowed(allowedServices(flows)),
        (failure: unknown) => console.error("Couldn't read what each service may read:", failure),
      );
    void read();
    return core.on("dataFlows.changed", (flows) => setAllowed(allowedServices(flows)));
  }, []);
  return (
    <SettingsSection title={t("ai.limits.title")} testId="ai-limits">
      <SettingsGroup>
        <LocalOnlyRow />
        <SpendingCapRow />
        <SettingsRow
          data-testid="ai-limits-privacy"
          label={t("ai.limits.read")}
          detail={
            allowed === null
              ? undefined
              : localOnly
                ? t("ai.limits.read.localMode")
                : allowed === 0
                  ? t("ai.limits.read.none")
                  : allowed === 1
                    ? t("ai.limits.read.one")
                    : t("ai.limits.read.other", { count: allowed })
          }
          control={
            <button
              type="button"
              data-testid="ai-limits-privacy-link"
              onClick={() => showPage("privacy")}
              className="text-[13px] leading-5 font-semibold text-accent underline-offset-2 hover:underline"
            >
              {t("ai.limits.read.review")}
            </button>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
