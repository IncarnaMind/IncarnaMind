import { useId, useState } from "react";
import type { Meeting, MeetingSummaryItem } from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { frontTabOfMind } from "../../layoutSlice";
import { clockTime } from "../../meetingTime";
import { useMeetingNoteViews } from "../../meetingViews";
import { useAppStore } from "../../store";
import { useGroupsMerged } from "../../useWindowWidth";
import { ProblemLine, ProblemMark } from "../ProblemLine";
import { useTabPlace } from "../tabs/tabItems";

function SummaryItems({ items }: { items: readonly MeetingSummaryItem[] }) {
  const t = useT();
  return (
    <details data-testid="meeting-summary-items" className="mt-2 max-w-3xl">
      <summary className="w-fit max-w-full cursor-pointer rounded-sm py-1 text-[13px] leading-5 font-medium text-ink-secondary hover:text-ink">
        {t("meetings.summary.items", { count: items.length })}
      </summary>
      <div className="mt-2 space-y-3 ps-4">
        {(["decision", "action"] as const).map((kind) => {
          const group = items.filter((item) => item.kind === kind);
          if (!group.length) return null;
          const heading = t(`meetings.summary.items.${kind}`);
          const ordered = [
            ...group.filter((item) => item.status === "active"),
            ...group.filter((item) => item.status !== "active"),
          ];
          return (
            <div key={kind}>
              <h3 className="text-[13px] leading-5 font-semibold text-ink">{heading}</h3>
              <ul aria-label={heading} className="mt-1 space-y-2">
                {ordered.map((item) => (
                  <li
                    key={item.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-[13px] leading-5"
                  >
                    <span className="break-words whitespace-pre-wrap text-ink-answer">
                      {item.text}
                    </span>
                    <span className="text-[12px] whitespace-nowrap text-ink-meta">
                      {t(
                        item.status === "active" && kind === "action"
                          ? "meetings.summary.status.open"
                          : `meetings.summary.status.${item.status}`,
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </details>
  );
}

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
          ? "max-h-[min(35vh,65%)] shrink-0 overflow-auto border-b border-rule px-4 py-3 has-[details[open]]:max-h-[65%]"
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
      {!!summary.items?.length && <SummaryItems key={meeting.id} items={summary.items} />}
    </section>
  );
}
