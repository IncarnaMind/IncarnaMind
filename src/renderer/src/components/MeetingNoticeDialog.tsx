import { type ReactNode, useEffect, useState } from "react";
import { core } from "../core";
import { useGap, useT } from "../i18n";
import { useMeetings } from "../meetings";
import { offersCanTurnOn, onMac } from "../platformOffers";
import { useAppStore } from "../store";
import { useAudioKeptKey } from "../transcriptionServices";
import {
  FirstTranscriptionChoiceFields,
  useFirstTranscriptionChoice,
} from "./meetings/FirstTranscriptionChoice";
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

type NoticeFor = NonNullable<ReturnType<typeof useMeetings.getState>["noticeFor"]>;

/**
 * The one-time recording notice: the first "Start recording" on this device
 * says what is recorded and where it stays, reminds the User to tell the
 * others, and where it is transcribed. Starting from it records; Esc or Cancel
 * doesn't. Before a voice memo (#1568) it says only the microphone is recorded,
 * and there is no one else to tell.
 */
export function MeetingNoticeDialog() {
  const waiting = useMeetings((state) => state.noticeFor);
  const { cancelNotice } = useMeetings.getState();
  const dialog = useModal(waiting !== null);
  return (
    <dialog
      ref={dialog}
      data-testid="meeting-notice"
      aria-labelledby="meeting-notice-title"
      aria-describedby="meeting-notice-body"
      onClose={cancelNotice}
      className={`${dialogClass} w-[32.5rem]`}
    >
      {/* Mounted as the sheet opens, so it reads the keys and the choice as they are now. */}
      {waiting && <Notice waiting={waiting} />}
    </dialog>
  );
}

function Notice({ waiting }: { waiting: NoticeFor }) {
  // Whether where it is transcribed was never chosen, as the sheet opened: choosing here must
  // not swap the sheet for another under the User's hands.
  const [asks] = useState(() => {
    const { settings, embedding } = useAppStore.getState();
    return settings?.device.transcriptionRoute == null && embedding?.localOnly !== true;
  });
  if (!("memo" in waiting)) return <RecordCard waiting={waiting} />;
  return asks ? <FirstNotice waiting={waiting} /> : <ChosenNotice waiting={waiting} />;
}

/**
 * The first recording's one card (#3762): what it does in one sentence, then a row for each
 * voice it transcribes, named by what the User gets, each allowed with one press. Transcribed on
 * this computer unless the User chose a service in Settings › AI, where its line says what goes.
 */
function RecordCard({ waiting }: { waiting: { meetingId: string; systemAudio: boolean } }) {
  const t = useT();
  const { acceptNotice, cancelNotice } = useMeetings.getState();
  const [allowed, setAllowed] = useState({ mine: false, theirs: !waiting.systemAudio });
  const start = async () => {
    try {
      if (useAppStore.getState().settings?.device.transcriptionRoute == null)
        await core.updateSettings({ device: { transcriptionRoute: "local" } });
    } catch (error) {
      useAppStore.getState().reportError(error);
      return;
    }
    await acceptNotice();
  };
  const row = (key: "mine" | "theirs", label: string) => (
    <li key={key} className="meeting-card-row">
      <span>{label}</span>
      {allowed[key] ? (
        <span data-testid={`meeting-card-${key}-done`} className="meeting-card-done">
          {t("meetings.card.allowed")}
        </span>
      ) : (
        <button
          type="button"
          data-testid={`meeting-card-${key}`}
          onClick={() => setAllowed((now) => ({ ...now, [key]: true }))}
          className={buttonClass}
        >
          {t("meetings.card.allow")}
        </button>
      )}
    </li>
  );
  return (
    <div className={dialogBodyClass}>
      <h2 id="meeting-notice-title" className={dialogTitleClass}>
        {t("meetings.card.title")}
      </h2>
      <p id="meeting-notice-body" className={dialogTextClass}>
        {t("meetings.card.body")}
      </p>
      <ul className="meeting-card-rows">
        {row("mine", t("meetings.card.mine"))}
        {waiting.systemAudio && row("theirs", t("meetings.card.theirs"))}
      </ul>
      <div className={dialogActionsClass}>
        <button type="button" onClick={cancelNotice} className={buttonClass}>
          {t("meetings.notice.cancel")}
        </button>
        <button
          type="button"
          data-testid="meeting-notice-start"
          disabled={!(allowed.mine && allowed.theirs)}
          onClick={() => void start()}
          className={primaryButtonClass}
        >
          {t("meetings.start.record")}
        </button>
      </div>
    </div>
  );
}

