import { useId } from "react";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { useAudioKeptKey } from "../transcriptionServices";
import { HelpSettings } from "./meetings/HelpSettings";
import { TranscriptionRouteSelect } from "./meetings/TranscriptionRouteSelect";
import { TranscriptionKeyRows, TranscriptionRouteLine } from "./meetings/TranscriptionSettings";
import {
  hintClass,
  rowTextClass,
  rowTitleClass,
  ruledListClass,
  ruledRow,
  sectionTitleClass,
} from "./ui";

export function MeetingsSettings() {
  const t = useT();
  const device = useAppStore((state) => state.settings?.device);
  const canRecord = useAppStore((state) => state.settings?.meetingAudio);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const whatId = useId();
  const routeId = useId();
  const keptKey = useAudioKeptKey();
  if (!device || !canRecord) return null;
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
              <TranscriptionRouteLine />
            </div>
            <span id={`${routeId}-tip`} className="sr-only">
              {t("models.defaults.meetings.tip")}
            </span>
            <TranscriptionRouteSelect
              id={routeId}
              className="h-8 rounded-sm border border-rule-strong bg-sheet px-2 text-[13px] leading-5 text-ink focus:border-accent"
            />
          </div>
          <TranscriptionKeyRows />
        </div>
        <p className={hintClass}>{t(keptKey)}</p>
      </section>
      <HelpSettings />
    </>
  );
}
