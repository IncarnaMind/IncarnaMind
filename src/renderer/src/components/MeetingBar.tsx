import { isMacOS } from "@tiptap/core";
import type { ReactNode, Ref } from "react";
import type { AudioSource, Meeting, MeetingSourceState } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { shortcutLabel } from "../commands/keymap";
import { files } from "../core";
import { useT } from "../i18n";
import { helpKeysLabel, useMeetingHelp } from "../meetingHelp";
import { isWaitingForPermission, useMeetings, useMeetingTime } from "../meetings";
import { clockTime, durationLabel } from "../meetingTime";
import { useGuideInPlace } from "../permissionGuide";
import { useAppStore } from "../store";
import {
  addTranscriptionCredit,
  checkTranscriptionKey,
  ROUTE_LABELS,
} from "../transcriptionServices";
import { FloatLineIcon, PauseLineIcon, ResumeLineIcon, StopLineIcon } from "./lineIcons";
import { LevelBars } from "./meetings/LevelBars";
import { type ProblemAction, ProblemLine } from "./ProblemLine";
import { TranscriptLines } from "./TranscriptLines";

/**
 * A voice memo's bar while it records or is paused, at the top of its Note, kept in view as the
 * notes scroll: its controls, then a line for each thing about the recording the User should
 * know, then whatever the Note adds (its audio, once paused). A recorded call has its control at
 * the Note's foot instead (`meetings/MeetingFoot.tsx`, #3762).
 */
export function MeetingBar({
  meeting,
  children,
  ref,
}: {
  meeting: Meeting;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
}) {
  const t = useT();
  return (
    <section
      ref={ref}
      data-testid="meeting-bar"
      data-status={meeting.status}
      data-kind={meeting.kind}
      aria-label={t(meeting.kind === "memo" ? "memos.bar.label" : "meetings.bar.label")}
      className="meeting-bar"
    >
      <MeetingControls meeting={meeting} />
      <MeetingLines meeting={meeting} />
      <TranscriptLines meeting={meeting} over />
      {children}
    </section>
  );
}

/** The bar's own controls, unseen, where the bar will be: the page keeps its place when it comes, at any width. */
export function MeetingBarRoom({ meeting }: { meeting: Meeting }) {
  return (
    <div aria-hidden="true" data-testid="meeting-bar-room" className="meeting-bar meeting-bar-room">
      <MeetingControls meeting={{ ...meeting, status: "recording" }} />
    </div>
  );
}

/**
 * The live-recording dot (red, the one red outside Citation checks; grey while paused), "Voice
 * memo 00:42" (or "Paused") with its level bars, Pause or Resume, and Stop: a memo has no call's
 * parts (#1568). ⌘⇧P is the "meeting.pauseResume" command's (../commands/meetings).
 */
