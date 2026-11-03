import { useT } from "../i18n";
import { useAppStore } from "../store";
import { DetailsLine } from "./DetailsLine";
import { SwitchSetting } from "./SwitchSetting";
import { rowTextClass } from "./ui";

/**
 * Settings → Search → Checks: the switch that leaves the files IncarnaMind
 * wrote out of checks' evidence (#80), on by default. A Folder can count
 * them while it stays on (the Library's folder form).
 */
export function EvidenceSettings() {
  const t = useT();
  const on = useAppStore((state) => state.settings?.user.leaveOutOwnFiles);
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (on === undefined) return null;
  return (
    <SwitchSetting
      sectionTestId="evidence-settings"
      heading={t("evidence.settings.title")}
      title={t("evidence.settings.switch")}
      description={
        <DetailsLine
          testId="evidence-description"
          className={rowTextClass}
          details={t("evidence.settings.body.details")}
        >
          {t("evidence.settings.body")}
        </DetailsLine>
      }
      switchTestId="evidence-switch"
      on={on}
      onChange={(next) => void updateSettings({ user: { leaveOutOwnFiles: next } })}
    />
  );
}
