import type { CalendarEvent } from "../../../../core/api";
import { andList } from "../../../../shared/i18n";
import { calendarsOffered, useCalendars } from "../../calendars";
import { comingUpRows, initialsOf, othersOn, rowTime } from "../../calendarWords";
import { takeNotes, useComingUp } from "../../comingUp";
import { useLanguage, useT } from "../../i18n";
import { ConnectCalendarMenu } from "../meetings/ConnectCalendarMenu";
import { LineAction, ProblemLine } from "../ProblemLine";
import { buttonStyle } from "../ui";

const INITIALS_SHOWN = 3;

/**
 * Home's Coming up (#190), as the prototype has it: today's and tomorrow's Meetings from the
 * connected calendars, each with Take notes; with none, a line that says so and, while no
 * calendar is connected, Connect a calendar. A copy that can connect none, with none, shows nothing.
 */
export function ComingUp({ now }: { now: Date }) {
  const t = useT();
  const meetings = useComingUp((state) => state.meetings);
  const calendars = useCalendars((state) => state.calendars);
  const problems = useCalendars((state) => state.problems);
  const rows = comingUpRows(meetings, now);
  if (rows.length === 0 && !calendarsOffered(calendars)) return null;
  const unconnected =
    calendars?.services.filter((service) =>
      calendars.accounts.every((account) => account.service !== service),
    ) ?? [];
  const connectable = calendars?.accounts.length === 0 && unconnected.length > 0;
  const shownProblems = Object.values(problems);

  return (
    <section data-testid="home-coming-up" className="mb-7">
      <h2 className="mb-1.5 text-label font-semibold text-ink-meta">{t("home.comingUp")}</h2>
      {rows.length > 0 ? (
        <ul className="grid grid-cols-[max-content_minmax(0,1fr)_auto_auto] border-t border-rule">
          {rows.map((meeting) => (
            <MeetingRow key={meeting.id} meeting={meeting} now={now} />
          ))}
        </ul>
      ) : (
        <div data-testid="home-coming-up-none" className="text-[13px] leading-5 text-ink-meta">
          {t("comingUp.none")}
          {connectable && (
            <>
              <span aria-hidden="true"> · </span>
              <ConnectCalendarMenu
                services={unconnected}
                className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("comingUp.connect")}
              </ConnectCalendarMenu>
            </>
          )}
        </div>
      )}
      {calendars?.signingIn && (
        <p
          role="status"
          data-testid="calendar-signing-in"
          className="mt-1.5 text-[13px] leading-5 text-ink-meta"
        >
          {t("calendars.signingIn")}
          <span aria-hidden="true"> · </span>
          <LineAction
            action={{
              label: t("calendars.cancel"),
              testId: "calendar-sign-in-cancel",
              onClick: () => void useCalendars.getState().cancelSignIn(),
            }}
          />
        </p>
      )}
      {shownProblems.map((problem) => (
        <ProblemLine key={problem} testId="calendar-connect-problem" className="mt-1.5">
          {problem}
        </ProblemLine>
      ))}
    </section>
  );
}

function MeetingRow({ meeting, now }: { meeting: CalendarEvent; now: Date }) {
  const t = useT();
  const language = useLanguage();
  const others = othersOn(meeting.attendees);
  return (
    <li
      data-testid="home-meeting"
      data-event-id={meeting.id}
      className="col-span-full grid h-11 grid-cols-subgrid items-center gap-3 border-b border-rule"
    >
      <span
        data-testid="home-meeting-time"
        className="text-[13px] whitespace-nowrap text-ink-meta tabular-nums"
      >
        {rowTime(meeting, now, language, t)}
      </span>
      <span
        data-testid="home-meeting-title"
        title={meeting.title}
        className="min-w-0 truncate font-semibold text-ink"
      >
        {meeting.title}
      </span>
      <span
        data-testid="home-meeting-people"
        className="flex justify-end"
        title={
          others.length > 0
            ? t("comingUp.attendees", {
                names: andList(
                  language,
                  others.map((each) => each.name),
                ),
              })
            : undefined
        }
      >
        {others.slice(0, INITIALS_SHOWN).map((attendee, at) => (
          <span
            key={attendee.email ?? attendee.name}
            aria-hidden="true"
            className={`inline-flex size-6 items-center justify-center rounded-full bg-chip text-[10px] leading-none font-semibold text-ink-secondary ring-2 ring-sheet ${at > 0 ? "-ml-1" : ""}`}
          >
            {initialsOf(attendee.name)}
          </span>
        ))}
      </span>
      <button
        type="button"
        data-testid="home-take-notes"
        aria-label={t("comingUp.takeNotes.label", { title: meeting.title })}
        onClick={() => void takeNotes(meeting)}
        className={buttonStyle("secondary", "sm")}
      >
        {t("comingUp.takeNotes")}
      </button>
    </li>
  );
}
