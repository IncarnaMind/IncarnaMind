import type { Meeting } from "../../../core/api";
import { captureLines, unsavedAudioMs } from "../captureHealth";
import { useT } from "../i18n";
import { useMeetings } from "../meetings";
import { clockTime, durationLabel } from "../meetingTime";
import { ChevronDownLineIcon, ChevronRightLineIcon, PulseLineIcon } from "./lineIcons";
import { ProblemLine } from "./ProblemLine";

/*
 * A Meeting's recording details (#161): how well its capture went, quiet
 * until asked for, as a call's health is behind a button in Teams. While it
 * records, the meeting bar's pulse button shows them; once it has stopped, a
 * "Recording details" line under it. Only audio that couldn't be saved has a
 * problem line of its own: the rest is already said where it happens, or
 * needs nothing from the User.
 */

const detailsId = (meeting: Meeting) => `recording-details-${meeting.id}`;

const useShown = (meeting: Meeting) =>
  useMeetings((state) => state.detailsShown[meeting.id] ?? false);

/** The meeting bar's button for the recording details. */
export function CaptureDetailsToggle({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const shown = useShown(meeting);
  const label = t(shown ? "meetings.health.hide" : "meetings.health.show");
  return (
    <button
      type="button"
      data-testid="meeting-details-toggle"
      data-fold="details"
      aria-expanded={shown}
      aria-controls={detailsId(meeting)}
      aria-label={label}
      title={label}
      onClick={() => useMeetings.getState().showDetails(meeting.id)}
      className="meeting-button meeting-button--icon"
    >
      <PulseLineIcon className="size-3.5" />
    </button>
  );
}

/** "Recording details", under a stopped Meeting, with its chevron. */
export function CaptureDetailsLine({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const shown = useShown(meeting);
  const Chevron = shown ? ChevronDownLineIcon : ChevronRightLineIcon;
  return (
    <button
      type="button"
      data-testid="meeting-details-toggle"
      aria-expanded={shown}
      aria-controls={detailsId(meeting)}
      onClick={() => useMeetings.getState().showDetails(meeting.id)}
      className="capture-details-line"
    >
      <Chevron className="size-3.5" />
      {t("meetings.health.label")}
    </button>
  );
}

/** The recording details themselves, while shown. */
export function CaptureDetails({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const shown = useShown(meeting);
  if (!shown) return null;
  return (
    <ul
      id={detailsId(meeting)}
      data-testid="meeting-details"
      aria-label={t("meetings.health.label")}
      className="capture-details"
    >
      {captureLines(meeting, t).map((line) => (
        <li key={line.key} data-testid="meeting-details-line">
          <span className="capture-details-time">
            {line.atMs === null ? "" : clockTime(line.atMs)}
          </span>
          <span className="min-w-0">{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Audio that couldn't be saved, once the line saying so while it happened has gone. */
export function CaptureProblem({ meeting, className }: { meeting: Meeting; className?: string }) {
  const t = useT();
  const shown = useShown(meeting);
  const unsaved = unsavedAudioMs(meeting);
  if (unsaved === 0) return null;
  return (
    <ProblemLine
      role="status"
      testId="meeting-line-unsaved"
      className={className}
      action={
        shown
          ? undefined
          : {
              label: t("meetings.health.details"),
              testId: "meeting-line-details",
              onClick: () => useMeetings.getState().showDetails(meeting.id, true),
            }
      }
    >
      {t("meetings.health.unsaved", { duration: durationLabel(Math.max(unsaved, 1000), t) })}
    </ProblemLine>
  );
}
