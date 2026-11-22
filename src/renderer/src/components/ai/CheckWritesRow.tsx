import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { SettingsSwitchRow } from "../settings/SettingsGroup";

/**
 * Settings › AI › Check what the assistant and your own AI write (#3154, #3576): a switch, off by
 * default. Off, what the assistant writes into a Note, and what an outside agent writes or hands
 * over, waits for the User's Check, as any sentence does. With no model set up there is no
 * assistant to name (`assistant` false).
 */
export function CheckWritesRow({ assistant }: { assistant: boolean }) {
  const t = useT();
  const on = useAppStore((state) => state.settings?.user.checkAssistantWrites);
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (on === undefined) return null;
  return (
    <SettingsSwitchRow
      testId="check-writes-settings"
      label={t(assistant ? "ai.jobs.checkWrites" : "ai.jobs.checkWrites.ownAi")}
      detail={t("ai.jobs.checkWrites.line")}
      checked={on}
      onChange={(next) => void updateSettings({ user: { checkAssistantWrites: next } })}
      switchTestId="check-writes-switch"
    />
  );
}
