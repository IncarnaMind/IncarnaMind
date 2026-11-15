import { useState } from "react";
import type { CheckDecisionStatus } from "../../../../core/api";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { hostName } from "../providers/DecisionKeyForm";
import { SettingsRow, SettingsSwitch } from "../settings/SettingsGroup";
import { buttonStyle } from "../ui";

const TARGET = ["check-decision"] as const;

/**
 * Checking sentences (#3118): a switch for the one measured decision model that reads each
 * sentence of a check first. Its line says what goes to its host, before it is turned on:
 * turning it on there is the User allowing it. On by default, the line says which checks it
 * reads. Without the host's key, or in Local mode, a line says why it stays off. The tip names
 * the company whose model it is, where the host passes its requests on.
 */
export function CheckDecisionRow({
  id,
  status,
  onAddKey,
}: {
  id: string;
  status: CheckDecisionStatus;
  onAddKey(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const reportError = useAppStore((state) => state.reportError);
  // The switch moves at once; the core's next answer, a new `status`, replaces what was asked.
  const [asked, setAsked] = useState<{ on: boolean; of: CheckDecisionStatus } | null>(null);
  const { model, reads, blocked, maker } = status;
  const host = hostName({ name: status.hostName }, language);
  const on = !blocked && (asked?.of === status ? asked.on : reads !== null);
  const tip = t("ai.jobs.checks.tip", { model: model.name });
  const row = useSettingsTarget<HTMLDivElement>(TARGET, true, () =>
    queueMicrotask(() => document.getElementById(id)?.focus({ preventScroll: true })),
  );

  const turn = (next: boolean) => {
    setAsked({ on: next, of: status });
    const checkDecisionModel = next ? { host: model.host, modelId: model.modelId } : "off";
    core
      .updateSettings({ device: { checkDecisionModel } })
      .then((settings) => useAppStore.setState({ settings }))
      .catch((failure: unknown) => {
        setAsked(null);
        reportError(failure);
      });
  };

  return (
    <SettingsRow
      ref={row}
      data-testid="check-decision-settings"
      data-reads={reads ?? "off"}
      label={t("ai.jobs.checks")}
      htmlFor={id}
      tip={maker ? t("ai.jobs.checks.maker.tip", { tip, model: model.name, maker, host }) : tip}
      tipId={`${id}-tip`}
      detailId={`${id}-lines`}
      detail={
        <>
          <span className="block">{t("ai.jobs.checks.line", { model: model.name })}</span>
          {blocked === "local-mode" ? (
            <span data-testid="check-decision-blocked" className="block">
              {t("web.settings.localMode")}
            </span>
          ) : blocked === "no-key" ? (
            <span data-testid="check-decision-blocked" className="block">
              {t("ai.jobs.checks.noKey", { host })}
            </span>
          ) : (
            <span data-testid="check-decision-sends" className="block">
              {t(reads === "default" ? "ai.jobs.checks.sendsByDefault" : "ai.jobs.checks.sends", {
                host,
              })}
            </span>
          )}
        </>
      }
      control={
        <SettingsSwitch
          id={id}
          checked={on}
          disabled={blocked !== null}
          describedBy={`${id}-tip ${id}-lines`}
          onChange={turn}
          testId="check-decision-switch"
        />
      }
    >
      {blocked === "no-key" && (
        <button
          type="button"
          data-testid="check-decision-add-key"
          onClick={onAddKey}
          className={buttonStyle("secondary", "sm")}
        >
          {t("ai.jobs.checks.addKey")}
        </button>
      )}
    </SettingsRow>
  );
}
