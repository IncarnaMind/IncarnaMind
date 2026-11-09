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
import { ModelRuntimeFolderLine } from "./ModelRuntimeFolderLine";
import { PrivacyServices, SERVICES_UNDO_PLACE } from "./PrivacyServices";
import { ProblemLine } from "./ProblemLine";
import { MovedToAi } from "./settings/MovedToAi";
import {
  SettingsGroup,
  SettingsHelp,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  SettingsSwitchRow,
} from "./settings/SettingsGroup";
import { UndoLineAt } from "./UndoLine";
import { USAGE_DATA_DETAILS_URL } from "./UsageDataCard";
import { buttonStyle } from "./ui";

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
    <div data-testid="privacy-settings" className="flex flex-col gap-6">
      <SettingsSection title={t("consent.settings.title")} testId="consent-settings">
        {inUse.length > 0 ? (
          <PrivacyServices flows={inUse} />
        ) : (
          flows && (
            <SettingsGroup>
              <SettingsRow data-testid="data-flows-none" label={t("privacy.flows.none")} />
            </SettingsGroup>
          )
        )}
        <SettingsHelp>
          <DetailsLine testId="privacy-flows-intro" details={t("privacy.flows.intro.details")}>
            {t("privacy.flows.intro")}
          </DetailsLine>
        </SettingsHelp>
        {/* Here, not in the list: stopping the last service empties the list, and its Undo stays. */}
        <UndoLineAt place={SERVICES_UNDO_PLACE} />
      </SettingsSection>

      <MovedToAi
        testId="local-mode-moved"
        title="embeddingProviders.localOnly.label"
        at="local-mode"
      />

      <SettingsSection title={t("privacy.traffic.title")} testId="network-traffic">
        {traffic && traffic.length > 0 && (
          <SettingsGroup role="list">
            {traffic.map((item) =>
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
          </SettingsGroup>
        )}
        <SettingsHelp className="flex flex-col gap-1">
          <p>{t("privacy.traffic.intro")}</p>
          <p>{t(choices?.usageData.available ? "privacy.intro.usageData" : "privacy.intro")}</p>
        </SettingsHelp>
        <div className="px-4">
          <ModelRuntimeFolderLine />
        </div>
      </SettingsSection>

      <SettingsSection title={t("approvals.settings.title")} testId="approvals">
        <ApprovalsSettings />
      </SettingsSection>

      {sandboxOff && (
        <div className="px-4">
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
        </div>
      )}

      <div data-testid="skill-scripts-note" role="note">
        <SettingsSection title={t("privacy.skills.title")}>
          <SettingsHelp>{t("privacy.skills.body")}</SettingsHelp>
        </SettingsSection>
      </div>

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
    <SettingsRow
      role="listitem"
      data-testid="network-traffic-item"
      data-traffic-id={traffic.id}
      data-enabled={usageData.enabled}
      label={
        <>
          {t("privacy.traffic.usage-data")}
          <span className="text-ink-meta"> · {traffic.service.name}</span>
        </>
      }
      htmlFor={`${id}-switch`}
      tip={t("privacy.traffic.usage-data.tip")}
      detail={
        (usageData.testerBuild || usageData.localMode) && (
          <>
            {usageData.testerBuild && <p>{t("privacy.usageData.tester")}</p>}
            {usageData.localMode && (
              <p data-testid="usage-data-local-mode">{t("privacy.usageData.localMode")}</p>
            )}
          </>
        )
      }
      control={
        <SettingsSwitch
          id={`${id}-switch`}
          testId="usage-data-switch"
          disabled={usageData.localMode}
          checked={usageData.enabled}
          onChange={onChange}
        />
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
          <span role="status" className="text-[12px] leading-[18px] text-ink-meta">
            {t("privacy.usageData.resetDone")}
          </span>
        )}
      </div>
    </SettingsRow>
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
  const switchable = traffic.id === "update-check" && choices !== null;
  return (
    <SettingsRow
      role="listitem"
      data-testid="network-traffic-item"
      data-traffic-id={traffic.id}
      data-enabled={traffic.enabled}
      label={
        <>
          {t(`privacy.traffic.${traffic.id}`)}
          <span className="text-ink-meta"> · {traffic.service.name}</span>
        </>
      }
      tip={t(`privacy.traffic.${traffic.id}.tip`)}
      control={
        switchable ? (
          <SettingsSwitch
            ariaLabel={t("privacy.traffic.update-check.toggle")}
            testId="automatic-update-checks"
            checked={choices.automaticUpdateChecks}
            onChange={(enabled) => onChange({ automaticUpdateChecks: enabled })}
          />
        ) : (
          <span className="text-ui text-ink-meta">
            {traffic.enabled ? t("privacy.traffic.on") : t("privacy.traffic.off")}
          </span>
        )
      }
    />
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
  return (
    <SettingsSection title={t("privacy.crashReports.title")} testId="crash-reports">
      <SettingsGroup>
        <SettingsSwitchRow
          label={t("privacy.crashReports.toggle")}
          detail={
            <DetailsLine
              testId="crash-reports-description"
              details={t("privacy.crashReports.body.details")}
            >
              {t("privacy.crashReports.body")}
            </DetailsLine>
          }
          checked={enabled}
          onChange={onChange}
          switchTestId="crash-reports-switch"
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
