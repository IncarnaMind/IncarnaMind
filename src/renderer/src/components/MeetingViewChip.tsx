import type { Meeting } from "../../../core/api";
import { useT } from "../i18n";
import { clockTime } from "../meetingTime";
import { showMeetingNoteView, useMeetingNoteView } from "../meetingViews";
import { CheckLineIcon, ChevronDownLineIcon } from "./lineIcons";
import { menuFrameClass, menuItemClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

export function MeetingViewChip({ meeting, tabId }: { meeting: Meeting; tabId: string }) {
  const t = useT();
  const view = useMeetingNoteView(tabId, meeting.mindId);
  const menu = usePopoverMenu({ align: "end" });
  const label = t("meetings.views.label");
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="meeting-view-chip"
        aria-label={label}
        title={label}
        className="inline-flex h-7 min-w-0 items-center gap-1 rounded-sm px-2 text-[12px] leading-5 text-ink-meta hover:bg-chip hover:text-ink"
      >
        <span className="truncate">
          {view === "transcript"
            ? t("meetings.views.transcript")
            : t("meetings.audio.recorded", { time: clockTime(meeting.recordedMs) })}
        </span>
        <ChevronDownLineIcon className="size-3 shrink-0" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={label}
        className={`${menuFrameClass} min-w-40`}
      >
        {(["notes", "transcript"] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            role="menuitemradio"
            aria-checked={view === choice}
            data-testid={`meeting-view-${choice}`}
            className={`${menuItemClass} pl-2`}
            onClick={() => {
              menu.close();
              showMeetingNoteView(tabId, meeting.mindId, choice);
              menu.buttonProps.ref.current?.focus();
            }}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {view === choice && <CheckLineIcon className="size-4" />}
            </span>
            {t(choice === "notes" ? "meetings.views.notes" : "meetings.views.transcript")}
          </button>
        ))}
      </div>
    </>
  );
}
