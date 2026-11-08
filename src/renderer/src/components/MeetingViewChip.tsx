import { useEffect, useId, useRef } from "react";
import type { Meeting } from "../../../core/api";
import { captureLines } from "../captureHealth";
import { commands } from "../commands/registry";
import { useLanguage, useT } from "../i18n";
import { currentTabOf } from "../layoutSlice";
import { canKeepAudio, useAudioSaid } from "../meetingAudioWords";
import { useMeetings } from "../meetings";
import { clockTime } from "../meetingTime";
import {
  type MeetingNoteView,
  meetingViewsOf,
  showMeetingNoteView,
  useMeetingNoteView,
  useMeetingNoteViews,
} from "../meetingViews";
import { useRequests } from "../requests";
import { useAppStore } from "../store";
import { takeFirstShow } from "../tips";
import {
  CheckLineIcon,
  ChevronDownLineIcon,
  ChevronRightLineIcon,
  PulseLineIcon,
} from "./lineIcons";
import { ProblemMark } from "./ProblemLine";
import { menuFrameClass, menuItemClass, menuRuleClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

const LABELS = {
  notes: "meetings.views.notes",
  mine: "meetings.views.mine",
  transcript: "meetings.views.transcript",
} as const satisfies Record<MeetingNoteView, string>;

/** Two tabs of one Note have a chip each: the popover opens by itself in one. */
let shownForFill = false;

/**
 * A stopped call's one chip beside the page's ⋯ (#2527): "Recorded 1:01 ⌄", or the view it shows
 * ("Transcript ⌄"), so the way back is where the User looks. Its popover holds the views, the
 * audio's line with Delete now, which asks first, and the recording details at its foot. After
 * the first fill on this computer it opens by itself, once, so the audio's deletion date is seen
 * where it lives.
 */
export function MeetingViewChip({ meeting, tabId }: { meeting: Meeting; tabId: string }) {
  const t = useT();
  const view = useMeetingNoteView(tabId, meeting.mindId);
  const menu = usePopoverMenu({ align: "end" });
  const asked = useRequests((state) => state.deleteAudio?.meetingId === meeting.id);
  const hasTranscript = !!meeting.transcript?.documentId;
  const { show, close } = menu;

  const filled = meeting.fill?.state === "filled";
  const wasFilled = useRef(filled);
  useEffect(() => {
    const now = filled && !wasFilled.current;
    wasFilled.current = filled;
    if (now && !shownForFill && takeFirstShow("meeting-recorded")) {
      shownForFill = true;
      show({ quiet: true });
    }
  }, [filled, show]);

  // A problem line's Details opens them here, at the popover's foot.
  const detailsAsked = useMeetingNoteViews((state) =>
    state.details?.mindId === meeting.mindId ? state.details.at : null,
  );
  // A Note open in two groups has a chip in each: the one in the tab in front answers.
  const inFront = useAppStore((state) => currentTabOf(state.layout)?.id === tabId);
  const detailsHandled = useRef(detailsAsked);
  useEffect(() => {
    if (detailsAsked === null || detailsAsked === detailsHandled.current) return;
    detailsHandled.current = detailsAsked;
    if (!inFront) return;
    useMeetings.getState().showDetails(meeting.id, true);
    show();
  }, [detailsAsked, inFront, meeting.id, show]);

  // "Delete audio" from ⌘K asks here, where the audio's line is.
  const askedHere = useRef(false);
  useEffect(() => {
    if (!asked || !inFront) return;
    askedHere.current = true;
    show({ quiet: true });
  }, [asked, inFront, show]);
  // Closed with the question open, the audio is kept, as Keep it does.
  const wasOpen = useRef(menu.open);
  useEffect(() => {
    const closed = wasOpen.current && !menu.open;
    wasOpen.current = menu.open;
    if (!closed || !askedHere.current) return;
    askedHere.current = false;
    if (useRequests.getState().deleteAudio?.meetingId === meeting.id) {
      useRequests.getState().clear("deleteAudio");
    }
  }, [menu.open, meeting.id]);

  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="meeting-view-chip"
        className="inline-flex h-7 min-w-0 items-center gap-1 rounded-sm px-2 text-[12px] leading-5 text-ink-meta hover:bg-chip hover:text-ink"
      >
        <span className="truncate">
          {view === "notes"
            ? t("meetings.audio.recorded", { time: clockTime(meeting.recordedMs) })
            : t(LABELS[view])}
        </span>
        <ChevronDownLineIcon className="size-3 shrink-0" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("meetings.views.label")}
        data-testid="meeting-view-menu"
        className={`${menuFrameClass} w-72 max-w-[calc(100vw-16px)]`}
      >
        {meetingViewsOf(meeting)
          .filter((choice) => choice !== "transcript" || hasTranscript)
          .map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={view === choice}
              data-testid={`meeting-view-${choice}`}
              className={`${menuItemClass} pl-2`}
              onClick={() => {
                close();
                showMeetingNoteView(tabId, meeting.mindId, choice, { focus: true });
              }}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {view === choice && <CheckLineIcon className="size-4" />}
              </span>
              {t(LABELS[choice])}
            </button>
          ))}
        <hr className={menuRuleClass} />
        <AudioRow meeting={meeting} asked={asked} open={menu.open} />
        <hr className={menuRuleClass} />
        <DetailsRow meeting={meeting} />
      </div>
    </>
  );
}

