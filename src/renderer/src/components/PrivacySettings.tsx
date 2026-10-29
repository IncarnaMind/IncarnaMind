import { useCallback, useEffect, useId, useState } from "react";
import type {
  NetworkTraffic,
  PrivacySettings as PrivacyChoices,
  PrivacySettingsPatch,
  RegisteredDataFlow,
} from "../../../core/api";
import { core } from "../core";
import { useT } from "../i18n";
import { openSandboxHelp, useRunsWithoutSandbox } from "../sandbox";
import { useAppStore } from "../store";
import { AiUseSettings } from "./AiUseSettings";
import { ApprovalsSettings } from "./ApprovalsSettings";
import { DetailsLine } from "./DetailsLine";
import { InfoTip } from "./InfoTip";
import { ModelRuntimeFolderLine } from "./ModelRuntimeFolderLine";
import { PrivacyServices, SERVICES_UNDO_PLACE } from "./PrivacyServices";
import { ProblemLine } from "./ProblemLine";
import { LocalOnlySetting } from "./providers/LocalOnlySetting";
import { UndoLineAt } from "./UndoLine";
import { USAGE_DATA_DETAILS_URL } from "./UsageDataCard";
import {
  buttonStyle,
  rowStatusClass,
  rowTextClass,
  rowTitleClass,
  ruledListClass,
  ruledRowClass,
  sectionNoteClass,
  sectionTitleClass,
} from "./ui";

const reportError = (failure: unknown) => useAppStore.getState().reportError(failure);

