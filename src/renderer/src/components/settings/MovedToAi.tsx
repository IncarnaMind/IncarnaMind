import type { MessageKey } from "../../../../shared/i18n";
import { useT } from "../../i18n";
import { type SettingsTarget, settingsPageLabels } from "../../settingsPages";
import { useAppStore } from "../../store";
import { SettingsGroup, SettingsRowAction, SettingsSection } from "./SettingsGroup";

/** Where a setting that moved to Settings › AI used to be: its name, and a link to it there. */
export function MovedToAi({
  testId,
  title,
  at,
}: {
  testId: string;
  title: MessageKey;
  at: SettingsTarget;
}) {
  const t = useT();
  const open = useAppStore((state) => state.openSettings);
  return (
    <SettingsSection testId={testId}>
      <SettingsGroup>
        <SettingsRowAction
          testId={`${testId}-link`}
          label={t(title)}
          detail={t("ai.moved", { page: t(settingsPageLabels.ai) })}
          onClick={() => open("ai", at)}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
