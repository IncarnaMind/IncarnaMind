import { isMacOS } from "@tiptap/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import type { Meeting } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { shortcutLabel } from "../../commands/keymap";
import { commands } from "../../commands/registry";
import { useT } from "../../i18n";
import { isLive, useMeetingOf, useMeetings, useMeetingTime } from "../../meetings";
import { clockTime } from "../../meetingTime";
import { askInNote, setColumnOpen } from "../../ownAiInNote";
import { useAppStore, type ViewerTarget } from "../../store";
import { openTranscriptBeside } from "../../transcripts";
import { TranscriptHeadLine } from "../../viewer/TranscriptHeadLine";
import { MeetingTranscriptView } from "../../viewer/TranscriptView";
import { type ViewerFrame, ViewerFrameContext } from "../../viewer/ViewerHeader";
import { CaptureDetails, CaptureDetailsToggle } from "../CaptureDetails";
import {
  BookmarkLineIcon,
  ChevronDownLineIcon,
  CloseLineIcon,
  MicLineIcon,
  MicOffLineIcon,
  MoreLineIcon,
  OpenBesideLineIcon,
  PauseLineIcon,
  ResumeLineIcon,
  ScreenLineIcon,
  StopLineIcon,
} from "../lineIcons";
import { CallHelpToggle, MeetingLines } from "../MeetingBar";
import { MeetingAudioLine } from "../MeetingInMind";
import { ProblemLine } from "../ProblemLine";
import { SharedScreenLine } from "../SharedScreenLine";
import { TipPopover } from "../TipPopover";
import { useTabPlace } from "../tabs/tabItems";
import { buttonStyle, menuFrameClass, menuItemClass, menuRuleClass, menuTitleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import { useTip } from "../useTip";
import { LevelBars, levelName } from "./LevelBars";
import { applyMeetingWriteupTemplate, MeetingTemplateRows } from "./MeetingTemplatePicker";

/**
 * Whether a meeting Note's Transcript sheet is up, per Note, and the words a Citation asked it to
 * show. `refocus` counts each fold that gives the focus back to the control's chevron.
 */
const useSheets = create<{
  open: Record<string, boolean>;
  tipSeen: boolean;
  quote: string;
  refocus: Record<string, number>;
}>(() => ({ open: {}, tipSeen: false, quote: "", refocus: {} }));
const setSheet = (mindId: string, open: boolean) =>
  useSheets.setState((state) => ({
    open: { ...state.open, [mindId]: open },
    tipSeen: true,
    quote: open ? state.quote : "",
  }));
/** Folds the sheet from inside it (Esc, Hide): the focus goes back to the chevron it rose from. */
const foldSheet = (mindId: string) =>
  useSheets.setState((state) => ({
    open: { ...state.open, [mindId]: false },
    quote: "",
    refocus: { ...state.refocus, [mindId]: (state.refocus[mindId] ?? 0) + 1 },
  }));
export const useSheetOpen = (mindId: string) => useSheets((state) => state.open[mindId] === true);

/**
 * A Citation of the meeting's Transcript in a reply, pressed: the Transcript rises over the Note
 * at the words said, which are washed as a found quote is. False when no meeting is there to show.
 */
export function showQuoteInTranscript(quote: string): boolean {
  const { meetings } = useMeetings.getState();
  const meeting = meetings.find((each) => isLive(each)) ?? meetings.find((each) => each.transcript);
  if (!meeting) return false;
  // Opened upward the conversation would lie over the sheet; in the window's column it stays beside.
  if (!document.querySelector('[data-testid="note-column"]')) setColumnOpen(meeting.mindId, false);
  useSheets.setState((state) => ({
    open: { ...state.open, [meeting.mindId]: true },
    tipSeen: true,
    quote,
  }));
  return true;
}

/** Whether the meeting's control stands at the Note's foot: from the first second on, as the meeting's one place. */
export function useMeetingFootShown(mindId: string): boolean {
  const meeting = useMeetingOf(mindId);
  return !!meeting && meeting.kind === "meeting" && meeting.status !== "ready";
}

const MICROPHONE_PROBLEMS: Partial<Record<Meeting["sources"]["microphone"], MessageKey>> = {
  denied: "meetings.foot.micDenied",
  silent: "meetings.foot.micSilent",
  unavailable: "meetings.foot.micMissing",
  ended: "meetings.foot.micEnded",
};

/**
 * The meeting's one control at the Note's foot, left of the Note's input (#3762): the live dot,
 * the time and the level bars, which open the Transcript over the Note, and Stop. After Stop, the
 * time it ran and Resume, with Write notes above.
 */
export function MeetingFoot({ mindId }: { mindId: string }) {
  const meeting = useMeetingOf(mindId);
  return meeting ? <Foot mindId={mindId} meeting={meeting} /> : null;
}

function Foot({ mindId, meeting }: { mindId: string; meeting: Meeting }) {
  const t = useT();
  const open = useSheetOpen(mindId);
  const tipSeen = useSheets((state) => state.tipSeen);
  const refocus = useSheets((state) => state.refocus[mindId] ?? 0);
  const [asked, setAsked] = useState(false);
  const live = isLive(meeting);
  const paused = meeting.status === "paused";
  const { stop, resume, openSettings } = useMeetings.getState();
  const keys = shortcutLabel("meeting.nextView");
  const micProblem = live ? MICROPHONE_PROBLEMS[meeting.sources.microphone] : undefined;
  const writeNotes = async () => {
    setAsked(true);
    setSheet(mindId, false);
    try {
      await askInNote(mindId, {
        words: t("meetings.foot.writeNotesRequest"),
        quote: "",
        selection: null,
        caret: "",
      });
    } catch (error) {
      setAsked(false);
      useAppStore.getState().reportError(error);
    }
  };
  return (
    <div className="meeting-foot-stack">
      <div className="meeting-foot-over">
        {micProblem && (
          <div data-testid="meeting-foot-problem" className="meeting-foot-tip meeting-foot-problem">
            <ProblemLine
              role="alert"
              testId="meeting-foot-problem-line"
              action={{
                label: t(
                  isMacOS() ? "meetings.line.openSettings.mac" : "meetings.line.openSettings.other",
                ),
                testId: "meeting-foot-problem-settings",
                onClick: () => void openSettings(meeting.id, "microphone"),
              }}
            >
              {t(micProblem)}
            </ProblemLine>
          </div>
        )}
        {live && !tipSeen && !micProblem && (
          <div role="status" data-testid="meeting-foot-tip" className="meeting-foot-tip">
            <span>{t("meetings.foot.tip")}</span>
            <button
              type="button"
              data-testid="meeting-foot-tip-close"
              aria-label={t("meetings.foot.tipClose")}
              title={t("meetings.foot.tipClose")}
              onClick={() => useSheets.setState({ tipSeen: true })}
              className="meeting-foot-tip-close"
            >
              <CloseLineIcon className="size-4" />
            </button>
          </div>
        )}
        {!open && <SharedScreenLine meeting={meeting} />}
      </div>
      {!live && !asked && meeting.fill?.state === "own-ai" && (
        <button
          type="button"
          data-testid="meeting-write-notes"
          onClick={() => void writeNotes()}
          className={`${buttonStyle("primary")} meeting-write-notes`}
        >
          {t("meetings.foot.writeNotes")}
        </button>
      )}
      <fieldset
        data-testid="meeting-foot"
        data-status={meeting.status}
        aria-label={t("meetings.bar.label")}
        className="meeting-foot"
      >
        {live ? (
          <>
            {paused ? (
              <SlotButton
                testId="meeting-foot-resume-recording"
                tip={t("meetings.command.resume")}
                onClick={() => void resume(meeting.id)}
              >
                <ResumeLineIcon className="size-4" />
              </SlotButton>
            ) : (
              <SlotLevel tip={t(levelName(meeting))}>
                <LevelBars meeting={meeting} />
              </SlotLevel>
            )}
            <SlotButton
              testId="meeting-foot-transcript"
              expanded={open}
              focusOn={refocus}
              tip={t(open ? "meetings.foot.hide" : "meetings.foot.show", { keys })}
              onClick={() => setSheet(mindId, !open)}
            >
              <ChevronDownLineIcon className={`size-4 ${open ? "" : "rotate-180"}`} />
            </SlotButton>
            <SlotButton
              testId="meeting-foot-stop"
              tip={t("meetings.bar.stopLabel")}
              onClick={() => void stop(meeting.id)}
            >
              <StopLineIcon className="size-4" />
            </SlotButton>
          </>
        ) : (
          <SlotButton
            testId="meeting-foot-transcript"
            wide
            expanded={open}
            focusOn={refocus}
            tip={t(open ? "meetings.foot.hide" : "meetings.foot.show", { keys })}
            onClick={() => setSheet(mindId, !open)}
          >
            <span>{t("meetings.views.transcript")}</span>
            <ChevronDownLineIcon className={`size-4 ${open ? "" : "rotate-180"}`} />
          </SlotButton>
        )}
      </fieldset>
    </div>
  );
}

/**
 * The level bars' slot. Not a control, so no Tab stop: the bars give a screen reader their name,
 * and the pointer gets it as their title.
 */
function SlotLevel({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <span data-testid="meeting-foot-level" title={tip} className="meeting-foot-slot">
      {children}
    </span>
  );
}

/** One of the control's icon slots: its name is its tooltip and its accessible name. */
function SlotButton({
  testId,
  tip,
  expanded,
  wide = false,
  focusOn = 0,
  onClick,
  children,
}: {
  testId: string;
  tip: string;
  expanded?: boolean;
  wide?: boolean;
  /** Each time it grows past 0, the button takes the focus. */
  focusOn?: number;
  onClick(): void;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const opened = useTip(trigger);
  useEffect(() => {
    if (focusOn > 0) trigger.current?.focus();
  }, [focusOn]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid={testId}
        aria-label={tip}
        aria-expanded={expanded}
        onClick={onClick}
        onFocus={opened.show}
        onBlur={opened.blur}
        onPointerMove={opened.point}
        onPointerLeave={opened.leave}
        className={`meeting-foot-slot ${wide ? "meeting-foot-slot--wide" : ""}`}
      >
        {children}
      </button>
      {opened.shown && trigger.current && (
        <TipPopover anchor={trigger.current} tip={opened}>
          {tip}
        </TipPopover>
      )}
    </>
  );
}

/**
 * The Transcript as a sheet over the Note, risen from the meeting's control, so the Note and its
 * input stay (#3762): its name, Open beside and Hide; one line to tell everyone; the words said;
 * and, at its foot, every control of the recording, each with its name.
 */
export function MeetingSheet({ mindId }: { mindId: string }) {
  const t = useT();
  const meeting = useMeetingOf(mindId);
  const open = useSheetOpen(mindId);
  const place = useTabPlace();
  const tabId = place?.tabId ?? "";
  const documentId = meeting?.transcript?.documentId;
  const file = useAppStore((state) => state.documents.find((each) => each.id === documentId));
  const target = useMemo<ViewerTarget>(
    () => ({ documentId: documentId ?? "", request: 0 }),
    [documentId],
  );
  const frame = useMemo<ViewerFrame>(
    () => ({
      document: file,
      tabId,
      target,
      embedded: true,
      preview: false,
      keep: () => undefined,
    }),
    [file, tabId, target],
  );
  const quote = useSheets((state) => state.quote);
  const detailsShown = useMeetings(
    (state) => meeting !== undefined && state.detailsShown[meeting.id] === true,
  );
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = body.current;
    if (!open || !root) return;
    for (const line of root.querySelectorAll("[data-cited]")) line.removeAttribute("data-cited");
    if (!quote) return;
    const start = quote.slice(0, 24);
    const wash = () => {
      const line = [...root.querySelectorAll<HTMLElement>('[data-testid="transcript-line"]')].find(
        (each) => (each.textContent ?? "").includes(start),
      );
      if (!line) return false;
      line.setAttribute("data-cited", "true");
      line.scrollIntoView({ block: "center" });
      return true;
    };
    if (wash()) return;
    // The lines arrive after the sheet opens: wash the cited one as it is drawn.
    const watch = new MutationObserver(() => {
      if (wash()) watch.disconnect();
    });
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  });
  useEffect(() => {
    if (!open) return;
    // Esc closes the innermost thing open: a menu or a dialog over the sheet takes it first.
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector("dialog:modal") !== null) return;
      event.preventDefault();
      foldSheet(mindId);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, mindId]);
  if (!meeting || !open) return null;
  const live = isLive(meeting);
  return (
    // On the text's measure, as the row under it is: the place is a column container as the page is.
    <div className="meeting-sheet-place">
      <div className="mind-measure">
        <section
          data-testid="meeting-sheet"
          data-live={live || undefined}
          aria-label={t("meetings.views.transcript")}
          className="meeting-sheet viewer-pane [container:viewer/inline-size]"
        >
          <header className="meeting-sheet-head">
            <h2 className="meeting-sheet-title">{t("meetings.views.transcript")}</h2>
            {live && <SheetTime meeting={meeting} />}
            <div className="ml-auto flex items-center gap-1">
              <CaptureDetailsToggle meeting={meeting} />
              <button
                type="button"
                data-testid="meeting-sheet-beside"
                disabled={!documentId}
                aria-label={t("meetings.views.besideCommand")}
                title={t("meetings.views.besideCommand")}
                onClick={() => {
                  setSheet(mindId, false);
                  openTranscriptBeside({ meeting, tabId, groupId: place?.groupId });
                }}
                className="meeting-sheet-icon"
              >
                <OpenBesideLineIcon className="size-4" />
              </button>
              <button
                type="button"
                data-testid="meeting-sheet-hide"
                aria-label={t("meetings.foot.hide", { keys: shortcutLabel("meeting.nextView") })}
                title={t("meetings.foot.hide", { keys: shortcutLabel("meeting.nextView") })}
                onClick={() => foldSheet(mindId)}
                className="meeting-sheet-icon"
              >
                <ChevronDownLineIcon className="size-4" />
              </button>
            </div>
          </header>
          {detailsShown && (
            <div data-testid="meeting-sheet-details" className="meeting-sheet-details">
              {!live && <MeetingAudioLine meeting={meeting} />}
              <CaptureDetails meeting={meeting} />
            </div>
          )}
          {live ? (
            <p className="meeting-sheet-consent">{t("meetings.foot.tell")}</p>
          ) : (
            <div className="meeting-sheet-consent">
              <TranscriptHeadLine
                playable={meeting.transcript?.state === "saved" && meeting.audio.kept && !!file}
              />
            </div>
          )}
          {live && <MeetingLines meeting={meeting} />}
          <div ref={body} className="meeting-sheet-body">
            <ViewerFrameContext.Provider value={frame}>
              <MeetingTranscriptView
                key={meeting.id}
                meeting={meeting}
                document={file}
                target={target}
                aside={null}
              />
            </ViewerFrameContext.Provider>
          </div>
          {live ? (
            <SheetFoot meeting={meeting} />
          ) : (
            <footer data-testid="meeting-sheet-foot" className="meeting-sheet-foot">
              <button
                type="button"
                data-testid="meeting-sheet-resume-meeting"
                aria-label={t("meetings.foot.resumeTip")}
                title={t("meetings.foot.resumeTip")}
                onClick={() => void useMeetings.getState().resume(meeting.id)}
                className="meeting-button meeting-button--words"
              >
                <ResumeLineIcon className="size-3.5" />
                <span>{t("meetings.foot.resume")}</span>
              </button>
              <button
                type="button"
                data-testid="meeting-sheet-review-speakers"
                // The review itself still opens where the Transcript view has it, at the top of the lines.
                onClick={() =>
                  body.current
                    ?.querySelector<HTMLButtonElement>(
                      ".transcript-review-row > button[aria-expanded]",
                    )
                    ?.click()
                }
                className="meeting-button meeting-button--words"
              >
                <span>{t("meetings.review.open")}</span>
              </button>
            </footer>
          )}
        </section>
      </div>
    </div>
  );
}

