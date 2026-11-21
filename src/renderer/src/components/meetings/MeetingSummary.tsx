import { useId, useRef } from "react";
import type { Meeting, MeetingSummaryItem } from "../../../../core/api";
import { useT } from "../../i18n";
import { frontTabOfMind } from "../../layoutSlice";
import { clockTime } from "../../meetingTime";
import { useMeetingNoteViews } from "../../meetingViews";
import { useAppStore } from "../../store";
import { useGroupsMerged } from "../../useWindowWidth";
import { useTabPlace } from "../tabs/tabItems";
import { MeetingSummaryCandidates } from "./MeetingSummaryCandidates";
import { MeetingSummaryItems } from "./MeetingSummaryItems";
import { MeetingSummaryProblem } from "./MeetingSummaryProblem";

const NO_ITEMS: readonly MeetingSummaryItem[] = [];

export function MeetingSummary({
  meeting,
  inTranscript = false,
}: {
  meeting: Meeting;
  inTranscript?: boolean;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement | null>(null);
  const t = useT();
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
  const items = summary.items ?? NO_ITEMS;
  const coverage =
    text && summary.throughMs > 0
      ? t("meetings.summary.coverage", { time: clockTime(summary.throughMs) })
      : null;
  const progress =
    summary.state === "failed"
      ? null
      : summary.state === "ready"
        ? text || items.length > 0
          ? null
          : t("meetings.summary.empty")
        : t(text ? "meetings.summary.updating" : "meetings.summary.preparing");

  return (
    <section
      data-testid="meeting-summary"
      data-state={summary.state}
      aria-labelledby={id}
      className={
        inTranscript
          ? "max-h-[min(35vh,65%)] shrink-0 overflow-auto border-b border-rule px-4 py-3 has-[details[open]]:max-h-[65%] has-[[aria-expanded=true]]:max-h-[65%]"
          : "mb-4 border-b border-rule pb-3"
      }
    >
      <h2
        ref={heading}
        id={id}
        tabIndex={-1}
        className="text-[13px] leading-5 font-semibold text-ink"
      >
        {t("meetings.summary.title")}
      </h2>
      {summary.state === "failed" && <MeetingSummaryProblem meeting={meeting} summary={summary} />}
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
      <MeetingSummaryItems
        key={meeting.id}
        meeting={meeting}
        items={items}
        focusSummary={() => heading.current?.focus()}
      />
      {(summary.candidatesReviewed ||
        (summary.state === "ready" && !!text && meeting.transcript?.state === "saved")) && (
        <MeetingSummaryCandidates
          key={`candidates-${meeting.id}`}
          meeting={meeting}
          count={summary.candidateCount ?? 0}
          focusSummary={() => heading.current?.focus()}
        />
      )}
    </section>
  );
}
