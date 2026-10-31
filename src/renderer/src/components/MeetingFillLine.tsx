import type { Meeting, MeetingFillProblem } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { useT } from "../i18n";
import { useMeetings } from "../meetings";
import { type ProblemAction, ProblemLine } from "./ProblemLine";

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
 * waiting for the Transcript, filling in (on this computer, where it is), "Notes filled in ·
 * Undo", or why they weren't, with Try again. A voice memo's says its note was written, or that
 * its Transcript went in as it is, and why.
 */
export function MeetingFillLine({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const { fill } = meeting;
  if (!fill || (fill.state === "off" && !fill.problem)) return null;
  const words = WORDS[meeting.kind];
  const again = (label: string): ProblemAction => ({
    label,
    testId: "meeting-fill-again",
    onClick: () => void useMeetings.getState().fillNotes(meeting.id),
  });
  // Said in the interface's words now; a model's own words show on hover.
  const reasonOf = (problem: MeetingFillProblem | null) =>
    t(
      meeting.kind === "memo" && problem?.kind === "not-allowed"
        ? "memos.fill.problem.notAllowed"
        : REASONS[problem?.kind ?? "model"],
      { service: problem?.service ?? "" },
    );

  if (fill.state === "waiting" || fill.state === "filling") {
    const text =
      fill.state === "waiting"
        ? t(words.waiting)
        : t(fill.local ? words.fillingLocal : words.filling);
    return (
      <ProblemLine testId="meeting-fill-line" role="status" className="">
        {text}
      </ProblemLine>
    );
  }
  if (fill.state === "filled") {
    return (
      <ProblemLine
        testId="meeting-fill-line"
        role="status"
        className=""
        action={{
          label: t("meetings.fill.undo"),
          testId: "meeting-fill-undo",
          onClick: () => void useMeetings.getState().undoFill(meeting.id),
        }}
      >
        {fill.mode === "transcript"
          ? t("memos.fill.asIs", { reason: reasonOf(fill.problem) })
          : t(words.filled)}
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
