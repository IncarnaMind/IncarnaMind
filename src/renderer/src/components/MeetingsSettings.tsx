import { useId } from "react";
import type { MessageKey } from "../../../shared/i18n";
import { CHINESE_SCRIPTS, type ChineseScript } from "../../../shared/meetingWords";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import {
  ROUTE_LABELS,
  useAudioKeptKey,
  useTranscriptionServicesRead,
} from "../transcriptionServices";
import { CalendarSettings } from "./meetings/CalendarSettings";
import { HelpSettings } from "./meetings/HelpSettings";
import { TranscriptionRouteLine } from "./meetings/TranscriptionSettings";
import { WordsToKnow } from "./meetings/WordsToKnow";
import { PopUpSelect } from "./settings/PopUpButton";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "./settings/SettingsGroup";
import { buttonStyle } from "./ui";

const SCRIPT_LABELS: Record<ChineseScript, MessageKey> = {
  simplified: "meetings.script.simplified",
  traditional: "meetings.script.traditional",
};

export function MeetingsSettings() {
  const t = useT();
  const device = useAppStore((state) => state.settings?.device);
  const canRecord = useAppStore((state) => state.settings?.meetingAudio);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openSettings = useAppStore((state) => state.openSettings);
  const whatId = useId();
  const scriptId = useId();
  const script = useAppStore((state) => state.settings?.chineseScript);
  const keptKey = useAudioKeptKey();
  const services = useTranscriptionServicesRead();
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
            detail={
              <>
                <p data-testid="meetings-route-name" className="text-ink-secondary">
                  {t(ROUTE_LABELS[device.transcriptionRoute ?? "local"])}
                </p>
                <TranscriptionRouteLine read={services} />
              </>
            }
            control={
              <button
                type="button"
                data-testid="meetings-route-change"
                onClick={() => openSettings("ai", "transcription")}
                className={buttonStyle("secondary", "sm")}
              >
                {t("meetings.settings.routeChange")}
              </button>
            }
          />
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
