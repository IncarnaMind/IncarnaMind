import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { SwitchSetting } from "../SwitchSetting";
import { rowTextClass } from "../ui";

/** Settings › Meetings › Notes after the call: whether the sections the User's notes don't cover follow them. */
export function FillSettings() {
  const t = useT();
  const on = useAppStore((state) => state.settings?.user.meetingFillUncovered);
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (on === undefined) return null;
  return (
    <SwitchSetting
      sectionTestId="meeting-fill-settings"
      heading={t("meetings.settings.notes")}
      title={t("meetings.settings.fillUncovered")}
      description={<p className={rowTextClass}>{t("meetings.settings.fillUncoveredBody")}</p>}
      switchTestId="meeting-fill-uncovered"
      on={on}
      onChange={(next) => void updateSettings({ user: { meetingFillUncovered: next } })}
    />
  );
}
