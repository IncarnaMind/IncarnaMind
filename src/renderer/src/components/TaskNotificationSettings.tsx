import { useId } from "react";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { InfoTip } from "./InfoTip";
import { rowTitleClass, ruledListClass, ruledRowClass, sectionTitleClass } from "./ui";

/**
 * Settings → General → Notifications: on until the User turns it off, the one
 * switch for a Task's system notifications ("needs you" and "finished"), which
 * the core sends only while the Task's Mind isn't on screen.
 */
export function TaskNotificationSettings() {
  const t = useT();
  const on = useAppStore((state) => state.settings?.user.taskNotifications);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const id = useId();
  if (on === undefined) return null;
  return (
    <section data-testid="task-notification-settings">
      <h4 className={`mb-2 ${sectionTitleClass}`}>{t("settings.notifications")}</h4>
      <div className={ruledListClass}>
        <div className={ruledRowClass}>
          <div className="flex items-center">
            <label htmlFor={id} className={rowTitleClass}>
              {t("settings.taskNotifications")}
            </label>
            <InfoTip id={`${id}-description`} text={t("settings.taskNotifications.tip")} />
          </div>
          <input
            id={id}
            type="checkbox"
            role="switch"
            aria-checked={on}
            aria-describedby={`${id}-description`}
            data-testid="task-notification-switch"
            checked={on}
            onChange={(event) =>
              void updateSettings({ user: { taskNotifications: event.target.checked } })
            }
            className="switch"
          />
        </div>
      </div>
    </section>
  );
}