/**
 * The sheet of a User who never chose where meetings are transcribed (#3305): first run's two
 * choices, a cloud service first. Nothing is chosen, and no audio can go anywhere, until Start.
 */
function FirstNotice({ waiting }: { waiting: NoticeFor }) {
  const { acceptNotice } = useMeetings.getState();
  const setup = useFirstTranscriptionChoice();
  const start = async () => {
    if (await setup.finish()) await acceptNotice();
  };
  return (
    <NoticeSheet
      waiting={waiting}
      transcribedHere={setup.shown === "local"}
      picked={setup.shown}
      ready={setup.ready && !setup.busy}
      onStart={() => void start()}
    >
      <FirstTranscriptionChoiceFields setup={setup} onEnter={() => void start()} />
    </NoticeSheet>
  );
}

function ChosenNotice({ waiting }: { waiting: NoticeFor }) {
  const { acceptNotice } = useMeetings.getState();
  const transcribedHere = useAppStore(
    (state) =>
      (state.settings?.device.transcriptionRoute ?? "local") === "local" ||
      state.embedding?.localOnly === true,
  );
  return (
    <NoticeSheet
      waiting={waiting}
      transcribedHere={transcribedHere}
      ready
      onStart={() => void acceptNotice()}
    >
      <TranscriptionRouteChoice />
    </NoticeSheet>
  );
}

function NoticeSheet({
  waiting,
  transcribedHere,
  picked,
  ready,
  onStart,
  children,
}: {
  waiting: NoticeFor;
  transcribedHere: boolean;
  /** What the sheet's own choice is on, before Start keeps it; absent once a choice is kept. */
  picked?: "cloud" | "local";
  ready: boolean;
  onStart(): void;
  children: ReactNode;
}) {
  const t = useT();
  const gap = useGap();
  const { cancelNotice } = useMeetings.getState();
  const memo = "memo" in waiting;
  const microphoneOnly = memo || !waiting.systemAudio;
  const recording = t(microphoneOnly ? "meetings.notice.microphone" : "meetings.notice.both");
  const kept = t(useAudioKeptKey(picked));
  /** Whether the speech model is already here; null until its state has been read. */
  const [modelHere, setModelHere] = useState<boolean | null>(null);
  useEffect(() => {
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
  }, []);
  // Only while it isn't here: "Download and start" is wrong once it is (#763).
  const downloads = transcribedHere && modelHere === false;

  return (
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
        {!memo && offersCanTurnOn() && (
          <p data-testid="meeting-notice-background" className={dialogTextClass}>
            {t(onMac() ? "meetings.notice.background.mac" : "meetings.notice.background.other")}
          </p>
        )}
        {transcribedHere && <p className={dialogTextClass}>{t("meetings.notice.model")}</p>}
        {downloads && (
          <p data-testid="meeting-notice-model-size" className={dialogTextClass}>
            {t("meetings.notice.modelSize")}
          </p>
        )}
      </div>
      {children}
      <div className={dialogActionsClass}>
        <button type="button" onClick={cancelNotice} className={buttonClass}>
          {t("meetings.notice.cancel")}
        </button>
        <button
          type="button"
          data-testid="meeting-notice-start"
          disabled={!ready}
          onClick={onStart}
          className={primaryButtonClass}
        >
          {t(downloads ? "meetings.start.downloadAndStart" : "meetings.start.record")}
        </button>
      </div>
    </div>
  );
}
