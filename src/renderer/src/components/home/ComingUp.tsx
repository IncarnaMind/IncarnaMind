import { formatDateTime } from "../../../../shared/dates";
import { useComingUp } from "../../comingUp";
import { useLanguage, useT } from "../../i18n";

const SHOWN = 4;

export function ComingUp({ now }: { now: Date }) {
  const t = useT();
  const language = useLanguage();
  const meetings = useComingUp((state) => state.meetings);
  if (meetings.length === 0) return null;
  return (
    <section data-testid="home-coming-up" className="mb-7">
      <h2 className="mb-1.5 text-label font-semibold text-ink-meta">{t("home.comingUp")}</h2>
      <ul className="border-t border-rule">
        {meetings.slice(0, SHOWN).map((meeting) => (
          <li
            key={meeting.id}
            data-testid="home-meeting"
            className="flex h-11 items-center gap-3 border-b border-rule"
          >
            <span
              data-testid="home-meeting-time"
              className="w-28 shrink-0 text-[13px] whitespace-nowrap text-ink-secondary tabular-nums"
            >
              {formatDateTime(meeting.start, language, { now })}
            </span>
            <span title={meeting.title} className="min-w-0 flex-1 truncate font-semibold text-ink">
              {meeting.title}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
