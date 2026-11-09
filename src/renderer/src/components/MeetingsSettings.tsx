import { useId } from "react";
import type { MessageKey } from "../../../shared/i18n";
import { CHINESE_SCRIPTS, type ChineseScript } from "../../../shared/meetingWords";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { useAudioKeptKey, useTranscriptionServicesRead } from "../transcriptionServices";
import { CalendarSettings } from "./meetings/CalendarSettings";
import { HelpSettings } from "./meetings/HelpSettings";
import { TranscriptionRouteSelect } from "./meetings/TranscriptionRouteSelect";
import { TranscriptionRouteLine } from "./meetings/TranscriptionSettings";
import { useTranscriptionSetUp } from "./meetings/TranscriptionSetUp";
import { WordsToKnow } from "./meetings/WordsToKnow";
import { PopUpSelect } from "./settings/PopUpButton";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "./settings/SettingsGroup";

const SCRIPT_LABELS: Record<ChineseScript, MessageKey> = {
  simplified: "meetings.script.simplified",
  traditional: "meetings.script.traditional",
};

export function MeetingsSettings() {
  const t = useT();
  const device = useAppStore((state) => state.settings?.device);
  const canRecord = useAppStore((state) => state.settings?.meetingAudio);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const whatId = useId();
  const routeId = useId();
  const scriptId = useId();
  const script = useAppStore((state) => state.settings?.chineseScript);
  const keptKey = useAudioKeptKey();
  // The one read of this section: the route line and the choice draw from it.
  const services = useTranscriptionServicesRead();
  const setUp = useTranscriptionSetUp(routeId, services);
  if (!device || !canRecord || !script) return null;
  const microphoneOnly = canRecord !== "both";
  const both = device.meetingSystemAudio && !microphoneOnly;

  return (
    <>
      <CalendarSettings />
      <SettingsSection
        title={t("meetings.settings.title")}
        testId="meetings-settings"
        help={t(keptKey)}
      >
        <SettingsGroup>
          <SettingsRow
            label={t("meetings.settings.what")}
            htmlFor={whatId}
            detail={t(
              canRecord === "none"
                ? "meetings.settings.cantRecord"
                : microphoneOnly
                  ? "meetings.line.systemUnavailable"
                  : both
                    ? "meetings.settings.whatBoth"
                    : "meetings.settings.whatMe",
            )}
            control={
              <PopUpSelect
                id={whatId}
                data-testid="meetings-what"
                value={both ? "both" : "me"}
                disabled={microphoneOnly}
                onChange={(event) =>
                  void updateSettings({
                    device: { meetingSystemAudio: event.target.value === "both" },
                  })
                }
              >
                <option value="both">{t("meetings.audio.both")}</option>
                <option value="me">{t("meetings.audio.me")}</option>
              </PopUpSelect>
            }
          />
          <SettingsSwitchRow
            label={t("meetings.settings.keepAudio")}
            detail={t(
              device.keepMeetingAudio
                ? "meetings.settings.keepAudioOn"
                : "meetings.settings.keepAudioOff",
            )}
            checked={device.keepMeetingAudio}
            onChange={(keepMeetingAudio) => void updateSettings({ device: { keepMeetingAudio } })}
            switchTestId="meetings-keep-audio"
          />
          <SettingsRow
            label={t("meetings.settings.route")}
            htmlFor={routeId}
            tip={t("models.defaults.meetings.tip")}
            tipId={`${routeId}-tip`}
            detail={<TranscriptionRouteLine read={services} />}
            control={
              <TranscriptionRouteSelect
                id={routeId}
                popUp
                read={services}
                setUp={setUp.rows}
                onChosen={setUp.onChosen}
              />
            }
          >
            {setUp.panel}
          </SettingsRow>
          <SettingsRow
            label={t("meetings.script.title")}
            htmlFor={scriptId}
            detail={t("meetings.script.body")}
            control={
              <PopUpSelect
                id={scriptId}
                data-testid="meeting-script"
                value={script}
                onChange={(event) => {
                  const chosen = CHINESE_SCRIPTS.find((each) => each === event.target.value);
                  if (chosen) void updateSettings({ user: { transcriptScript: chosen } });
                }}
              >
                {CHINESE_SCRIPTS.map((each) => (
                  <option key={each} value={each}>
                    {t(SCRIPT_LABELS[each])}
                  </option>
                ))}
              </PopUpSelect>
            }
          />
        </SettingsGroup>
      </SettingsSection>
      <WordsToKnow services={services} />
      <HelpSettings />
    </>
  );
}
