import { useEffect, useState } from "react";
import { core } from "../core";
import { useGap, useT } from "../i18n";
import { useMeetings } from "../meetings";
import { useAppStore } from "../store";
import { useAudioKeptKey } from "../transcriptionServices";
import { TranscriptionRouteChoice } from "./meetings/TranscriptionRouteChoice";
import {
  buttonClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  primaryButtonClass,
} from "./ui";
import { useModal } from "./useModal";

/**
 * The one-time recording notice: the first "Start recording" on this device
 * says what is recorded and where it stays, reminds the User to tell the
 * others, and where it is transcribed. Starting from it records; Esc or Cancel
 * doesn't. Before a voice memo (#1568) it says only the microphone is recorded,
 * and there is no one else to tell.
 */
export function MeetingNoticeDialog() {
  const t = useT();
  const gap = useGap();
  const waiting = useMeetings((state) => state.noticeFor);
  const { acceptNotice, cancelNotice } = useMeetings.getState();
  const dialog = useModal(waiting !== null);
  const memo = waiting !== null && "memo" in waiting;
  const microphoneOnly = waiting !== null && ("memo" in waiting || !waiting.systemAudio);
  const recording = t(microphoneOnly ? "meetings.notice.microphone" : "meetings.notice.both");
  const kept = t(useAudioKeptKey());
  const transcribedHere = useAppStore(
    (state) =>
      (state.settings?.device.transcriptionRoute ?? "local") === "local" ||
      state.embedding?.localOnly === true,
  );
  /** Whether the speech model is already here; null until its state has been read. */
  const [modelHere, setModelHere] = useState<boolean | null>(null);
  useEffect(() => {
    if (waiting === null) return;
    let live = true;
    core.getTranscriptionModel().then(
      (model) => {
        if (live) setModelHere(model?.state === "ready");
      },
      (error: unknown) => {
        // The sheet still opens: it says Start recording, and the model is got ready with the Meeting.
        console.error("The speech model's state couldn't be read.", error);
      },
    );
    return () => {
      live = false;
    };
  }, [waiting]);
  // Only while it isn't here: "Download and start" is wrong once it is (#763).
  const downloads = transcribedHere && modelHere === false;

  return (
    <dialog
      ref={dialog}
      data-testid="meeting-notice"
      aria-labelledby="meeting-notice-title"
      aria-describedby="meeting-notice-body"
      onClose={cancelNotice}
      className={`${dialogClass} w-[32.5rem]`}
    >
      <div className={dialogBodyClass}>
        <h2 id="meeting-notice-title" className={dialogTitleClass}>
          {t("meetings.notice.title")}
        </h2>
        <div id="meeting-notice-body" className="flex flex-col gap-2">
          <p className={dialogTextClass}>
            {recording}
            {gap(recording, kept)}
            {kept}
          </p>
          {!memo && <p className={dialogTextClass}>{t("meetings.notice.tell")}</p>}
          {transcribedHere && <p className={dialogTextClass}>{t("meetings.notice.model")}</p>}
          {downloads && (
            <p data-testid="meeting-notice-model-size" className={dialogTextClass}>
              {t("meetings.notice.modelSize")}
            </p>
          )}
        </div>
        {/* Mounted as the sheet opens, so it reads the keys as they are now. */}
        {waiting && <TranscriptionRouteChoice />}
        <div className={dialogActionsClass}>
          <button type="button" onClick={cancelNotice} className={buttonClass}>
            {t("meetings.notice.cancel")}
          </button>
          <button
            type="button"
            data-testid="meeting-notice-start"
            onClick={() => void acceptNotice()}
            className={primaryButtonClass}
          >
            {t(downloads ? "meetings.start.downloadAndStart" : "meetings.start.record")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
