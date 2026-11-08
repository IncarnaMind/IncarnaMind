import { useId, useState } from "react";
import type { CallWatchProblem } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { MEETING_APPS, meetingAppName } from "../../../shared/meetingApps";
import { useCalendars } from "../calendars";
import { useLanguage, useT } from "../i18n";
import { useMeetingOffers } from "../meetingOffers";
import { useSettingsTarget } from "../settingsTarget";
import { useAppStore } from "../store";
import { closeTip } from "../tips";
import { ProblemLine } from "./ProblemLine";
import { SettingsRow, SettingsSwitch, SettingsSwitchRow } from "./settings/SettingsGroup";
import { ghostButtonClass } from "./ui";

const TARGET = ["call-offers"] as const;

const PROBLEM_LINES: Record<CallWatchProblem, MessageKey> = {
  "no-pactl": "settings.callOffers.noPactl",
  "not-on-windows": "settings.callOffers.notOnWindows",
  unavailable: "settings.callOffers.unavailable",
};

/** The apps this computer's system can name as using the microphone. */
function appsHere() {
  const platform = navigator.platform;
  const key = /Mac/.test(platform) ? "mac" : /Win/.test(platform) ? "windows" : "linux";
  return MEETING_APPS.filter((app) => app[key].length > 0);
}

/**
 * Settings → General → Notifications, the offers to take notes (#189): before a calendar meeting
 * (#207), shown once a calendar is connected in Settings › Meetings (#190), and when a call app takes the microphone
 * (#208), with Per app… unfolding a switch for each app ("Not for Zoom").
 */
export function MeetingOfferSettings() {
  const t = useT();
  const language = useLanguage();
  const listId = useId();
  const device = useAppStore((state) => state.settings?.device);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const calendarConnected = useCalendars((state) => (state.calendars?.accounts.length ?? 0) > 0);
  const problem = useMeetingOffers((state) => state.offers.problem);
  const [perApp, setPerApp] = useState(false);
  const row = useSettingsTarget<HTMLDivElement>(TARGET, device !== undefined);
  if (!device) return null;
  const off = device.callOffersOff;
  const setApp = (app: string, on: boolean) =>
    void updateSettings({
      device: { callOffersOff: on ? off.filter((each) => each !== app) : [...off, app] },
    });

  return (
    <>
      {calendarConnected && (
        <SettingsSwitchRow
          label={t("settings.calendarOffers")}
          detail={t("settings.calendarOffers.detail")}
          checked={device.calendarOffers}
          onChange={(on) => void updateSettings({ device: { calendarOffers: on } })}
          switchTestId="calendar-offers-switch"
        />
      )}
      <SettingsRow
        ref={row}
        data-testid="call-offers"
        label={t("settings.callOffers")}
        detail={t("settings.callOffers.detail")}
        control={
          <>
            <button
              type="button"
              data-testid="call-offers-per-app"
              aria-expanded={perApp}
              aria-controls={listId}
              onClick={() => setPerApp(!perApp)}
              className={ghostButtonClass}
            >
              {t("settings.callOffers.perApp")}
            </button>
            <SettingsSwitch
              checked={device.callOffers}
              onChange={(on) => {
                closeTip("call-offers");
                void updateSettings({ device: { callOffers: on } });
              }}
              testId="call-offers-switch"
              ariaLabel={t("settings.callOffers")}
            />
          </>
        }
      >
        {device.callOffers && problem && (
          <ProblemLine role="status" testId="call-offers-problem">
            {t(PROBLEM_LINES[problem])}
          </ProblemLine>
        )}
        {perApp && (
          <ul
            id={listId}
            data-testid="call-offers-apps"
            aria-label={t("settings.callOffers.apps")}
            className="flex flex-col"
          >
            {appsHere().map((app) => {
              const name = meetingAppName(app.id, language);
              return (
                <li key={app.id} className="flex min-h-9 items-center gap-3">
                  <span className="min-w-0 flex-1 text-ui text-ink">{name}</span>
                  <SettingsSwitch
                    checked={device.callOffers && !off.includes(app.id)}
                    disabled={!device.callOffers}
                    onChange={(on) => setApp(app.id, on)}
                    testId={`call-offers-app-${app.id}`}
                    ariaLabel={name}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </SettingsRow>
    </>
  );
}