function MeetingControls({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const time = clockTime(useMeetingTime(meeting));
  const { pause, resume, stop } = useMeetings.getState();
  const recording = meeting.status === "recording";
  const waiting = isWaitingForPermission(meeting);
  const toggle = () => void (recording ? pause(meeting.id) : resume(meeting.id));
  const shortcut = shortcutLabel("meeting.pauseResume");

  return (
    <div data-testid="meeting-controls" className="meeting-controls">
      <span className="meeting-state">
        <span
          aria-hidden="true"
          data-testid="meeting-dot"
          data-status={waiting ? "waiting" : meeting.status}
          className="recording-dot"
        />
        <span data-testid="meeting-state" className="meeting-state-word font-semibold">
          {t(
            waiting
              ? "meetings.bar.waiting"
              : !recording
                ? "meetings.bar.paused"
                : "memos.bar.recording",
          )}
        </span>
        {!waiting && (
          <span role="timer" data-testid="meeting-time" className="meeting-time">
            {time}
          </span>
        )}
        <LevelBars meeting={meeting} />
      </span>
      <button
        type="button"
        data-testid={recording ? "meeting-pause" : "meeting-resume"}
        aria-label={t(recording ? "meetings.bar.pause" : "meetings.bar.resume", { shortcut })}
        title={t(recording ? "meetings.bar.pause" : "meetings.bar.resume", { shortcut })}
        onClick={toggle}
        className="meeting-button meeting-button--icon"
      >
        {recording ? (
          <PauseLineIcon className="size-3.5" />
        ) : (
          <ResumeLineIcon className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        data-testid="meeting-stop"
        aria-label={t("meetings.bar.stopLabel")}
        title={t("meetings.bar.stopLabel")}
        onClick={() => void stop(meeting.id)}
        className="meeting-button meeting-button--words"
      >
        <StopLineIcon className="size-3.5" />
        <span className="meeting-button-word">{t("meetings.bar.stop")}</span>
      </button>
    </div>
  );
}

/** Call help (通话助手): shows or hides the floating panel for this Meeting, as ⌘K and its shortcut do. */
export function CallHelpToggle() {
  const t = useT();
  const shown = useMeetingHelp((state) => state.panel.shown);
  const keys = useAppStore((state) => helpKeysLabel("panel", state.settings));
  const title = shown
    ? t("meetings.callHelp.hide")
    : keys
      ? t("meetings.callHelp.showKeys", { keys })
      : t("meetings.callHelp.show");
  return (
    <button
      type="button"
      data-testid="meeting-call-help"
      data-fold="help"
      aria-pressed={shown}
      aria-label={title}
      title={title}
      onClick={() => files.showMeetingPanel(!shown)}
      className="meeting-button meeting-button--words"
    >
      <FloatLineIcon className="size-4" />
      <span className="meeting-button-word">{t("meetings.callHelp")}</span>
    </button>
  );
}

/**
 * What the User should know about the recording, a line each: its health, a cut, a gap, and
 * transcription back on this computer after the cloud service stopped (#141).
 */
export function MeetingLines({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const problem = useMeetings((state) => state.problems[meeting.id]);
  const gapsSeen = useMeetings((state) => state.gapsSeen[meeting.id] ?? 0);
  const inPlace = useGuideInPlace();
  const { openSettings, resume, dismissGaps, setMicrophonePaused } = useMeetings.getState();
  const settings = (source: AudioSource): ProblemAction => ({
    label: t(isMacOS() ? "meetings.line.openSettings.mac" : "meetings.line.openSettings.other"),
    testId: `meeting-settings-${source}`,
    onClick: () => void openSettings(meeting.id, source),
  });
  const lines: { key: string; text: string; action?: ProblemAction }[] = [];

  if (problem) lines.push({ key: "problem", text: problem });
  if (meeting.saveError) {
    lines.push({
      key: "save",
      text: t("meetings.line.saveFailed", { message: meeting.saveError }),
    });
  }
  if (meeting.status === "paused" && meeting.pausedBy === "interrupted") {
    lines.push({
      key: "interrupted",
      text: t("meetings.line.interrupted", { time: clockTime(meeting.recordedMs) }),
      action: {
        label: t("meetings.line.resume"),
        testId: "meeting-line-resume",
        onClick: () => void resume(meeting.id),
      },
    });
  }
  const microphone = MICROPHONE_LINES[meeting.sources.microphone];
  if (microphone) {
    lines.push({ key: "microphone", text: t(microphone), action: settings("microphone") });
  }
  const system = meeting.systemAudio ? SYSTEM_LINES[meeting.sources.system] : undefined;
  if (system) {
    lines.push({
      key: "system",
      text: t(system),
      ...(meeting.sources.system !== "unavailable" && { action: settings("system") }),
    });
  }
  if (meeting.microphonePausedAtMs !== null) {
    lines.push({
      key: "microphone-paused",
      text: t("meetings.mic.pausedSince", { time: clockTime(meeting.microphonePausedAtMs) }),
      action: {
        label: t("meetings.mic.resumeLine"),
        testId: "meeting-mic-resume",
        onClick: () => void setMicrophonePaused(meeting.id, false),
      },
    });
  }
  const gap = meeting.gaps.length > gapsSeen ? meeting.gaps.at(-1) : undefined;
  if (gap && meeting.status === "recording") {
    lines.push({
      key: "gap",
      text: t(gap.reason === "sleep" ? "meetings.line.gapSleep" : "meetings.line.gapClosed", {
        missed: durationLabel(gap.missedMs, t),
        time: clockTime(gap.atMs),
      }),
      action: { label: t("error.dismiss"), onClick: () => dismissGaps(meeting.id) },
    });
  }
  const fellBack = meeting.transcript?.fellBack;
  if (fellBack) {
    const provider = t(ROUTE_LABELS[fellBack.route]);
    const time = clockTime(fellBack.atMs);
    lines.push({
      key: "cloud",
      text: t(
        fellBack.reason === "refused" && fellBack.route === "qwen"
          ? "meetings.line.cloudRefusedRegion"
          : FELL_BACK[fellBack.reason],
        { provider, time },
      ),
      ...(fellBack.reason === "moved" && {
        action: {
          label: t("meetings.line.chooseAgain"),
          testId: "meeting-line-choose-again",
          onClick: () => useAppStore.getState().openSettings("meetings"),
        },
      }),
      ...(fellBack.reason === "refused" && {
        action: {
          label: t("answer.error.checkKey"),
          testId: "meeting-line-change-key",
          onClick: () => void checkTranscriptionKey(fellBack.route),
        },
      }),
      ...(fellBack.reason === "credit" && {
        action: {
          label: t("answer.error.addCredit"),
          testId: "meeting-line-add-credit",
          onClick: () => void addTranscriptionCredit(fellBack.route),
        },
      }),
    });
  }

  return (
    <>
      {lines.map((line) => (
        <ProblemLine
          key={line.key}
          testId={`meeting-line-${line.key}`}
          role={STATUS_LINES.has(line.key) ? "status" : "alert"}
          className="meeting-line"
          action={line.action}
        >
          {line.text}
        </ProblemLine>
      ))}
      {inPlace && (
        <ProblemLine
          testId="meeting-line-guide"
          role="status"
          className="meeting-line"
          action={{
            label: t("move.dismiss"),
            testId: "meeting-line-guide-close",
            onClick: () => files.closePermissionGuide(),
          }}
        >
          {inPlace.status === "granted"
            ? t(`meetings.guide.done.${inPlace.source}`)
            : t("meetings.guide.inline", { where: t(`meetings.guide.where.${inPlace.source}`) })}
        </ProblemLine>
      )}
    </>
  );
}

const STATUS_LINES: ReadonlySet<string> = new Set([
  "gap",
  "interrupted",
  "cloud",
  "microphone-paused",
]);

const FELL_BACK: Record<
  NonNullable<NonNullable<Meeting["transcript"]>["fellBack"]>["reason"],
  MessageKey
> = {
  dropped: "meetings.line.cloudDropped",
  refused: "meetings.line.cloudRefused",
  credit: "meetings.line.cloudCredit",
  cap: "meetings.line.cloudCap",
  "local-mode": "meetings.line.cloudLocalMode",
  moved: "meetings.line.cloudMoved",
};

const MICROPHONE_LINES: Partial<Record<MeetingSourceState, MessageKey>> = {
  silent: "meetings.line.microphoneSilent",
  denied: "meetings.line.microphoneDenied",
  unavailable: "meetings.line.microphoneUnavailable",
  ended: "meetings.line.microphoneEnded",
};

const SYSTEM_LINES: Partial<Record<MeetingSourceState, MessageKey>> = {
  denied: "meetings.line.systemDenied",
  silent: "meetings.line.systemSilent",
  ended: "meetings.line.systemEnded",
  unavailable: "meetings.line.systemUnavailable",
};
