import type { Appearance } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { chooseAppearance } from "../appearance";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { ruledListClass, sectionTitleClass } from "./ui";

const appearanceOptions: readonly { value: Appearance; label: MessageKey }[] = [
  { value: "light", label: "settings.appearance.light" },
  { value: "dark", label: "settings.appearance.dark" },
  { value: "system", label: "settings.appearance.system" },
];

/** Settings → General → Appearance: Light, Dark, or Same as system, the default (#1262). */
export function AppearanceSettings() {
  const t = useT();
  const appearance = useAppStore((state) => state.settings?.device.appearance ?? "system");

  return (
    <section data-testid="appearance-settings">
      <h4 id="appearance-title" className={`mb-2 ${sectionTitleClass}`}>
        {t("settings.appearance")}
      </h4>
      <div role="radiogroup" aria-labelledby="appearance-title" className={ruledListClass}>
        {appearanceOptions.map((option) => (
          <label
            key={option.value}
            className="flex h-10 cursor-pointer items-center gap-3 text-ui text-ink"
          >
            <input
              type="radio"
              name="appearance"
              value={option.value}
              checked={appearance === option.value}
              onChange={() => void chooseAppearance(option.value)}
              className="size-4 shrink-0 accent-ink"
            />
            {t(option.label)}
          </label>
        ))}
      </div>
    </section>
  );
}
