import { type RefObject, useId, useLayoutEffect, useMemo, useRef } from "react";
import type {
  Document,
  MeetingSpeakerReviewResult,
  MeetingSpeakerSuggestion,
} from "../../../core/api";
import type { Cue } from "../../../core/documents/formats/vtt";
import { paddedClockTime } from "../../../shared/clock";
import {
  nameOf,
  speakerName,
  type TranscriptLine,
  withSpeakerChosen,
} from "../../../shared/speakers";
import { CloseLineIcon } from "../components/lineIcons";
import { LineAction, ProblemLine } from "../components/ProblemLine";
import { estimateText } from "../cost";
import { describeError } from "../errors";
import { useDismissOnEscape } from "../escapeDismiss";
import { useLanguage, useT } from "../i18n";
import {
  cancelSpeakerReview,
  decideSpeakerSuggestion,
  hideSpeakerReview,
  openSpeakerReview,
  quoteSpeakerReview,
  runSpeakerReview,
  useMeetingSpeakerReview,
} from "../meetingSpeakerReview";
import { durationLabel } from "../meetingTime";
import { useAppStore } from "../store";
import { suggestionLine, suggestionLines } from "./speakerSuggestion";

export function TranscriptSpeakerReview({
  meetingId,
  owner,
  document,
  cues,
  lines,
  playClip,
  trigger,
}: {
  meetingId: string;
  owner: string;
  document: Document;
  cues: readonly Cue[];
  lines: readonly TranscriptLine[];
  playClip: ((startMs: number, endMs: number) => void) | null;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  const language = useLanguage();
  const review = useMeetingSpeakerReview((state) => state[meetingId]);
  const panelId = useId();
  const panel = useRef<HTMLElement>(null);
  const expanded = review?.owner === owner;
  const phase = expanded ? review.phase : null;
  const showingSuggestions = phase?.kind === "result" && phase.result.suggestions.length > 0;
  const reviewLines = useMemo(
    () => (showingSuggestions ? suggestionLines(cues, document.speakers) : new Map()),
    [cues, document.speakers, showingSuggestions],
  );
  const close = () => {
    hideSpeakerReview(meetingId, owner);
    trigger.current?.focus();
  };
  useDismissOnEscape(expanded, close);
  useLayoutEffect(() => {
    if (expanded) panel.current?.focus();
  }, [expanded]);

  const retry = {
    label: t("meetings.review.tryAgain"),
    onClick: () => {
      panel.current?.focus();
      void quoteSpeakerReview(meetingId, document.id, owner);
    },
  };
  const who = (label: string) => nameOf(document.speakers, label) ?? speakerName(label, t);
  const apply = async (
    suggestion: MeetingSpeakerSuggestion,
    result: MeetingSpeakerReviewResult,
  ) => {
    const store = useAppStore.getState();
    const current = store.documents.find((each) => each.id === result.documentId);
    const line =
      current?.id === document.id
        ? suggestionLine(
            current,
            suggestionLines(cues, current.speakers),
            result.contentHash,
            suggestion,
          )
        : null;
    if (!current || !line) return "stale" as const;
    try {
      const next = withSpeakerChosen(
        current.speakers,
        lines,
        line,
        { label: suggestion.suggestedLabel },
        false,
      );
      const step = await store.setTranscriptSpeakers(
        current.id,
        next,
        (translate, cut) =>
          translate("transcript.speaker.set", {
            name: cut(
              nameOf(next, suggestion.suggestedLabel) ??
                speakerName(suggestion.suggestedLabel, translate),
            ),
          }),
        undefined,
        { expectedSpeakers: current.speakers, expectedContentHash: result.contentHash },
      );
      return step ? ("accepted" as const) : ("failed" as const);
    } catch (error) {
      const { wording, call, reason } = describeError(error);
      if (wording?.key === "error.meeting.reviewChanged") return "stale" as const;
      console.warn("Meeting speaker suggestion could not be saved", { call, reason });
      return "failed" as const;
    }
  };

  const quote = phase?.kind === "quote" ? phase.quote : null;
  const failure = phase?.kind === "failed" ? describeError(phase.error) : null;
  const estimate = quote?.available
    ? estimateText({ amount: quote.estimatedUsd, currency: "USD" }, null, t, language)
    : null;
  const running = review?.phase.kind === "running" || review?.phase.kind === "cancelling";
  return (
    <div className="max-h-[75%] shrink-0 overflow-auto border-b border-rule bg-sheet px-4 py-1.5 text-[13px] leading-5">
      <button
        ref={trigger}
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
        onClick={() => (expanded ? close() : openSpeakerReview(meetingId, document.id, owner))}
      >
        {t(running && !expanded ? "meetings.review.running" : "meetings.review.open")}
      </button>
      {phase && (
        <section
          ref={panel}
          id={panelId}
          tabIndex={-1}
          aria-label={t("meetings.review.title")}
          className="relative mx-auto my-2 max-w-3xl rounded-md border border-rule bg-sheet px-3 py-2"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold text-ink">{t("meetings.review.title")}</h2>
            <button
              aria-label={t("meetings.review.close")}
              title={t("meetings.review.close")}
              className="grid size-6 shrink-0 place-items-center rounded text-ink-meta hover:bg-hover"
              type="button"
              onClick={close}
            >
              <CloseLineIcon className="size-4" />
            </button>
          </div>
          {phase.kind === "quoting" && (
            <p role="status" className="text-ink-meta">
              {t("meetings.review.quoting")}
            </p>
          )}
          {quote?.available && (
            <div className="space-y-1">
              <p className="text-ink-secondary">
                {t(quote.cached ? "meetings.review.cached" : "meetings.review.disclosure")}
              </p>
              {!quote.cached && (
                <p className="text-ink-meta">
                  {t("meetings.review.duration", { duration: durationLabel(quote.durationMs, t) })}
                  {estimate && <> · {estimate}</>}
                </p>
              )}
              <LineAction
                action={{
                  label: t(quote.cached ? "meetings.review.viewCached" : "meetings.review.confirm"),
                  onClick: () => {
                    panel.current?.focus();
                    void runSpeakerReview(meetingId);
                  },
                }}
              />
            </div>
          )}
          {quote && !quote.available && (
            <ProblemLine action={retry}>
              {t(`meetings.review.unavailable.${quote.reason ?? "transcript"}`)}
            </ProblemLine>
          )}
          {(phase.kind === "running" || phase.kind === "cancelling") && (
            <ProblemLine
              role="status"
              action={{
                label: t("meetings.review.cancel"),
                disabled: phase.kind === "cancelling",
                onClick: () => {
                  panel.current?.focus();
                  void cancelSpeakerReview(meetingId);
                },
              }}
            >
              {t(
                phase.kind === "running" ? "meetings.review.running" : "meetings.review.cancelling",
              )}
            </ProblemLine>
          )}
          {phase.kind === "cancelled" && (
            <ProblemLine role="status" action={retry}>
              {t("meetings.review.cancelled")}
            </ProblemLine>
          )}
          {phase.kind === "failed" && (
            <ProblemLine action={retry}>
              {failure?.wording
                ? t(failure.wording.key, failure.wording.values)
                : t("meetings.review.failed")}
            </ProblemLine>
          )}
          {phase.kind === "result" && (
            <LineAction
              action={{
                ...retry,
                label: t("meetings.review.again"),
                disabled: phase.applying !== null,
              }}
            />
          )}
          {phase.kind === "result" &&
            (phase.result.suggestions.length === 0 ? (
              <p role="status" className="text-ink-meta">
                {t("meetings.review.empty")}
              </p>
            ) : (
              <>
                <p role="status" className="text-ink-meta">
                  {t("meetings.review.suggestions")}
                </p>
                <ol className="mt-1 divide-y divide-rule">
                  {phase.result.suggestions.map((suggestion, index) => {
                    const decision = phase.decisions[index];
                    const current =
                      phase.result.documentId === document.id &&
                      suggestionLine(document, reviewLines, phase.result.contentHash, suggestion);
                    const accepted =
                      decision === "accepted" &&
                      phase.result.documentId === document.id &&
                      suggestionLine(
                        document,
                        reviewLines,
                        phase.result.contentHash,
                        suggestion,
                        suggestion.suggestedLabel,
                      );
                    const stale = decision === "stale" || (!current && !accepted);
                    const resolved = accepted || (decision === "kept" && current);
                    const time = paddedClockTime(suggestion.startMs);
                    const from = who(suggestion.currentLabel);
                    const to = who(suggestion.suggestedLabel);
                    return (
                      <li
                        key={`${suggestion.startMs}:${suggestion.fileLabel}`}
                        tabIndex={-1}
                        className="py-2 pr-2"
                      >
                        <p className="break-words text-ink-secondary">
                          <time className="mr-2 tabular-nums text-ink-meta">{time}</time>
                          {t("meetings.review.change", { from, to })}
                        </p>
                        <p className="break-words text-ink">{suggestion.text}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          {playClip && (current || resolved) && (
                            <LineAction
                              action={{
                                label: t("meetings.review.listen"),
                                ariaLabel: t("meetings.review.listenAt", { time }),
                                onClick: () => playClip(suggestion.startMs, suggestion.endMs),
                              }}
                            />
                          )}
                          {resolved ? (
                            <span role="status" className="text-ink-meta">
                              {t(accepted ? "meetings.review.accepted" : "meetings.review.kept")}
                            </span>
                          ) : stale ? (
                            <span role="status" className="text-ink-meta">
                              {t("meetings.review.stale")}
                            </span>
                          ) : (
                            <>
                              <LineAction
                                action={{
                                  label: t("meetings.review.accept"),
                                  disabled: phase.applying !== null,
                                  onClick: (event) => {
                                    event.currentTarget.closest("li")?.focus();
                                    void decideSpeakerSuggestion(meetingId, index, apply);
                                  },
                                }}
                              />
                              <LineAction
                                action={{
                                  label: t("meetings.review.keep"),
                                  disabled: phase.applying !== null,
                                  onClick: (event) => {
                                    event.currentTarget.closest("li")?.focus();
                                    void decideSpeakerSuggestion(meetingId, index);
                                  },
                                }}
                              />
                            </>
                          )}
                          {phase.applying === index && (
                            <span role="status" className="text-ink-meta">
                              {t("meetings.review.applying")}
                            </span>
                          )}
                          {decision === "failed" && !stale && (
                            <ProblemLine>{t("meetings.review.applyFailed")}</ProblemLine>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </>
            ))}
        </section>
      )}
    </div>
  );
}
