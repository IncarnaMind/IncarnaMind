import { useId } from "react";
import { useAgentPairings } from "../../agentNote";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { PopUpSelect } from "../settings/PopUpButton";
import { SettingsRow } from "../settings/SettingsGroup";

export function MeetingNotesAgentSetting() {
  const id = useId();
  const t = useT();
  const pairings = useAgentPairings();
  const selected = useAppStore((state) => state.settings?.device.meetingNotesAgentId);
  const update = useAppStore((state) => state.updateSettings);
  if (!selected && !pairings?.length) return null;
  return (
    <SettingsRow
      label={t("meetings.notesAgent.setting")}
      detail={t("meetings.notesAgent.detail")}
      htmlFor={id}
      control={
        <PopUpSelect
          id={id}
          value={selected ?? ""}
          onChange={(event) =>
            void update({ device: { meetingNotesAgentId: event.target.value || null } })
          }
        >
          <option value="">{t("meetings.notesAgent.default")}</option>
          {selected && !pairings?.some((agent) => agent.id === selected) && (
            <option value={selected}>{t("meetings.notesAgent.disconnected")}</option>
          )}
          {pairings?.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </PopUpSelect>
      }
    />
  );
}
