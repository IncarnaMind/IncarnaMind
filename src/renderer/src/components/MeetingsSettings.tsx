import { useId } from "react";
import type { MessageKey } from "../../../shared/i18n";
import { CHINESE_SCRIPTS, type ChineseScript } from "../../../shared/meetingWords";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { useAudioKeptKey, useTranscriptionServicesRead } from "../transcriptionServices";
import { HelpSettings } from "./meetings/HelpSettings";
import { TranscriptionRouteSelect } from "./meetings/TranscriptionRouteSelect";
import { TranscriptionKeyRows, TranscriptionRouteLine } from "./meetings/TranscriptionSettings";
import { WordsToKnow } from "./meetings/WordsToKnow";
import {
  hintClass,
  rowTextClass,
  rowTitleClass,
  ruledListClass,
  ruledRow,
  sectionTitleClass,
} from "./ui";

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
  // The one read of this section: the route line, the choice and the key rows draw from it.
  const services = useTranscriptionServicesRead();
  if (!device || !canRecord || !script) return null;
  const microphoneOnly = canRecord !== "both";
  const both = device.meetingSystemAudio && !microphoneOnly;

  return (
    <>
      <section data-testid="meetings-settings" className="flex flex-col">
        <h4 className={`mb-2 ${sectionTitleClass}`}>{t("meetings.settings.title")}</h4>
        <div className={ruledListClass}>
          <div className={ruledRow("center")}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor={whatId} className={rowTitleClass}>
                {t("meetings.settings.what")}
              </label>
              <p className={rowTextClass}>
                {t(
                  canRecord === "none"
                    ? "meetings.settings.cantRecord"
                    : microphoneOnly
                      ? "meetings.line.systemUnavailable"
                      : both
                        ? "meetings.settings.whatBoth"
                        : "meetings.settings.whatMe",
                )}
              </p>
            </div>
            <select
              id={whatId}
              data-testid="meetings-what"
              value={both ? "both" : "me"}
              disabled={microphoneOnly}
              onChange={(event) =>
                void updateSettings({
                  device: { meetingSystemAudio: event.target.value === "both" },
                })
              }
              className="h-8 rounded-sm border border-rule-strong bg-sheet px-2 text-[13px] leading-5 text-ink focus:border-accent disabled:opacity-60"
            >
              <option value="both">{t("meetings.audio.both")}</option>
              <option value="me">{t("meetings.audio.me")}</option>
            </select>
          </div>
          <div className={ruledRow("center")}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <label
                htmlFor={routeId}
                title={t("models.defaults.meetings.tip")}
                className={rowTitleClass}
              >
                {t("meetings.settings.route")}
              </label>
              <TranscriptionRouteLine read={services} />
            </div>
            <span id={`${routeId}-tip`} className="sr-only">
              {t("models.defaults.meetings.tip")}
            </span>
            <TranscriptionRouteSelect
              id={routeId}
              className="h-8 rounded-sm border border-rule-strong bg-sheet px-2 text-[13px] leading-5 text-ink focus:border-accent"
              read={services}
            />
          </div>
          <TranscriptionKeyRows read={services} />
          <div className={ruledRow("center")}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor={scriptId} className={rowTitleClass}>
                {t("meetings.script.title")}
              </label>
              <p className={rowTextClass}>{t("meetings.script.body")}</p>
            </div>
            <select
              id={scriptId}
              data-testid="meeting-script"
              value={script}
              onChange={(event) => {
                const chosen = CHINESE_SCRIPTS.find((each) => each === event.target.value);
                if (chosen) void updateSettings({ user: { transcriptScript: chosen } });
              }}
              className="h-8 rounded-sm border border-rule-strong bg-sheet px-2 text-[13px] leading-5 text-ink focus:border-accent"
            >
              {CHINESE_SCRIPTS.map((each) => (
                <option key={each} value={each}>
                  {t(SCRIPT_LABELS[each])}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className={hintClass}>{t(keptKey)}</p>
      </section>
      <WordsToKnow />
      <HelpSettings />
    </>
  );
}
