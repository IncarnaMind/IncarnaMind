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
} as const satisfies Record<MeetingFillProblem["kind"], MessageKey>;

/**
 * Where filling the notes in from the Transcript is (#142), one line under a stopped Meeting:
 * waiting for the Transcript, filling in (on this computer, where it is), "Notes filled in ·
 * Undo", or why they weren't, with Try again.
 */
export function MeetingFillLine({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const { fill } = meeting;
  if (!fill) return null;
  const again = (label: string): ProblemAction => ({
    label,
    testId: "meeting-fill-again",
    onClick: () => void useMeetings.getState().fillNotes(meeting.id),
  });
  // Said in the interface's words now; a model's own words show on hover.
  const reasonOf = (problem: MeetingFillProblem | null) =>
    t(REASONS[problem?.kind ?? "model"], { service: problem?.service ?? "" });

  if (fill.state === "waiting" || fill.state === "filling") {
    const text =
      fill.state === "waiting"
        ? t("meetings.fill.waiting")
        : t(fill.local ? "meetings.fill.fillingLocal" : "meetings.fill.filling");
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
        {t("meetings.fill.filled")}
      </ProblemLine>
    );
  }
  if (fill.state === "undone") {
    return (
      <ProblemLine
        testId="meeting-fill-line"
        role="status"
        className=""
        action={again(t("meetings.fill.again"))}
      >
        {t("meetings.fill.undone")}
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
      {t("meetings.fill.failed", { reason: reasonOf(fill.problem) })}
    </ProblemLine>
  );
}
