import { useSyncExternalStore } from "react";
import type { MessageKey } from "../../../shared/i18n";
import { useT } from "../i18n";
import { type MotionMode, motionMode, setMotionPreference, subscribeMotion } from "../motion";
import { useAppStore } from "../store";
import { InfoTip } from "./InfoTip";
import { hintClass, ruledListClass, sectionTitleClass } from "./ui";

const motionOptions: readonly { value: MotionMode; label: MessageKey }[] = [
  { value: "on", label: "settings.motion.on" },
  { value: "reduced", label: "settings.motion.reduced" },
  { value: "off", label: "settings.motion.off" },
];

/**
 * Settings → General → Motion: On, Reduced or Off (DESIGN.md, Motion). Until
 * the User chooses, the system's Reduce motion picks between On and Reduced,
 * and the choice it made shows checked.
 */
export function MotionSettings() {
  const t = useT();
  const preference = useAppStore((state) => state.settings?.device.motion ?? "system");
  const updateSettings = useAppStore((state) => state.updateSettings);
  const mode = useSyncExternalStore(subscribeMotion, motionMode);

  const choose = (value: MotionMode) => {
    // At once, before the core confirms; then as kept, which is the old choice if it refused.
    setMotionPreference(value);
    void updateSettings({ device: { motion: value } }).then(() =>
      setMotionPreference(useAppStore.getState().settings?.device.motion ?? "system"),
    );
  };

  return (
    <section data-testid="motion-settings">
      <div className="mb-2 flex items-center">
        <h4 id="motion-title" className={sectionTitleClass}>
          {t("settings.motion")}
        </h4>
        <InfoTip text={t("settings.motion.tip")} />
      </div>
      <div role="radiogroup" aria-labelledby="motion-title" className={ruledListClass}>
        {motionOptions.map((option) => (
          <label
            key={option.value}
            className="flex h-10 cursor-pointer items-center gap-3 text-ui text-ink"
          >
            <input
              type="radio"
              name="motion"
              value={option.value}
              checked={mode === option.value}
              onChange={() => choose(option.value)}
              // The one the system picked, chosen as it is: kept, so it no longer follows the system.
              onClick={() => {
                if (mode === option.value && preference !== option.value) choose(option.value);
              }}
              className="size-4 shrink-0 accent-ink"
            />
            {t(option.label)}
          </label>
        ))}
      </div>
      {preference === "system" && <p className={hintClass}>{t("settings.motion.system")}</p>}
    </section>
  );
}
