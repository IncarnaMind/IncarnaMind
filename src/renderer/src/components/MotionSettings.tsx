import { useSyncExternalStore } from "react";
import type { MessageKey } from "../../../shared/i18n";
import { useT } from "../i18n";
import { type MotionMode, motionMode, setMotionPreference, subscribeMotion } from "../motion";
import { useAppStore } from "../store";
import { SettingsPopUpRow } from "./settings/PopUpButton";

const motionOptions: readonly { value: MotionMode; label: MessageKey }[] = [
  { value: "on", label: "settings.motion.on" },
  { value: "reduced", label: "settings.motion.reduced" },
  { value: "off", label: "settings.motion.off" },
];

/**
 * Settings → General → Interface → Motion: On, Reduced or Off (DESIGN.md, Motion). Until the User
 * chooses, the system's Reduce motion picks between On and Reduced, and the choice it made shows.
 */
export function MotionRow() {
  const t = useT();
  const preference = useAppStore((state) => state.settings?.device.motion ?? "system");
  const updateSettings = useAppStore((state) => state.updateSettings);
  const mode = useSyncExternalStore(subscribeMotion, motionMode);

  const choose = (value: MotionMode) => {
    // The one the system picked, chosen as it is, is kept: it no longer follows the system.
    if (value === mode && preference === value) return;
    // At once, before the core confirms; then as kept, which is the old choice if it refused.
    setMotionPreference(value);
    void updateSettings({ device: { motion: value } }).then(() =>
      setMotionPreference(useAppStore.getState().settings?.device.motion ?? "system"),
    );
  };

  return (
    <SettingsPopUpRow
      testId="motion-settings"
      buttonTestId="motion-choice"
      label={t("settings.motion")}
      tip={t("settings.motion.tip")}
      detail={preference === "system" ? t("settings.motion.system") : undefined}
      value={mode}
      options={motionOptions.map((option) => ({ value: option.value, label: t(option.label) }))}
      onChange={choose}
    />
  );
}
