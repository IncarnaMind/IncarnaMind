import type { MouseEvent } from "react";
import type { Meeting } from "../../../../core/api";
import { shortcutLabel } from "../../commands/keymap";
import { useT } from "../../i18n";
import {
  type MeetingNoteView,
  meetingViewsOf,
  showMeetingNoteView,
  useMeetingNoteView,
} from "../../meetingViews";
import { segmentClass, segmentedClass } from "../ui";
import { LevelBars } from "./LevelBars";

const LABELS = {
  notes: "meetings.views.notes",
  mine: "meetings.views.mine",
  transcript: "meetings.views.transcript",
} as const satisfies Record<MeetingNoteView, string>;

/**
 * Notes | Transcript (笔记 | 转写稿) in the recording bar: the meeting's page shows one or the
 * other in place, and the Transcript carries the level bars. A click, ⌥⌘← and ⌥⌘→ take the
 * User to the view; the switcher's own arrow keys leave the focus in it.
 */
export function ViewSwitch({ meeting, tabId }: { meeting: Meeting; tabId: string }) {
  const t = useT();
  const view = useMeetingNoteView(tabId, meeting.mindId);
  const keys = `${shortcutLabel("meeting.previousView")} ${shortcutLabel("meeting.nextView")}`;
  const name = `meeting-views-${tabId}`;
  const choose = (choice: MeetingNoteView, event: MouseEvent) =>
    // A radio's arrow keys click it too, with no pointer: detail 0.
    showMeetingNoteView(tabId, meeting.mindId, choice, { focus: event.detail > 0 });
  return (
    <div
      role="radiogroup"
      data-testid="meeting-views"
      aria-label={t("meetings.views.label")}
      title={t("meetings.views.switch", { keys })}
      className={`${segmentedClass} meeting-views`}
    >
      {meetingViewsOf(meeting).map((choice) => (
        <label key={choice} className={`${segmentClass} meeting-view`}>
          <input
            type="radio"
            name={name}
            value={choice}
            data-testid={`meeting-view-${choice}`}
            checked={view === choice}
            onChange={() => undefined}
            onClick={(event) => choose(choice, event)}
            className="sr-only"
          />
          {t(LABELS[choice])}
          {choice === "transcript" && <LevelBars meeting={meeting} />}
        </label>
      ))}
    </div>
  );
}
