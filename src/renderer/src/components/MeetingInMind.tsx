import { type Ref, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Meeting } from "../../../core/api";
import { commands } from "../commands/registry";
import { useDismissOnEscape } from "../escapeDismiss";
import { useGap, useLanguage, useT } from "../i18n";
import { audioSaid, canKeepAudio } from "../meetingAudioWords";
import { isLive, useMeetingOf, useMeetings } from "../meetings";
import { clockTime } from "../meetingTime";
import { showMeetingDetails, useMeetingNoteView } from "../meetingViews";
import { useRequests } from "../requests";
import { useAppStore } from "../store";
import { useAudioKeptKey } from "../transcriptionServices";
import { CaptureDetails, CaptureDetailsLine, CaptureProblem } from "./CaptureDetails";
import { CloseLineIcon, RecordingLineIcon } from "./lineIcons";
import { MeetingBar, MeetingBarRoom } from "./MeetingBar";
import { MeetingFillLine } from "./MeetingFillLine";
import { MetaLine } from "./MetaLine";
import { LineAction, ProblemLine } from "./ProblemLine";
import { TranscriptLines } from "./TranscriptLines";
import { useTabPlace } from "./tabs/tabItems";
import { buttonStyle, fieldLabelClass, inputClass } from "./ui";

/**
 * A Meeting's place in its Mind, under the title: the start block while it is
 * ready, and the meeting bar while it records or is paused, its recording
 * details (#161) opening from it. Once a call stops, the page stays bare
 * (#2527): only a problem shows here, and the rest is in the chip beside ⋯
 * (`MeetingViewChip`). A stopped voice memo keeps its lines about its
 * Transcript, its note and its audio here.
 */
export function MeetingInMind({ mindId }: { mindId: string }) {
  const meeting = useMeetingOf(mindId);
  const starting = useMeetings((state) => !!meeting && state.starting[meeting.id] === true);
  const tabId = useTabPlace()?.tabId;
  const view = useMeetingNoteView(tabId, mindId);
  const bar = useRef<HTMLElement>(null);
  const barHeight = useRef(0);
  useLayoutEffect(() => {
    if (bar.current) barHeight.current = bar.current.offsetHeight;
  });
  if (!meeting) return null;
  if (meeting.status === "ready" && starting) {
    return <MeetingBarRoom meeting={meeting} />;
  }
  if (meeting.status === "ready") return <MeetingStart meeting={meeting} />;
  if (isLive(meeting)) {
    if (view === "notes" || meeting.kind === "memo") {
      return <LiveMeetingBar meeting={meeting} ref={bar} />;
    }
    // The Transcript view draws the bar over the Transcript; the hidden notes keep its room, so
    // they come back where the User left them.
    return (
      <div aria-hidden="true" className="meeting-bar-space" style={{ height: barHeight.current }} />
    );
  }
  if (meeting.kind === "meeting") {
    return (
      <div className="empty:hidden mb-4">
        <TranscriptLines meeting={meeting} className="" problemsOnly />
        <CaptureProblem meeting={meeting} onDetails={() => showMeetingDetails(meeting.mindId)} />
      </div>
    );
  }
  return (
    <div className="mb-4">
      <TranscriptLines meeting={meeting} className="" />
      <MeetingFillLine meeting={meeting} />
      <CaptureProblem meeting={meeting} />
      <MeetingAudioLine meeting={meeting} />
      <CaptureDetailsLine meeting={meeting} />
      <CaptureDetails meeting={meeting} />
    </div>
  );
}

export function LiveMeetingBar({ meeting, ref }: { meeting: Meeting; ref?: Ref<HTMLElement> }) {
  return (
    <MeetingBar meeting={meeting} ref={ref}>
      <CaptureProblem meeting={meeting} className="meeting-line" />
      {meeting.status === "paused" && <MeetingAudioLine meeting={meeting} />}
      <CaptureDetails meeting={meeting} />
    </MeetingBar>
  );
}

/**
 * Starting a meeting, inline in its new Mind (the canvas board
 * Final-03-MeetingStart): what is recorded, "Start recording", and the
 * reminder to tell everyone. ✕ or Esc keeps the Mind as a note.
 */
