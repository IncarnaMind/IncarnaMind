import { isMacOS } from "@tiptap/core";
import type { ReactNode } from "react";
import type { AudioSource, Meeting, MeetingSourceState } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { shortcutLabel } from "../commands/keymap";
import { commands } from "../commands/registry";
import { files } from "../core";
import { useT } from "../i18n";
import { helpKeysLabel, useMeetingHelp } from "../meetingHelp";
import { useMeetings, useMeetingTime } from "../meetings";
import { clockTime, durationLabel } from "../meetingTime";
import { useGuideInPlace } from "../permissionGuide";
import { useAppStore } from "../store";
import { hideTranscript, showTranscript, useDocumentTab } from "../transcripts";
import { CaptureDetailsToggle } from "./CaptureDetails";
import {
  BookmarkLineIcon,
  DocumentLineIcon,
  FloatLineIcon,
  PauseLineIcon,
  ResumeLineIcon,
  StopLineIcon,
} from "./lineIcons";
import { BarMore } from "./meetings/BarMore";
import { LevelBars } from "./meetings/LevelBars";
import { MicrophoneButton } from "./meetings/MicrophoneButton";
import { ROUTE_LABELS } from "./meetings/TranscriptionRouteSelect";
import { type ProblemAction, ProblemLine } from "./ProblemLine";
import { TranscriptLines } from "./TranscriptLines";
import { useTabPlace } from "./tabs/tabItems";

/**
 * The meeting bar, while the Mind's Meeting records or is paused: at the top
 * of the Mind, under its title, and kept in view as the notes scroll (the
 * owner's direction of 2026-10-11, in place of DESIGN.md's bar in the
 * composer). Its controls, then a line for each thing about the recording
 * the User should know, then whatever the Mind adds (its audio, once paused).
 */
export function MeetingBar({ meeting, children }: { meeting: Meeting; children?: ReactNode }) {
  const t = useT();
  return (
    <section
      data-testid="meeting-bar"
      data-status={meeting.status}
      aria-label={t("meetings.bar.label")}
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
 * The live-recording dot (red, the one red outside Citation checks; grey
 * while paused), "Recording 24:16" (or "Paused") with its level bars, Pause my mic, Pause or
 * Resume and Stop. ⌘⇧P is the "meeting.pauseResume" command's (../commands/meetings).
 */
function MeetingControls({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const time = clockTime(useMeetingTime(meeting));
  const { pause, resume, stop } = useMeetings.getState();
  const recording = meeting.status === "recording";
  const toggle = () => void (recording ? pause(meeting.id) : resume(meeting.id));
  const shortcut = shortcutLabel("meeting.pauseResume");
  const markShortcut = shortcutLabel("meeting.mark");

  return (
    <div data-testid="meeting-controls" className="meeting-controls">
      <span className="meeting-state">
        <span
          aria-hidden="true"
          data-testid="meeting-dot"
          data-status={meeting.status}
          className="recording-dot"
        />
        <span className="font-semibold">
          {t(recording ? "meetings.bar.recording" : "meetings.bar.paused")}
        </span>
        <span role="timer" data-testid="meeting-time" className="meeting-time">
          {time}
        </span>
        <LevelBars meeting={meeting} />
      </span>
      <MicrophoneButton
        meeting={meeting}
        testId="meeting-mic"
        className="meeting-button meeting-button--icon"
      />
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
      <button
        type="button"
        data-testid="meeting-mark"
        data-fold="mark"
        disabled={!recording}
        aria-label={t("meetings.mark.title", { shortcut: markShortcut })}
        title={t(recording ? "meetings.mark.title" : "meetings.command.markPaused", {
          shortcut: markShortcut,
        })}
        onClick={() => void commands.run("meeting.mark")}
        className="meeting-button meeting-button--words"
      >
        <BookmarkLineIcon className="size-3.5" />
        <span className="meeting-button-word">{t("meetings.mark")}</span>
      </button>
      <CallHelpToggle />
      <TranscriptToggle meeting={meeting} />
      <CaptureDetailsToggle meeting={meeting} />
      <BarMore />
    </div>
  );
}

/** Call help (通话助手): shows or hides the floating panel for this Meeting, as ⌘K and its shortcut do. */
function CallHelpToggle() {
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
      <FloatLineIcon className="size-3.5" />
      <span className="meeting-button-word">{t("meetings.callHelp")}</span>
    </button>
  );
}

/**
 * Show transcript (显示转写稿): opens the Meeting's Transcript as a tab in
 * the group beside its Mind; then Hide transcript closes it (#136). Before
 * the first line there is no Transcript to show yet, and the button waits
 * greyed, so the bar has the same width from its first paint.
 */
function TranscriptToggle({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const place = useTabPlace();
  const documentId = meeting.transcript?.documentId ?? null;
  const tab = useDocumentTab(documentId);
  const label = t(tab ? "meetings.bar.hideTranscript" : "meetings.bar.showTranscript");
  return (
    <button
      type="button"
      data-testid="meeting-transcript-toggle"
      data-fold="transcript"
      aria-pressed={tab !== null}
      disabled={!documentId}
      aria-label={documentId ? label : t("meetings.bar.transcriptSoon")}
      title={documentId ? label : t("meetings.bar.transcriptSoon")}
      onClick={() => {
        if (!documentId) return;
        if (tab) hideTranscript(tab.id);
        else showTranscript(documentId, place?.groupId);
      }}
      className="meeting-button meeting-button--words meeting-button--end"
    >
      <DocumentLineIcon kind="transcript" className="size-3.5" />
      <span className="meeting-button-label">{label}</span>
    </button>
  );
}

/**
 * What the User should know about the recording, a line each: its health, a cut, a gap, and
 * transcription back on this computer after the cloud service stopped (#141).
 */
function MeetingLines({ meeting }: { meeting: Meeting }) {
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
    const service = t(ROUTE_LABELS[fellBack.route]);
    const time = clockTime(fellBack.atMs);
    lines.push({
      key: "cloud",
      text: t(FELL_BACK[fellBack.reason], { service, time }),
      ...(fellBack.reason === "refused" && {
        action: {
          label: t("meetings.key.replace"),
          testId: "meeting-line-change-key",
          // OpenAI's key is its provider's, in Models; a service's own key is in Meetings.
          onClick: () =>
            useAppStore
              .getState()
              .openSettings(fellBack.route === "openai" ? "models" : "meetings"),
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
  cap: "meetings.line.cloudCap",
  "local-mode": "meetings.line.cloudLocalMode",
};

const MICROPHONE_LINES: Partial<Record<MeetingSourceState, MessageKey>> = {
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