/**
 * "Audio kept until 12:54 tomorrow · Keep audio · Delete now", "Audio kept · Delete now" or "Audio
 * deleted on 14 Oct" (#687). Keep audio and Delete now are the commands of ⌘K, and Delete now asks
 * first on the same line, because it can't be undone.
 */
function AudioRow({ meeting, asked, open }: { meeting: Meeting; asked: boolean; open: boolean }) {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const { audio } = meeting;
  const asking = asked && audio.kept;
  const said = useAudioSaid(meeting, t, language);
  const problem = useMeetings((state) => state.audioProblems[meeting.id]);
  const confirm = useRef<HTMLButtonElement>(null);
  // The User just asked to delete: the choice takes the focus, once the popover shows.
  useEffect(() => {
    if (asking && open) confirm.current?.focus();
  }, [asking, open]);
  const keep = () => useRequests.getState().clear("deleteAudio");
  if (asking) {
    return (
      <fieldset
        aria-labelledby={id}
        data-testid="meeting-audio-confirm"
        className="m-0 border-0 p-0"
      >
        <p id={id} className="py-1 pr-2 pl-8 text-[13px] leading-5 text-ink-meta">
          {t("meetings.audio.confirm")}
        </p>
        <button
          type="button"
          role="menuitem"
          ref={confirm}
          data-testid="meeting-audio-delete-confirm"
          onClick={() => {
            keep();
            void useMeetings.getState().deleteAudio(meeting.id);
          }}
          className={`${menuItemClass} pl-8 font-semibold`}
        >
          {t("meetings.audio.deleteConfirm")}
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="meeting-audio-keep"
          onClick={keep}
          className={`${menuItemClass} pl-8`}
        >
          {t("meetings.audio.keep")}
        </button>
      </fieldset>
    );
  }
  return (
    <fieldset aria-labelledby={id} data-testid="meeting-audio" className="m-0 border-0 p-0">
      <p
        id={id}
        data-gone={audio.kept ? undefined : ""}
        className="py-1 pr-2 pl-8 text-[13px] leading-5 text-ink-meta"
      >
        {said}
      </p>
      {/* Until the sweep that tries again has deleted it. */}
      {problem && audio.kept && (
        <p
          role="alert"
          data-testid="meeting-audio-problem"
          className="py-1 pr-2 pl-8 text-[13px] leading-5 text-ink"
        >
          <ProblemMark />
          {problem}
        </p>
      )}
      {canKeepAudio(meeting) && (
        <button
          type="button"
          role="menuitem"
          data-testid="meeting-audio-keep-for-good"
          onClick={() =>
            void commands.run("meeting.keepAudio", {
              focus: { kind: "mind", id: meeting.mindId },
            })
          }
          className={`${menuItemClass} pl-8`}
        >
          {t("meetings.audio.keepAudio")}
        </button>
      )}
      {audio.kept && (
        <button
          type="button"
          role="menuitem"
          data-testid="meeting-audio-delete"
          onClick={() =>
            void commands.run("meeting.deleteAudio", {
              focus: { kind: "mind", id: meeting.mindId },
            })
          }
          className={`${menuItemClass} pl-8`}
        >
          {t("meetings.audio.deleteNow")}
        </button>
      )}
    </fieldset>
  );
}

/** "Recording details" (#161), at the popover's foot, opening the details under it. */
function DetailsRow({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const id = useId();
  const shown = useMeetings((state) => state.detailsShown[meeting.id] ?? false);
  const Chevron = shown ? ChevronDownLineIcon : ChevronRightLineIcon;
  return (
    <>
      <button
        type="button"
        role="menuitem"
        data-testid="meeting-details-toggle"
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => useMeetings.getState().showDetails(meeting.id)}
        className={`${menuItemClass} pl-2 text-ink-meta`}
      >
        <PulseLineIcon className="size-3.5 shrink-0" />
        <span className="flex-1">{t("meetings.health.label")}</span>
        <Chevron className="size-3.5 shrink-0" />
      </button>
      {shown && (
        <ul
          id={id}
          data-testid="meeting-details"
          aria-label={t("meetings.health.label")}
          className="m-0 list-none px-2 pb-1"
        >
          {captureLines(meeting, t).map((line) => (
            <li
              key={line.key}
              data-testid="meeting-details-line"
              className="flex gap-2 py-0.5 text-[12px] leading-5 text-ink-meta"
            >
              <span className="w-10 shrink-0 tabular-nums">
                {line.atMs === null ? "" : clockTime(line.atMs)}
              </span>
              <span className="min-w-0">{line.text}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