function MeetingStart({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const keptKey = useAudioKeptKey();
  const keptForGood = useAppStore((state) => state.settings?.device.keepMeetingAudio === true);
  const audioId = useId();
  const canRecord = useAppStore((state) => state.settings?.meetingAudio ?? "none");
  const [systemAudio, setSystemAudio] = useState(meeting.systemAudio);
  const [copied, setCopied] = useState(false);
  const problem = useMeetings((state) => state.problems[meeting.id]);
  const { start, discard } = useMeetings.getState();
  const microphoneOnly = canRecord === "microphone";
  const recordButton = useRef<HTMLButtonElement>(null);
  const focusHere = useMeetings((state) => state.startToFocus === meeting.id);

  useEffect(() => {
    if (!focusHere) return;
    recordButton.current?.focus();
    useMeetings.setState({ startToFocus: null });
  }, [focusHere]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyNotice = async () => {
    try {
      await navigator.clipboard.writeText(
        t(keptForGood ? "meetings.start.noticeTextKept" : "meetings.start.noticeText"),
      );
      setCopied(true);
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  };

  return (
    <section
      data-testid="meeting-start"
      aria-label={t("meetings.start.label")}
      className="meeting-start"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        void discard(meeting.id);
      }}
    >
      <div className="flex items-start gap-3">
        <div className="w-56 max-w-full min-w-0">
          <label htmlFor={audioId} className={fieldLabelClass}>
            {t("meetings.start.audio")}
          </label>
          <select
            id={audioId}
            data-testid="meeting-start-audio"
            value={systemAudio && !microphoneOnly ? "both" : "me"}
            disabled={microphoneOnly}
            onChange={(event) => setSystemAudio(event.target.value === "both")}
            className={inputClass}
          >
            <option value="both">{t("meetings.audio.both")}</option>
            <option value="me">{t("meetings.audio.me")}</option>
          </select>
        </div>
        <button
          type="button"
          data-testid="meeting-start-dismiss"
          aria-label={t("meetings.start.dismiss")}
          title={t("meetings.start.dismiss")}
          onClick={() => void discard(meeting.id)}
          className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-meta hover:bg-chip hover:text-ink"
        >
          <CloseLineIcon className="size-4" />
        </button>
      </div>
      {microphoneOnly && (
        <p data-testid="meeting-start-microphone-only" className="meeting-start-note">
          {t("meetings.line.systemUnavailable")}
        </p>
      )}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <button
          ref={recordButton}
          type="button"
          data-testid="meeting-start-record"
          onClick={() => void start(meeting.id, systemAudio && !microphoneOnly)}
          className={buttonStyle("primary", "lg")}
        >
          <RecordingLineIcon className="size-4" />
          {t("meetings.start.record")}
        </button>
        <div className="min-w-0 flex-1 basis-64 text-[13px] leading-5">
          <p className="text-ink-strong">
            {t("meetings.start.tell")}
            <span aria-hidden="true"> · </span>
            <button
              type="button"
              data-testid="meeting-start-copy-notice"
              onClick={() => void copyNotice()}
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              {t("meetings.start.copyNotice")}
            </button>
            {copied && (
              <span role="status" className="ml-2 text-ink-meta">
                {t("meetings.start.copied")}
              </span>
            )}
          </p>
          <p className="text-[12px] leading-[18px] text-ink-meta">{t(keptKey)}</p>
        </div>
      </div>
      {problem && <ProblemLine testId="meeting-start-problem">{problem}</ProblemLine>}
    </section>
  );
}

/** Puts the question about this Meeting's audio away, if it is the one being asked. */
function keepAudio(meetingId: string): void {
  const { deleteAudio, clear } = useRequests.getState();
  if (deleteAudio?.meetingId === meetingId) clear("deleteAudio");
}

/**
 * How long was recorded, how long the audio stays on this computer, and
 * "Delete audio now", which is the "meeting.deleteAudio" command, as ⌘K's
 * "Delete audio" is: it asks first, on the same line, because it can't be undone.
 */
function MeetingAudioLine({ meeting, className = "" }: { meeting: Meeting; className?: string }) {
  const t = useT();
  const language = useLanguage();
  const gap = useGap();
  const { deleteAudio } = useMeetings.getState();
  const asked = useRequests((state) => state.deleteAudio?.meetingId === meeting.id);
  const { audio } = meeting;
  const asking = asked && audio.kept;
  useDismissOnEscape(asking, () => keepAudio(meeting.id));
  // Asked about while this line wasn't on screen, it is a question nobody saw.
  useEffect(() => {
    keepAudio(meeting.id);
  }, [meeting.id]);
  if (asking) {
    return (
      <p
        role="alert"
        data-testid="meeting-audio-confirm"
        className={`font-sans text-[13px] leading-5 break-words text-ink-meta ${className}`}
      >
        {t("meetings.audio.confirm")}
        {gap(t("meetings.audio.confirm"), t("meetings.audio.deleteConfirm"))}
        <button
          type="button"
          // biome-ignore lint/a11y/noAutofocus: the User just asked to delete: the choice is here.
          autoFocus
          data-testid="meeting-audio-delete-confirm"
          onClick={() => {
            keepAudio(meeting.id);
            void deleteAudio(meeting.id);
          }}
          className="rounded-sm font-semibold text-ink underline underline-offset-2"
        >
          {t("meetings.audio.deleteConfirm")}
        </button>
        <span aria-hidden="true"> · </span>
        <button
          type="button"
          onClick={() => keepAudio(meeting.id)}
          className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
        >
          {t("meetings.audio.keep")}
        </button>
      </p>
    );
  }
  const run = (id: "meeting.keepAudio" | "meeting.deleteAudio") => () =>
    void commands.run(id, { focus: { kind: "mind", id: meeting.mindId } });
  return (
    <MetaLine
      role="status"
      data-testid="meeting-audio"
      className={`font-sans text-[13px] leading-5 break-words text-ink-meta ${className}`}
      parts={[
        meeting.status === "stopped" &&
          t("meetings.audio.recorded", { time: clockTime(meeting.recordedMs) }),
        audioSaid(meeting, t, language),
        canKeepAudio(meeting) && (
          <LineAction
            key="keep"
            action={{
              label: t("meetings.audio.keepAudio"),
              testId: "meeting-audio-keep-for-good",
              onClick: run("meeting.keepAudio"),
            }}
          />
        ),
        audio.kept && (
          <LineAction
            key="delete"
            action={{
              label: t("meetings.audio.delete"),
              testId: "meeting-audio-delete",
              onClick: run("meeting.deleteAudio"),
            }}
          />
        ),
      ]}
    />
  );
}
