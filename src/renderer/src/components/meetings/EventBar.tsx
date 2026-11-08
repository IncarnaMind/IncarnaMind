import { andList } from "../../../../shared/i18n";
import { othersOn, startsIn, whenLine } from "../../calendarWords";
import { useLanguage, useT } from "../../i18n";
import { useMeetingOf, useMeetings } from "../../meetings";
import { useMinuteClock } from "../../minuteClock";
import { useNoteEvent } from "../../noteEvents";
import { CalendarLineIcon, RecordingLineIcon } from "../lineIcons";
import { buttonStyle } from "../ui";

/**
 * A calendar meeting's Note before its call (#190), as the prototype's bar has it: when it is and
 * who is in it, Join and record (Record when the invite has no link), and how soon it starts.
 * Above the page, never in it: the page stays the User's. Once the Note has a Meeting, the
 * Meeting's own start and bar take over.
 */
export function EventBar({ mindId }: { mindId: string }) {
  const t = useT();
  const language = useLanguage();
  const event = useNoteEvent(mindId);
  const meeting = useMeetingOf(mindId);
  const now = useMinuteClock();
  if (!event || meeting) return null;
  const soon = startsIn(event, now, t);
  const people = andList(
    language,
    othersOn(event.attendees).map((attendee) => attendee.name),
  );
  const join = () => {
    if (event.joinUrl) window.open(event.joinUrl, "_blank", "noopener");
    void useMeetings.getState().recordIn(mindId);
  };
  return (
    <section data-testid="event-bar" aria-label={t("eventBar.label")} className="meeting-bar">
      <div className="flex h-8 items-center gap-2">
        <CalendarLineIcon className="size-4 shrink-0 text-ink-meta" />
        <span
          data-testid="event-bar-when"
          title={people || undefined}
          className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink-secondary"
        >
          {whenLine(event, now, language, t)}
        </span>
        {soon && (
          <span
            data-testid="event-bar-soon"
            className="shrink-0 text-[13px] leading-5 whitespace-nowrap text-ink-meta tabular-nums"
          >
            {soon}
          </span>
        )}
        <button
          type="button"
          data-testid="event-bar-record"
          title={event.joinUrl ? t("eventBar.joinTip") : undefined}
          onClick={join}
          className={buttonStyle(event.joinUrl ? "primary" : "secondary", "sm")}
        >
          <RecordingLineIcon className="size-4" />
          {t(event.joinUrl ? "eventBar.join" : "eventBar.record")}
        </button>
      </div>
    </section>
  );
}
