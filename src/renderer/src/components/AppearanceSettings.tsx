import type { Appearance } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { chooseAppearance } from "../appearance";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { SettingsPopUpRow } from "./settings/PopUpButton";

const appearanceOptions: readonly { value: Appearance; label: MessageKey }[] = [
  { value: "light", label: "settings.appearance.light" },
  { value: "dark", label: "settings.appearance.dark" },
  { value: "system", label: "settings.appearance.system" },
];

/** Settings → General → Interface → Appearance: Light, Dark, or Same as system, the default (#1262). */
export function AppearanceRow() {
  const t = useT();
  const appearance = useAppStore((state) => state.settings?.device.appearance ?? "system");
  return (
    <SettingsPopUpRow
      testId="appearance-settings"
      buttonTestId="appearance-choice"
      label={t("settings.appearance")}
      value={appearance}
      options={appearanceOptions.map((option) => ({
        value: option.value,
        label: t(option.label),
      }))}
      onChange={(value) => {
        if (value !== appearance) void chooseAppearance(value);
      }}
    />
  );
}
