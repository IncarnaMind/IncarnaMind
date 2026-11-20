import { useId, useState } from "react";
import type { Meeting } from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { frontTabOfMind } from "../../layoutSlice";
import { clockTime } from "../../meetingTime";
import { useMeetingNoteViews } from "../../meetingViews";
import { useAppStore } from "../../store";
import { useGroupsMerged } from "../../useWindowWidth";
import { ProblemLine, ProblemMark } from "../ProblemLine";
import { useTabPlace } from "../tabs/tabItems";

export function MeetingSummary({
  meeting,
  inTranscript = false,
}: {
  meeting: Meeting;
  inTranscript?: boolean;
}) {
  const id = useId();
  const t = useT();
  const [retrying, setRetrying] = useState(false);
  const place = useTabPlace();
  const layout = useAppStore((state) => state.layout);
  const merged = useGroupsMerged();
  const pane = useMeetingNoteViews(
    (state) =>
      frontTabOfMind(layout, meeting.mindId, merged, (tab) => state.views[tab.id]?.view !== "mine")
        ?.id,
  );
  const summary = meeting.summary;
  if (
    meeting.kind !== "meeting" ||
    meeting.status !== "stopped" ||
    !summary ||
    (place && place.tabId !== pane)
  )
    return null;
  const text = summary.text.trim();
  const coverage =
    text && summary.throughMs > 0
      ? t("meetings.summary.coverage", { time: clockTime(summary.throughMs) })
      : null;
  const progress =
    summary.state === "failed"
      ? null
      : summary.state === "ready"
        ? text
          ? null
          : t("meetings.summary.empty")
        : t(text ? "meetings.summary.updating" : "meetings.summary.preparing");

  const retry = async () => {
    setRetrying(true);
    try {
      await core.retryMeetingSummary(meeting.id);
    } catch (error) {
      useAppStore.getState().reportError(error);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section
      data-testid="meeting-summary"
      data-state={summary.state}
      aria-labelledby={id}
      className={
        inTranscript
          ? "max-h-[35vh] shrink-0 overflow-auto border-b border-rule px-4 py-3"
          : "mb-4 border-b border-rule pb-3"
      }
    >
      <h2 id={id} className="text-[13px] leading-5 font-semibold text-ink">
        {t("meetings.summary.title")}
      </h2>
      {summary.state === "failed" && (
        <ProblemLine
          testId="meeting-summary-problem"
          action={{
            label: t("meetings.fill.tryAgain"),
            testId: "meeting-summary-retry",
            disabled: retrying,
            onClick: () => void retry(),
          }}
        >
          <ProblemMark />
          {t(text ? "meetings.summary.updateFailed" : "meetings.summary.failed")}
        </ProblemLine>
      )}
      {(progress || coverage) && (
        <p role="status" className="text-[13px] leading-5 text-ink-meta">
          {[progress, coverage].filter(Boolean).join(" · ")}
        </p>
      )}
      {text && (
        <p
          data-testid="meeting-summary-text"
          className="mt-1 max-w-3xl text-[14px] leading-6 break-words whitespace-pre-wrap text-ink-answer"
        >
          {text}
        </p>
      )}
    </section>
  );
}
