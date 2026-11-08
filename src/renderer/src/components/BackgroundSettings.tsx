import { useEffect, useState } from "react";
import type { OpenAtLogin } from "../../../core/api";
import { core } from "../core";
import { useT } from "../i18n";
import { onMac } from "../platformOffers";
import { useSettingsTarget } from "../settingsTarget";
import { useAppStore } from "../store";
import { ProblemLine } from "./ProblemLine";
import { SettingsGroup, SettingsSection, SettingsSwitchRow } from "./settings/SettingsGroup";

const TARGET = ["background"] as const;

/**
 * Settings → General → Running in the background (#189): opening at login, through the system,
 * and keeping IncarnaMind in the menu bar (the tray on Windows and Linux) with its window closed.
 * Both are turned on when the User sets up Meetings, so the offers to take notes can come.
 */
export function BackgroundSettings() {
  const t = useT();
  const keepRunning = useAppStore((state) => state.settings?.device.keepRunning);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [login, setLogin] = useState<OpenAtLogin | null>(null);
  useEffect(() => {
    let live = true;
    core.getOpenAtLogin().then(
      (found) => {
        if (live) setLogin(found);
      },
      (error: unknown) => useAppStore.getState().reportError(error),
    );
    return () => {
      live = false;
    };
  }, []);
  const section = useSettingsTarget<HTMLElement>(TARGET, keepRunning !== undefined);
  if (keepRunning === undefined) return null;
  const mac = onMac();

  const setOpenAtLogin = (on: boolean) => {
    if (!login) return;
    const before = login;
    setLogin({ ...login, on });
    core.setOpenAtLogin(on).then(setLogin, (error: unknown) => {
      setLogin(before);
      useAppStore.getState().reportError(error);
    });
  };

  return (
    <SettingsSection ref={section} title={t("settings.background")} testId="background-settings">
      <SettingsGroup>
        {login?.supported && (
          <SettingsSwitchRow
            label={t("settings.openAtLogin")}
            detail={t("settings.openAtLogin.detail")}
            checked={login.on}
            onChange={setOpenAtLogin}
            switchTestId="open-at-login-switch"
          >
            {login.on && login.needsApproval && (
              <ProblemLine
                role="status"
                testId="open-at-login-approve"
                action={{
                  label: t("settings.openAtLogin.openSettings"),
                  onClick: () =>
                    void core.openLoginItemSettings().catch(useAppStore.getState().reportError),
                }}
              >
                {t("settings.openAtLogin.approve")}
              </ProblemLine>
            )}
          </SettingsSwitchRow>
        )}
        <SettingsSwitchRow
          label={t(mac ? "settings.keepRunning.mac" : "settings.keepRunning.other")}
          detail={t(mac ? "settings.keepRunning.detail.mac" : "settings.keepRunning.detail.other")}
          checked={keepRunning}
          onChange={(on) => void updateSettings({ device: { keepRunning: on } })}
          switchTestId="keep-running-switch"
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
