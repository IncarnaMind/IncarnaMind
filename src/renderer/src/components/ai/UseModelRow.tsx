import { useT } from "../../i18n";
import type { SettingsTarget } from "../../settingsPages";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { useSpendingCapShown } from "../SpendingCapSettings";
import { SettingsGroup, SettingsRowAction, SettingsSection } from "../settings/SettingsGroup";

/** The rows a link may ask for that only show once a model is set up: with none, it lands here. */
const WITH_A_MODEL: readonly SettingsTarget[] = [
  "model",
  "chat-model",
  "web-search",
  "check-decision",
];
const WITH_THE_CAP: readonly SettingsTarget[] = [...WITH_A_MODEL, "spending-cap"];

/**
 * Settings › AI with no model set up in IncarnaMind: a model here is optional, so it is one quiet
 * row under Your AI. It opens the setup's model step, the form first run sets one up with.
 */
export function UseModelRow() {
  const t = useT();
  const openSetup = useAppStore((state) => state.openSetup);
  const capShown = useSpendingCapShown();
  // Showing the dialog moves the focus after the target is reached, as for Local mode's switch.
  const reached = useSettingsTarget<HTMLElement>(capShown ? WITH_A_MODEL : WITH_THE_CAP, true, () =>
    queueMicrotask(() =>
      document.querySelector<HTMLElement>('[data-testid="ai-use-model-open"]')?.focus(),
    ),
  );
  return (
    <SettingsSection ref={reached} testId="ai-use-model">
      <SettingsGroup>
        <SettingsRowAction
          testId="ai-use-model-open"
          label={t("agents.ask.useModel")}
          detail={t("ai.useModel.line")}
          onClick={openSetup}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
