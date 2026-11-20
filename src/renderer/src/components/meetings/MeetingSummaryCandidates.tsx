import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Meeting, MeetingSummaryCandidate, MeetingSummarySource } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { core } from "../../core";
import { describeError } from "../../errors";
import { useT } from "../../i18n";
import { clockTime } from "../../meetingTime";
import { useAppStore } from "../../store";
import { openTranscriptOfNote } from "../../transcripts";
import { useUndo } from "../../undo";
import { ChevronRightLineIcon } from "../lineIcons";
import { LineAction, ProblemLine, ProblemMark } from "../ProblemLine";

export function MeetingSummaryCandidates({
  meeting,
  count,
  focusSummary,
}: {
  meeting: Meeting;
  count: number;
  focusSummary(): void;
}) {
  const t = useT();
  const id = useId();
  const section = useRef<HTMLDivElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const reviewing = useRef(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<MessageKey | null>(null);
  const reviewed = meeting.summary?.candidatesReviewed === true;
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);
  const [problem, setProblem] = useState<"load" | "add" | "missing" | "jump" | null>(null);
  const [retry, setRetry] = useState(0);
  const doc = meeting.transcript?.documentId;
  const version = useAppStore(
    (state) => state.documents.find((item) => item.id === doc)?.contentHash,
  );
  const library = useAppStore((state) => state.library);
  const folder = useAppStore(
    (state) => state.minds.find((mind) => mind.id === meeting.mindId)?.folderId,
  );
  const through = meeting.summary?.throughMs;
  const meetingId = meeting.id;
  const lookup = useMemo(
    () => ({ meetingId, doc, count, version, folder, library, through, retry }),
    [meetingId, doc, count, version, folder, library, through, retry],
  );
  const [loaded, setLoaded] = useState<{
    lookup: typeof lookup;
    rows: MeetingSummaryCandidate[];
  } | null>(null);
  const rows = loaded?.lookup === lookup ? loaded.rows : null;

  useEffect(() => {
    if (!open || !reviewed) return;
    let current = true;
    setLoaded(null);
    setProblem(null);
    void core.getMeetingSummaryCandidates(lookup.meetingId).then(
      (found) => {
        if (current) setLoaded({ lookup, rows: found });
      },
      (error: unknown) => {
        if (!current) return;
        console.warn("Meeting review quotes could not be opened", describeError(error).reason);
        setProblem("load");
      },
    );
    return () => {
      current = false;
    };
  }, [lookup, open, reviewed]);

  async function check() {
    if (reviewed || reviewing.current) return;
    reviewing.current = true;
    setCheckError(null);
    setChecking(true);
    try {
      await core.reviewMeetingSummaryCandidates(meetingId);
    } catch (error) {
      const failure = describeError(error);
      console.warn("Meeting quote review failed", failure.reason);
      setCheckError(failure.wording?.key ?? "error.meeting.candidateReviewFailed");
    } finally {
      reviewing.current = false;
      setChecking(false);
    }
  }

  async function showSource(source: MeetingSummarySource) {
    if (!doc) return;
    try {
      await openTranscriptOfNote(meeting.mindId, doc, {
        quote: source.text,
        transcriptCue: { startMs: source.startMs, endMs: source.endMs },
      });
    } catch (error) {
      console.warn("Meeting review quote could not be opened", describeError(error).reason);
      setProblem("jump");
    }
  }

  async function add(candidateId: number) {
    if (busy.current) return;
    busy.current = true;
    setSaving(candidateId);
    setProblem(null);
    const restoreFocus = section.current?.contains(document.activeElement);
    try {
      const updated = await core.addMeetingSummaryCandidate(meeting.id, candidateId);
      useUndo.getState().push({
        said: (translate) => translate("meetings.summary.candidate.added"),
        undo: async () => {
          await core.undoAddMeetingSummaryCandidate(meeting.id, candidateId);
        },
        redo: async () => {
          await core.addMeetingSummaryCandidate(meeting.id, candidateId);
        },
      });

      if (
        restoreFocus &&
        (document.activeElement === document.body ||
          section.current?.contains(document.activeElement))
      ) {
        if (updated.summary?.candidateCount) disclosure.current?.focus();
        else focusSummary();
      }
    } catch (error) {
      const failure = describeError(error);
      if (failure.wording?.key === "error.meeting.summaryCandidateUnavailable")
        setProblem("missing");
      else {
        console.warn("Meeting review quote could not be added", failure.reason);
        setProblem("add");
      }
    } finally {
      busy.current = false;
      setSaving(null);
    }
  }

  return (
    <div ref={section} data-testid="meeting-summary-candidates" className="mt-2 max-w-3xl">
      <button
        ref={disclosure}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={reviewed ? undefined : `${id}-disclosure`}
        className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm py-1 text-start text-[13px] leading-5 font-medium text-ink-secondary hover:text-ink"
        onClick={() => {
          setOpen(!open);
          if (!open && !reviewed && !checkError) void check();
        }}
      >
        <ChevronRightLineIcon
          aria-hidden="true"
          className={`size-3 shrink-0 ${open ? "rotate-90" : ""}`}
        />
        {reviewed
          ? t("meetings.summary.candidates", { count })
          : t("meetings.summary.candidates.find")}
      </button>
      {!reviewed && (
        <span id={`${id}-disclosure`} className="ms-2 text-[12px] text-ink-meta">
          {t("meetings.summary.candidates.disclosure")}
        </span>
      )}
      <div id={id} hidden={!open}>
        {open && (
          <div className="mt-2 space-y-2 ps-4 text-[13px] leading-5">
            {!reviewed && checking && (
              <span role="status">{t("meetings.summary.candidates.checking")}</span>
            )}
            {!reviewed && checkError && (
              <ProblemLine
                action={{ label: t("meetings.fill.tryAgain"), onClick: () => void check() }}
              >
                <ProblemMark />
                {t(checkError)}
              </ProblemLine>
            )}
            {reviewed && rows === null && !problem && (
              <span role="status">{t("meetings.summary.item.loading")}</span>
            )}
            {rows?.length === 0 && !problem && (
              <p>
                {t(
                  count
                    ? "error.meeting.summaryCandidateUnavailable"
                    : "meetings.summary.candidates.empty",
                )}
              </p>
            )}
            {rows && rows.length > 0 && (
              <ul className="space-y-3">
                {rows.map((candidate) => (
                  <li
                    key={candidate.id}
                    className="space-y-1"
                    data-testid="meeting-summary-candidate"
                  >
                    <blockquote
                      id={id + candidate.id}
                      className="space-y-1 border-s-2 border-rule ps-3 text-ink-answer"
                    >
                      {candidate.sources.map((source) => (
                        <p
                          key={JSON.stringify([source.startMs, source.endMs, source.text])}
                          className="break-words whitespace-pre-wrap"
                        >
                          <LineAction
                            action={{
                              label: clockTime(source.startMs),
                              ariaLabel: t("meetings.summary.item.sourceAt", {
                                time: clockTime(source.startMs),
                              }),
                              onClick: () => void showSource(source),
                            }}
                          />{" "}
                          {source.text}
                        </p>
                      ))}
                    </blockquote>
                    <button
                      type="button"
                      aria-describedby={id + candidate.id}
                      disabled={saving !== null}
                      data-testid="meeting-summary-add-candidate"
                      className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline disabled:opacity-50"
                      onClick={() => void add(candidate.id)}
                    >
                      {t("meetings.summary.candidate.add")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {problem && (
              <ProblemLine
                action={
                  problem === "load"
                    ? { label: t("meetings.fill.tryAgain"), onClick: () => setRetry((n) => n + 1) }
                    : undefined
                }
              >
                <ProblemMark />
                {t(
                  problem === "missing"
                    ? "error.meeting.summaryCandidateUnavailable"
                    : problem === "add"
                      ? "meetings.summary.item.saveFailed"
                      : "meetings.summary.item.sourceFailed",
                )}
              </ProblemLine>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
