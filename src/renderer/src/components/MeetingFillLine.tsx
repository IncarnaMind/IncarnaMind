import type { Meeting, MeetingFillProblem } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { isPartialMeetingFill } from "../../../shared/meetingFill";
import { useT } from "../i18n";
import { useFillStep } from "../meetingFillSteps";
import { useMeetings } from "../meetings";
import { showMeetingNoteView } from "../meetingViews";
import { CheckLineIcon } from "./lineIcons";
import { type ProblemAction, ProblemLine } from "./ProblemLine";
import { speechModelDownload } from "./TranscriptLines";
import { useTabPlace } from "./tabs/tabItems";

const REASONS = {
  model: "meetings.fill.problem.model",
  stopped: "meetings.fill.problem.stopped",
  "local-mode": "meetings.fill.problem.localMode",
  "not-allowed": "meetings.fill.problem.notAllowed",
  "no-model": "meetings.fill.problem.noModel",
  "no-transcript": "meetings.fill.problem.noTranscript",
  added: "memos.fill.problem.added",
} as const satisfies Record<MeetingFillProblem["kind"], MessageKey>;

/** A voice memo's note is written, not filled in (#1568): its own words where they differ. */
const WORDS = {
  meeting: {
    waiting: "meetings.fill.waiting",
    filling: "meetings.fill.filling",
    fillingLocal: "meetings.fill.fillingLocal",
    filled: "meetings.fill.filled",
    undone: "meetings.fill.undone",
    again: "meetings.fill.again",
    failed: "meetings.fill.failed",
  },
  memo: {
    waiting: "memos.fill.waiting",
    filling: "memos.fill.filling",
    fillingLocal: "memos.fill.fillingLocal",
    filled: "memos.fill.filled",
    undone: "memos.fill.undone",
    again: "memos.fill.again",
    failed: "memos.fill.failed",
  },
} as const satisfies Record<Meeting["kind"], Record<string, MessageKey>>;

/**
 * Where filling the notes in from the Transcript is (#142), one line under a stopped Meeting:
 * finishing the Transcript, filling in (on this computer, where it is), "Notes filled in ·
 * Undo", or why they weren't, with Try again. A voice memo's says its note was written, or that
 * its Transcript went in as it is, and why. `editor`: the one it shows in, whose own Undo may
 * hold the fill. What the User asked of it and couldn't be done says so in its place.
 */
