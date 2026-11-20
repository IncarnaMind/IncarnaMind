import { useId } from "react";
import { meetingSummaryModelRoute } from "../../../../shared/meetingSummary";
import { useAgentsToAskRead, useReadAgentsToAsk } from "../../askYourAi";
import { useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { PopUpSelect } from "../settings/PopUpButton";
import { SettingsRow } from "../settings/SettingsGroup";

export function MeetingSummarySetting() {
  const id = useId();
  const detailId = useId();
  const t = useT();
  const selected = useAppStore((state) => state.settings?.device.meetingSummaryRoute) ?? "";
  const notesAgentId = useAppStore((state) => state.settings?.device.meetingNotesAgentId);
  const update = useAppStore((state) => state.updateSettings);
  const readiness = useAppStore((state) => state.chatReadiness);
  const nameOf = useModelNames();
  const builtIn =
    !notesAgentId && readiness?.ready && readiness.consent !== "needed"
      ? {
          route: meetingSummaryModelRoute(
            {
              modelId: readiness.modelId,
              providerId: readiness.provider.id,
            },
            readiness.provider.service?.id ?? null,
          ),
          model: nameOf(readiness.modelId, readiness.provider.id).name,
          provider:
            readiness.provider.service?.name ?? t(`providers.kind.${readiness.provider.kind}`),
        }
      : null;
  useReadAgentsToAsk(null);
  const agent = useAgentsToAskRead(null)?.find(
    (agent) =>
      agent.id === notesAgentId && (agent.client === "codex" || agent.client === "claude-code"),
  );
  const option = builtIn
    ? { route: builtIn.route, label: t("meetings.summary.builtin", builtIn) }
    : agent && { route: agent.id, label: agent.name };
  const unavailable = selected && option?.route !== selected;

  return (
    <SettingsRow
      label={t("meetings.summary.setting")}
      detail={
        <>
          {t("meetings.summary.disclosure")}
          {!option && <p>{t("meetings.summary.setup")}</p>}
        </>
      }
      detailId={detailId}
      htmlFor={id}
      control={
        <PopUpSelect
          id={id}
          aria-describedby={detailId}
          data-testid="meeting-summary-route"
          value={selected}
          disabled={!selected && !option}
          onChange={(event) =>
            void update({ device: { meetingSummaryRoute: event.target.value || null } })
          }
        >
          <option value="">{t("meetings.summary.off")}</option>
          {unavailable && (
            <option value={selected} disabled>
              {t("meetings.summary.agentUnavailable")}
            </option>
          )}
          {option && <option value={option.route}>{option.label}</option>}
        </PopUpSelect>
      }
    />
  );
}
