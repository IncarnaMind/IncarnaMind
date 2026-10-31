import { useT } from "../i18n";
import { useAppStore } from "../store";
import { SwitchSetting } from "./SwitchSetting";

/**
 * Settings → General → Notifications: on until the User turns it off, the one
 * switch for a Task's system notifications ("needs you" and "finished"), which
 * the core sends only while the Task's Mind isn't on screen.
 */
export function TaskNotificationSettings() {
  const t = useT();
  const on = useAppStore((state) => state.settings?.user.taskNotifications);
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (on === undefined) return null;
  return (
    <SwitchSetting
      sectionTestId="task-notification-settings"
      heading={t("settings.notifications")}
      title={t("settings.taskNotifications")}
      tip={t("settings.taskNotifications.tip")}
      switchTestId="task-notification-switch"
      on={on}
      onChange={(next) => void updateSettings({ user: { taskNotifications: next } })}
    />
  );
}
