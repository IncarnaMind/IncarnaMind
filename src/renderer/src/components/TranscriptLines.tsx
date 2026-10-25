import type { Meeting } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { useT } from "../i18n";
import { formatBytes } from "../linkedFolders";
import { useMeetings } from "../meetings";
import { defaultFolderLabel, showOutputLocationSetting } from "../outputFiles";
import { showTranscript } from "../transcripts";
import { failedEverySource, useDownloadSources } from "./DownloadSources";
import { type ProblemAction, ProblemLine } from "./ProblemLine";
import { useTabPlace } from "./tabs/tabItems";

/**
 * What the User should know about a Meeting's Transcript (#136), one line:
 * it is getting ready, live text fell behind ("Recording…"), it is being
 * finished or was saved, or what stopped it, with the one thing to do.
 */
export function TranscriptLines({
  meeting,
  className = "meeting-line",
  over = false,
}: {
  meeting: Meeting;
  className?: string;
  /** In the meeting bar, a status line that comes and goes with the engine hangs below the bar, so the page never moves. A problem never hangs: it has the bar's own row, whole. */
  over?: boolean;
}) {
  const t = useT();
  const place = useTabPlace();
  const transcript = meeting.transcript;
  const sources = useDownloadSources(
    transcript?.problem?.kind === "download" ? transcript.model?.error : null,
    () => void useMeetings.getState().retryTranscript(meeting.id),
    "meeting-transcript",
  );
  if (!transcript) return null;
  const { problem, model, state } = transcript;
  const retry = (key: MessageKey): ProblemAction => ({
    label: t(key),
    testId: "meeting-transcript-retry",
    onClick: () => void useMeetings.getState().retryTranscript(meeting.id),
  });
  const downloading =
    model?.state === "downloading" || model?.state === "not-downloaded"
      ? {
          percent: Math.floor((model.downloadedBytes / Math.max(1, model.totalBytes)) * 100),
          size: formatBytes(model.totalBytes, t),
        }
      : null;

  const documentId = transcript.documentId;
  const open: ProblemAction | undefined = documentId
    ? {
        label: t("meetings.transcript.open"),
        testId: "meeting-transcript-open",
        onClick: () => showTranscript(documentId, place?.groupId),
      }
    : undefined;

  let line: {
    text: string;
    action?: ProblemAction;
    also?: ProblemAction;
    role: "alert" | "status";
  } | null = null;
  if (problem) {
    const message = problem.message;
    if (problem.kind === "speakers") {
      line = {
        text: t("meetings.transcript.speakersFailed"),
        action: retry("meetings.transcript.retry"),
        ...(open && { also: open }),
        role: "alert",
      };
    } else if (problem.kind === "download") {
      line = {
        text: failedEverySource(model?.error)
          ? t("meetings.transcript.downloadFailed.everySource")
          : t("meetings.transcript.downloadFailed", { message }),
        action: retry("meetings.transcript.retry"),
        role: "alert",
      };
    } else if (problem.kind === "engine") {
      line = {
        text: t("meetings.transcript.engineStopped"),
        action: retry("meetings.transcript.retry"),
        role: "alert",
      };
    } else {
      line = {
        text: message
          ? t("meetings.transcript.saveFailed", { message })
          : t("meetings.transcript.notSaved"),
        action: retry("meetings.transcript.save"),
        role: "alert",
      };
    }
  } else if (state === "preparing") {
    line = {
      text: downloading
        ? t("meetings.transcript.downloading", downloading)
        : t("meetings.transcript.starting"),
      role: "status",
    };
  } else if (state === "behind") {
    line = {
      text: t(
        meeting.status === "recording"
          ? "meetings.transcript.behind"
          : "meetings.transcript.behindPaused",
      ),
      role: "status",
    };
  } else if (state === "finishing") {
    line = {
      text: downloading
        ? t("meetings.transcript.finishingDownload", downloading)
        : t("meetings.transcript.finishing"),
      role: "status",
    };
  } else if (state === "saved" && open) {
    line = {
      // The first save says where it went (D209).
      text: transcript.savedDefaulted
        ? t("meetings.transcript.savedIn", { folder: defaultFolderLabel(t) })
        : t("meetings.transcript.saved"),
      action: open,
      ...(transcript.savedDefaulted && {
        also: {
          label: t("export.changeFolder"),
          testId: "meeting-transcript-change-folder",
          onClick: showOutputLocationSetting,
        },
      }),
      role: "status",
    };
  } else if (state === "empty") {
    line = { text: t("meetings.transcript.empty"), role: "status" };
  }
  if (!line) return null;
  const hangs =
    over && !problem && (state === "preparing" || state === "behind" || state === "finishing");
  return (
    <ProblemLine
      testId="meeting-transcript-line"
      role={line.role}
      className={hangs ? `${className} meeting-line-over` : className}
      action={line.action}
      also={line.also}
      disclosure={sources.toggle ? sources : undefined}
    >
      {line.text}
    </ProblemLine>
  );
}