export function MeetingFillLine({ meeting, editor }: { meeting: Meeting; editor?: object }) {
  const t = useT();
  const place = useTabPlace();
  const step = useFillStep(meeting.id, editor);
  const problem = useMeetings((state) => state.problems[meeting.id]);
  if (!meeting.fill) return null;
  // The editor holding the fill on its own Undo is ahead of the core, which follows it.
  const fill =
    step === "undone" && meeting.fill.state === "filled"
      ? { ...meeting.fill, state: "undone" as const }
      : step === "top" && meeting.fill.state === "undone"
        ? { ...meeting.fill, state: "filled" as const }
        : meeting.fill;
  const words = WORDS[meeting.kind];
  const again = (label: string): ProblemAction => ({
    label,
    testId: "meeting-fill-again",
    onClick: () => void useMeetings.getState().fillNotes(meeting.id),
  });
  const undo: ProblemAction = {
    label: t("meetings.fill.undo"),
    testId: "meeting-fill-undo",
    onClick: () => void useMeetings.getState().undoFill(meeting.id, editor),
  };
  // Said in the interface's words now; a model's own words show on hover.
  const reasonOf = (problem: MeetingFillProblem | null) =>
    t(
      meeting.kind === "memo" && problem?.kind === "not-allowed"
        ? "memos.fill.problem.notAllowed"
        : REASONS[problem?.kind ?? "model"],
      { service: problem?.service ?? "" },
    );

  if (problem && fill.state !== "waiting" && fill.state !== "filling") {
    return (
      <ProblemLine
        testId="meeting-fill-line"
        role="alert"
        className=""
        action={
          fill.state === "filled"
            ? undo
            : again(t(fill.state === "undone" ? words.again : "meetings.fill.tryAgain"))
        }
      >
        {problem}
      </ProblemLine>
    );
  }
  if (fill.state === "waiting" || fill.state === "filling") {
    // From Stop, a call's note says what is under way: its Transcript's last lines and speakers,
    // then the note (#2773). A Transcript that stopped says why in its own line.
    const finishing =
      meeting.kind === "meeting" && fill.state === "waiting" && !meeting.transcript?.problem;
    const downloading = finishing
      ? speechModelDownload(meeting.transcript?.model ?? null, t)
      : null;
    const text = downloading
      ? t("meetings.transcript.finishingDownload", downloading)
      : finishing
        ? t("meetings.transcript.finishing")
        : fill.state === "waiting"
          ? t(words.waiting)
          : t(fill.local ? words.fillingLocal : words.filling);
    return (
      <ProblemLine testId="meeting-fill-line" role="status" className="">
        <span className={fill.state === "filling" || finishing ? "answer-writing" : undefined}>
          {text}
        </span>
      </ProblemLine>
    );
  }
  const omitted = fill.omitted ?? 0;
  const unfinishedParts = fill.unfinishedParts ?? 0;
  if (
    meeting.kind === "meeting" &&
    ((fill.state === "filled" && isPartialMeetingFill(fill)) ||
      (fill.state === "failed" && (omitted > 0 || unfinishedParts > 0)))
  ) {
    const filled = fill.state === "filled";
    const documentId = meeting.transcript?.documentId;
    return (
      <ProblemLine
        testId="meeting-fill-line"
        role={filled ? "status" : "alert"}
        title={!filled && fill.problem?.kind === "model" ? fill.problem.message : undefined}
        details={[
          ...(omitted > 0
            ? [
                t(omitted === 1 ? "meetings.fill.omitted.one" : "meetings.fill.omitted", {
                  count: omitted,
                }),
              ]
            : []),
          ...(unfinishedParts > 0
            ? [
                t(
                  unfinishedParts === 1
                    ? "meetings.fill.unfinishedParts.one"
                    : "meetings.fill.unfinishedParts",
                  { count: unfinishedParts },
                ),
              ]
            : []),
        ]}
        action={
          documentId && place
            ? {
                label: t("meetings.fill.viewTranscript"),
                testId: "meeting-fill-transcript",
                onClick: () =>
                  showMeetingNoteView(place.tabId, meeting.mindId, "transcript", { focus: true }),
              }
            : undefined
        }
        also={filled ? undo : again(t("meetings.fill.tryAgain"))}
      >
        {t(filled ? "meetings.fill.partial" : "meetings.fill.noAdditions")}
      </ProblemLine>
    );
  }
  if (fill.state === "filled") {
    // A call's note fills in as any AI edit applies: its line goes once the User types (#2527).
    if (meeting.kind === "meeting" && step !== "top") return null;
    return (
      <ProblemLine testId="meeting-fill-line" role="status" className="" action={undo}>
        {fill.mode === "transcript" ? (
          t("memos.fill.asIs", { reason: reasonOf(fill.problem) })
        ) : (
          <>
            {meeting.kind === "meeting" && (
              <CheckLineIcon className="mr-1 inline size-3.5 align-[-2px]" />
            )}
            {t(words.filled)}
          </>
        )}
      </ProblemLine>
    );
  }
  if (fill.state === "undone") {
    return (
      <ProblemLine
        testId="meeting-fill-line"
        role="status"
        className=""
        action={again(t(words.again))}
      >
        {t(words.undone)}
      </ProblemLine>
    );
  }
  return (
    <ProblemLine
      testId="meeting-fill-line"
      role="alert"
      className=""
      title={fill.problem?.kind === "model" ? fill.problem.message : undefined}
      action={again(t("meetings.fill.tryAgain"))}
    >
      {t(words.failed, { reason: reasonOf(fill.problem) })}
    </ProblemLine>
  );
}