export function PrivacySettings() {
  const t = useT();
  const sandboxOff = useRunsWithoutSandbox();
  const [flows, setFlows] = useState<RegisteredDataFlow[] | null>(null);
  const [traffic, setTraffic] = useState<NetworkTraffic[] | null>(null);
  // As loaded with the app, until the core's answer below.
  const [choices, setChoices] = useState<PrivacyChoices | null>(
    () => useAppStore.getState().privacy,
  );

  const refreshFlows = useCallback(() => {
    core.listRegisteredDataFlows().then(setFlows, reportError);
  }, []);
  const refreshTraffic = useCallback(() => {
    core.listNetworkTraffic().then(setTraffic, reportError);
  }, []);

  useEffect(() => {
    refreshFlows();
    refreshTraffic();
    core.getPrivacySettings().then(setChoices, reportError);
    /** Rerank's kind, last seen: its download's progress changes neither flows nor traffic. */
    let rerankKind: string | null | undefined;
    const stops = [
      core.on("dataFlows.changed", setFlows),
      core.on("consent.resolved", refreshFlows),
      // A new provider or tagger moves a flow to another service.
      core.on("chatReadiness.changed", refreshFlows),
      core.on("jev.changed", refreshFlows),
      // So does switching the embedding model, or setting rerank up.
      core.on("embedding.changed", refreshFlows),
      // The built-in reranking model also downloads its files.
      core.on("rerank.changed", (rerank) => {
        if (rerank.kind === rerankKind) return;
        rerankKind = rerank.kind;
        refreshFlows();
        refreshTraffic();
      }),
      // Each Connector that is on is a service of the "connectors" flow.
      core.on("connectors.changed", refreshFlows),
      core.on("privacy.changed", (changed) => {
        setChoices(changed);
        refreshTraffic();
      }),
      core.on("chatGptPlan.changed", refreshTraffic),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [refreshFlows, refreshTraffic]);

  const update = async (patch: PrivacySettingsPatch) => {
    // The switch moves at once; the core's answer then confirms it, or puts it back.
    setChoices(
      (current) =>
        current && {
          crashReports: {
            ...current.crashReports,
            enabled: patch.crashReports ?? current.crashReports.enabled,
          },
          automaticUpdateChecks: patch.automaticUpdateChecks ?? current.automaticUpdateChecks,
          usageData: {
            ...current.usageData,
            enabled: patch.usageData ?? current.usageData.enabled,
          },
        },
    );
    try {
      setChoices(await core.updatePrivacySettings(patch));
    } catch (failure) {
      reportError(failure);
      core.getPrivacySettings().then(setChoices, () => undefined);
    }
    refreshTraffic();
  };

  const inUse = flows?.filter((flow) => flow.services.length > 0) ?? [];

  return (
    <div data-testid="privacy-settings" className="flex flex-col gap-7">
      <section data-testid="consent-settings" className="flex flex-col">
        <h4 className={sectionTitleClass}>{t("consent.settings.title")}</h4>
        <DetailsLine
          testId="privacy-flows-intro"
          className={sectionNoteClass}
          details={t("privacy.flows.intro.details")}
        >
          {t("privacy.flows.intro")}
        </DetailsLine>
        {inUse.length > 0 ? (
          <PrivacyServices flows={inUse} />
        ) : (
          flows && (
            <p
              data-testid="data-flows-none"
              className={`${rowStatusClass} border-y border-rule py-3.5`}
            >
              {t("privacy.flows.none")}
            </p>
          )
        )}
        {/* Here, not in the list: stopping the last service empties the list, and its Undo stays. */}
        <UndoLineAt place={SERVICES_UNDO_PLACE} />
      </section>

      <LocalOnlySetting />

      <section data-testid="network-traffic" className="flex flex-col">
        <h4 className={sectionTitleClass}>{t("privacy.traffic.title")}</h4>
        <p className={sectionNoteClass}>{t("privacy.traffic.intro")}</p>
        <ul className={ruledListClass}>
          {traffic?.map((item) =>
            item.id === "usage-data" && choices ? (
              <UsageDataItem
                key={`${item.id} ${item.service.id}`}
                traffic={item}
                usageData={choices.usageData}
                onChange={(enabled) => void update({ usageData: enabled })}
              />
            ) : (
              <TrafficItem
                key={`${item.id} ${item.service.id}`}
                traffic={item}
                choices={choices}
                onChange={(patch) => void update(patch)}
              />
            ),
          )}
        </ul>
        <p className={`mt-2 ${rowStatusClass}`}>
          {t(choices?.usageData.available ? "privacy.intro.usageData" : "privacy.intro")}
        </p>
        <ModelRuntimeFolderLine />
      </section>

      <section data-testid="approvals" className="flex flex-col">
        <h4 className={`mb-2 ${sectionTitleClass}`}>{t("approvals.settings.title")}</h4>
        <ApprovalsSettings />
      </section>

      {sandboxOff && (
        <ProblemLine
          testId="privacy-no-sandbox"
          role="status"
          action={{
            label: t("sandbox.off.fix"),
            testId: "privacy-no-sandbox-fix",
            onClick: openSandboxHelp,
          }}
        >
          {t("sandbox.off")}
        </ProblemLine>
      )}

      <section data-testid="skill-scripts-note" role="note" className="flex flex-col">
        <h4 className={sectionTitleClass}>{t("privacy.skills.title")}</h4>
        <p className={`mt-0.5 ${rowTextClass}`}>{t("privacy.skills.body")}</p>
      </section>

      <AiUseSettings />

      {/* Only a copy built with a crash-report address can send reports, so only it offers them. */}
      {choices?.crashReports.available && (
        <CrashReports
          enabled={choices.crashReports.enabled}
          onChange={(enabled) => void update({ crashReports: enabled })}
        />
      )}
    </div>
  );
}

/**
 * Usage data, listed with the other traffic: where it goes, what it is, and
 * its switch, which local mode keeps off; the install ID's reset; and a link
 * to every event and field.
 */
function UsageDataItem({
  traffic,
  usageData,
  onChange,
}: {
  traffic: NetworkTraffic;
  usageData: PrivacyChoices["usageData"];
  onChange(enabled: boolean): void;
}) {
  const t = useT();
  const id = useId();
  const [reset, setReset] = useState(false);
  const resetId = async () => {
    try {
      await core.resetUsageInstallId();
      setReset(true);
    } catch (failure) {
      reportError(failure);
    }
  };
  return (
    <li
      data-testid="network-traffic-item"
      data-traffic-id={traffic.id}
      data-enabled={usageData.enabled}
      className={ruledRowClass}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-ui break-words text-ink">
          <label htmlFor={`${id}-switch`} className="font-semibold">
            {t("privacy.traffic.usage-data")}
          </label>
          <span className="text-ink-meta"> · {traffic.service.name}</span>
          <InfoTip text={t("privacy.traffic.usage-data.tip")} />
        </p>
        {usageData.testerBuild && <p className={rowTextClass}>{t("privacy.usageData.tester")}</p>}
        {usageData.localMode && (
          <p data-testid="usage-data-local-mode" className={rowTextClass}>
            {t("privacy.usageData.localMode")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <a
            href={USAGE_DATA_DETAILS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] leading-5 text-accent underline-offset-2 hover:text-accent-strong hover:underline"
          >
            {t("privacy.usageData.details")}
          </a>
          <button
            type="button"
            data-testid="usage-data-reset-id"
            onClick={() => void resetId()}
            className={buttonStyle("secondary", "sm")}
          >
            {t("privacy.usageData.resetId")}
          </button>
          {reset && (
            <span role="status" className={rowStatusClass}>
              {t("privacy.usageData.resetDone")}
            </span>
          )}
        </div>
      </div>
      <input
        id={`${id}-switch`}
        type="checkbox"
        role="switch"
        data-testid="usage-data-switch"
        disabled={usageData.localMode}
        checked={usageData.enabled}
        aria-checked={usageData.enabled}
        onChange={(event) => onChange(event.target.checked)}
        className="switch"
      />
    </li>
  );
}

/** Traffic without the User's content: where it goes, and the switch for update checks. */
function TrafficItem({
  traffic,
  choices,
  onChange,
}: {
  traffic: NetworkTraffic;
  choices: PrivacyChoices | null;
  onChange(patch: PrivacySettingsPatch): void;
}) {
  const t = useT();
  const id = useId();
  const switchable = traffic.id === "update-check" && choices !== null;
  return (
    <li
      data-testid="network-traffic-item"
      data-traffic-id={traffic.id}
      data-enabled={traffic.enabled}
      className={ruledRowClass}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-ui break-words text-ink">
          <span id={`${id}-title`} className="font-semibold">
            {t(`privacy.traffic.${traffic.id}`)}
          </span>
          <span className="text-ink-meta"> · {traffic.service.name}</span>
          <InfoTip text={t(`privacy.traffic.${traffic.id}.tip`)} />
        </p>
      </div>
      {switchable ? (
        <input
          type="checkbox"
          role="switch"
          data-testid="automatic-update-checks"
          aria-label={t("privacy.traffic.update-check.toggle")}
          checked={choices.automaticUpdateChecks}
          aria-checked={choices.automaticUpdateChecks}
          onChange={(event) => onChange({ automaticUpdateChecks: event.target.checked })}
          className="switch"
        />
      ) : (
        <span className={rowStatusClass}>
          {traffic.enabled ? t("privacy.traffic.on") : t("privacy.traffic.off")}
        </span>
      )}
    </li>
  );
}

function CrashReports({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange(enabled: boolean): void;
}) {
  const t = useT();
  const id = useId();
  return (
    <section data-testid="crash-reports" className="flex flex-col">
      <h4 className={`mb-2 ${sectionTitleClass}`}>{t("privacy.crashReports.title")}</h4>
      <div className={ruledListClass}>
        <div className={ruledRowClass}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={id} className={rowTitleClass}>
              {t("privacy.crashReports.toggle")}
            </label>
            <DetailsLine
              id={`${id}-description`}
              testId="crash-reports-description"
              className={rowTextClass}
              details={t("privacy.crashReports.body.details")}
            >
              {t("privacy.crashReports.body")}
            </DetailsLine>
          </div>
          <input
            id={id}
            type="checkbox"
            role="switch"
            data-testid="crash-reports-switch"
            className="switch"
            checked={enabled}
            aria-checked={enabled}
            aria-describedby={`${id}-description`}
            onChange={(event) => onChange(event.target.checked)}
          />
        </div>
      </div>
    </section>
  );
}
