import { useT } from "../i18n";
import { useAppStore } from "../store";
import { MeetingOfferSettings } from "./MeetingOfferSettings";
import { SettingsGroup, SettingsSection, SettingsSwitchRow } from "./settings/SettingsGroup";

/**
 * Settings → General → Notifications: on until the User turns it off, the one
 * switch for a Task's system notifications ("needs you" and "finished"), which
 * the core sends only while the Task's Mind isn't on screen; then the offers to
 * take notes in meetings (#189).
 */
export function TaskNotificationSettings() {
  const t = useT();
  const on = useAppStore((state) => state.settings?.user.taskNotifications);
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (on === undefined) return null;
  return (
    <SettingsSection title={t("settings.notifications")} testId="task-notification-settings">
      <SettingsGroup>
        <SettingsSwitchRow
          label={t("settings.taskNotifications")}
          tip={t("settings.taskNotifications.tip")}
          checked={on}
          onChange={(next) => void updateSettings({ user: { taskNotifications: next } })}
          switchTestId="task-notification-switch"
        />
        <MeetingOfferSettings />
      </SettingsGroup>
    </SettingsSection>
  );
}