/** The time recorded, in the sheet's head while it records: the control holds no time (#3762). */
function SheetTime({ meeting }: { meeting: Meeting }) {
  const time = clockTime(useMeetingTime(meeting));
  return (
    <span data-testid="meeting-sheet-time" className="meeting-sheet-meta">
      <span aria-hidden="true" data-status={meeting.status} className="recording-dot" />
      <span role="timer">{time}</span>
    </span>
  );
}

function SheetFoot({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const { pause, resume, chooseScreen, setMicrophonePaused } = useMeetings.getState();
  const recording = meeting.status === "recording";
  const micPaused = meeting.microphonePausedAtMs !== null;
  const shortcut = shortcutLabel("meeting.pauseResume");
  const markShortcut = shortcutLabel("meeting.mark");
  return (
    <footer data-testid="meeting-sheet-foot" className="meeting-sheet-foot">
      <button
        type="button"
        data-testid="meeting-sheet-mic"
        aria-pressed={micPaused}
        aria-label={t(micPaused ? "meetings.mic.resume" : "meetings.mic.pause")}
        title={t(micPaused ? "meetings.mic.resume" : "meetings.mic.pauseTip")}
        onClick={() => void setMicrophonePaused(meeting.id, !micPaused)}
        className="meeting-button meeting-button--words"
      >
        {micPaused ? <MicOffLineIcon className="size-3.5" /> : <MicLineIcon className="size-3.5" />}
        <span>{t(micPaused ? "meetings.mic.resume" : "meetings.mic.pause")}</span>
      </button>
      <button
        type="button"
        data-testid={recording ? "meeting-sheet-pause" : "meeting-sheet-resume"}
        aria-label={t(recording ? "meetings.bar.pause" : "meetings.bar.resume", { shortcut })}
        title={t(recording ? "meetings.bar.pause" : "meetings.bar.resume", { shortcut })}
        onClick={() => void (recording ? pause(meeting.id) : resume(meeting.id))}
        className="meeting-button meeting-button--words"
      >
        {recording ? (
          <PauseLineIcon className="size-3.5" />
        ) : (
          <ResumeLineIcon className="size-3.5" />
        )}
        <span>{t(recording ? "meetings.foot.pause" : "meetings.foot.resume")}</span>
      </button>
      <button
        type="button"
        data-testid="meeting-sheet-mark"
        disabled={!recording}
        aria-label={t("meetings.mark.title", { shortcut: markShortcut })}
        title={t("meetings.mark.title", { shortcut: markShortcut })}
        onClick={() => void commands.run("meeting.mark")}
        className="meeting-button meeting-button--words"
      >
        <BookmarkLineIcon className="size-3.5" />
        <span>{t("meetings.mark")}</span>
      </button>
      <button
        type="button"
        data-testid="meeting-sheet-screen"
        disabled={!recording}
        aria-label={t("meetings.screen.offer")}
        title={t("meetings.screen.offer")}
        onClick={() => void chooseScreen(meeting.id)}
        className="meeting-button meeting-button--words"
      >
        <ScreenLineIcon className="size-3.5" />
        <span>{t("meetings.foot.screen")}</span>
      </button>
      <CallHelpToggle />
      <span className="ml-auto" />
      <SheetMore meeting={meeting} />
    </footer>
  );
}

/** Template and Language behind one ⋯ at the foot's end: the sheet is never wider than the text. */
function SheetMore({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const menu = usePopoverMenu({ align: "end", focus: "first" });
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="meeting-sheet-more"
        aria-label={t("meetings.bar.more")}
        title={t("meetings.bar.more")}
        className="meeting-button meeting-button--icon meeting-sheet-more"
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("meetings.bar.more")}
        className={`${menuFrameClass} w-64 max-w-[calc(100vw-16px)]`}
      >
        {menu.open && (
          <>
            <p className={menuTitleClass}>{t("meetings.template.chip")}</p>
            <MeetingTemplateRows
              meeting={meeting}
              onChoose={(id) => {
                menu.close();
                void applyMeetingWriteupTemplate(meeting.id, id);
              }}
            />
            <hr className={menuRuleClass} />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                menu.close();
                useAppStore.getState().openSettings("meetings");
              }}
              className={menuItemClass}
            >
              {t("meetings.foot.languageTip")}…
            </button>
          </>
        )}
      </div>
    </>
  );
}
