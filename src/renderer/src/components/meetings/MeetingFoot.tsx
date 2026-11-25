import { isMacOS } from "@tiptap/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import type { Meeting } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { shortcutLabel } from "../../commands/keymap";
import { commands } from "../../commands/registry";
import { useT } from "../../i18n";
import { currentTabOf } from "../../layoutSlice";
import { isLive, useMeetingOf, useMeetings, useMeetingTime } from "../../meetings";
import { clockTime } from "../../meetingTime";
import {
  focusTaken,
  showMeetingNoteView,
  useMeetingNoteView,
  useMeetingViewFocus,
} from "../../meetingViews";
import { setColumnOpen } from "../../ownAiInNote";
import { useAppStore, type ViewerTarget } from "../../store";
import { closeTip, useFeatureTip } from "../../tips";
import { openTranscriptBeside } from "../../transcripts";
import { TranscriptHeadLine } from "../../viewer/TranscriptHeadLine";
import { MeetingTranscriptView } from "../../viewer/TranscriptView";
import { type ViewerFrame, ViewerFrameContext } from "../../viewer/ViewerHeader";
import { writeMeetingNotes } from "../../writeMeetingNotes";
import { CallEndingLine } from "../CallEndingLine";
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
import { TranscriptLines } from "../TranscriptLines";
import { useTabPlace } from "../tabs/tabItems";
import { buttonStyle, menuFrameClass, menuItemClass, menuRuleClass, menuTitleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import { LevelBars, levelName } from "./LevelBars";
import { applyMeetingWriteupTemplate, MeetingTemplateRows } from "./MeetingTemplatePicker";

/**
 * The sheet's own state beside the tab's view (the Transcript is the view the sheet shows): the
 * first tip seen, the place a Citation asked it to open at, and `refocus`, which counts each fold
 * that gives the focus back to the control's chevron, by tab.
 */
const useSheet = create<{
  tipSeen: boolean;
  cited: ViewerTarget | null;
  refocus: Record<string, number>;
}>(() => ({ tipSeen: false, cited: null, refocus: {} }));

/** The Transcript is the tab's view the sheet shows over the Note: ⌘K and ⌥⌘← ⌥⌘→ raise it too. */
export const useSheetOpen = (tabId: string | undefined, mindId: string) =>
  useMeetingNoteView(tabId, mindId) === "transcript";

function setSheet(tabId: string, mindId: string, open: boolean): void {
  useSheet.setState((state) => ({ tipSeen: true, cited: open ? state.cited : null }));
  showMeetingNoteView(tabId, mindId, open ? "transcript" : "notes");
}

/** Folds the sheet from inside it (Esc, Hide): the focus goes back to the chevron it rose from. */
function foldSheet(tabId: string, mindId: string): void {
  useSheet.setState((state) => ({
    cited: null,
    refocus: { ...state.refocus, [tabId]: (state.refocus[tabId] ?? 0) + 1 },
  }));
  showMeetingNoteView(tabId, mindId, "notes");
}

/**
 * A Citation of a meeting's Transcript, pressed in a reply: the sheet rises over that meeting's
 * Note at the line cited, washed as a found quote is. False when the Citation isn't to a meeting's
 * Transcript shown in this window, so the caller opens it as any Citation.
 */
export function showCitedInTranscript(cited: ViewerTarget): boolean {
  const meeting = useMeetings
    .getState()
    .meetings.find((each) => each.transcript?.documentId === cited.documentId);
  if (!meeting || meeting.kind !== "meeting") return false;
  const { layout } = useAppStore.getState();
  const current = currentTabOf(layout);
  const tab =
    current?.item.kind === "mind" && current.item.mindId === meeting.mindId
      ? current
      : layout?.groups
          .flatMap((group) => group.tabs)
          .find((each) => each.item.kind === "mind" && each.item.mindId === meeting.mindId);
  if (!tab) return false;
  // Opened upward the conversation would lie over the sheet; in the window's column it stays beside.
  if (!document.querySelector('[data-testid="note-column"]')) setColumnOpen(meeting.mindId, false);
  useSheet.setState((state) => ({
    tipSeen: true,
    cited: { ...cited, request: (state.cited?.request ?? 0) + 1 },
  }));
  showMeetingNoteView(tab.id, meeting.mindId, "transcript");
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
  const tabId = useTabPlace()?.tabId ?? "";
  const open = useSheetOpen(tabId, mindId);
  const refocus = useSheet((state) => state.refocus[tabId] ?? 0);
  const [asked, setAsked] = useState(false);
  const live = isLive(meeting);
  const paused = meeting.status === "paused";
  const { stop, resume, openSettings } = useMeetings.getState();
  const keys = shortcutLabel("meeting.nextView");
  const micProblem = live ? MICROPHONE_PROBLEMS[meeting.sources.microphone] : undefined;
  // Interaction rule 14: one line where the feature is, gone with its ✕ or once the sheet is used.
  const tipShown = useFeatureTip("meeting-transcript", meeting.id, live && !micProblem && !open);
  useEffect(() => {
    if (open) closeTip("meeting-transcript");
  }, [open]);
  const writeNotes = async () => {
    setAsked(true);
    setSheet(tabId, mindId, false);
    try {
      // The button comes back where the request didn't go: its line says why.
      if (!(await writeMeetingNotes(meeting, t("meetings.foot.writeNotesRequest"))))
        setAsked(false);
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
        {tipShown && (
          <div role="status" data-testid="meeting-foot-tip" className="meeting-foot-tip">
            <span>{t("meetings.foot.tip")}</span>
            <button
              type="button"
              data-testid="meeting-foot-tip-close"
              aria-label={t("meetings.foot.tipClose")}
              title={t("meetings.foot.tipClose")}
              onClick={() => closeTip("meeting-transcript")}
              className="meeting-foot-tip-close"
            >
              <CloseLineIcon className="size-4" />
            </button>
          </div>
        )}
        {!open && (
          <>
            <SharedScreenLine meeting={meeting} />
            <div className="meeting-foot-card">
              <CallEndingLine meeting={meeting} />
            </div>
            {/* After Stop the page says a Transcript's problem itself (MeetingInMind). */}
            {live && (
              <div className="meeting-foot-card">
                <TranscriptLines meeting={meeting} over />
              </div>
            )}
          </>
        )}
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
              onClick={() => setSheet(tabId, mindId, !open)}
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
            onClick={() => setSheet(tabId, mindId, !open)}
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

/**
 * One of the control's icon slots: its name is its title and its accessible name. A title, as the
 * sheet's own buttons have: a tip that stayed open after the press covered the buttons over the
 * control and took the Esc that folds the sheet.
 */
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
  /** Each time it grows while the button is shown, the button takes the focus. */
  focusOn?: number;
  onClick(): void;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const seen = useRef(focusOn);
  useEffect(() => {
    if (focusOn <= seen.current) return;
    seen.current = focusOn;
    trigger.current?.focus();
  }, [focusOn]);
  return (
    <button
      ref={trigger}
      type="button"
      data-testid={testId}
      aria-label={tip}
      aria-expanded={expanded}
      title={tip}
      onClick={onClick}
      className={`meeting-foot-slot ${wide ? "meeting-foot-slot--wide" : ""}`}
    >
      {children}
    </button>
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
  const place = useTabPlace();
  const tabId = place?.tabId ?? "";
  const open = useSheetOpen(tabId, mindId);
  const documentId = meeting?.transcript?.documentId;
  const file = useAppStore((state) => state.documents.find((each) => each.id === documentId));
  const cited = useSheet((state) => state.cited);
  // A Citation pressed opens the sheet at its line, which the Transcript washes as a found quote.
  const target = useMemo<ViewerTarget>(
    () =>
      cited && cited.documentId === documentId
        ? cited
        : { documentId: documentId ?? "", request: 0 },
    [cited, documentId],
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
  const detailsShown = useMeetings(
    (state) => meeting !== undefined && state.detailsShown[meeting.id] === true,
  );
  const sheet = useRef<HTMLElement>(null);
  // ⌘K's Show the Transcript and ⌥⌘→ take the User to it, as they took them to the old view.
  const focusAsked = useMeetingViewFocus(tabId, "transcript");
  useEffect(() => {
    if (focusAsked === null || !sheet.current) return;
    sheet.current.focus();
    focusTaken(focusAsked);
  }, [focusAsked]);
  useEffect(() => {
    if (!open) return;
    // Esc closes the innermost thing open: a menu or a dialog over the sheet takes it first.
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector("dialog:modal") !== null) return;
      event.preventDefault();
      foldSheet(tabId, mindId);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, tabId, mindId]);
  if (!meeting || !open) return null;
  const live = isLive(meeting);
  return (
    // On the text's measure, as the row under it is: the place is a column container as the page is.
    <div className="meeting-sheet-place">
      <div className="mind-measure">
        <section
          ref={sheet}
          data-testid="meeting-sheet"
          data-live={live || undefined}
          data-document-id={documentId ?? undefined}
          aria-label={t("meetings.views.transcript")}
          tabIndex={-1}
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
                onClick={() => openTranscriptBeside({ meeting, tabId, groupId: place?.groupId })}
                className="meeting-sheet-icon"
              >
                <OpenBesideLineIcon className="size-4" />
              </button>
              <button
                type="button"
                data-testid="meeting-sheet-hide"
                aria-label={t("meetings.foot.hide", { keys: shortcutLabel("meeting.nextView") })}
                title={t("meetings.foot.hide", { keys: shortcutLabel("meeting.nextView") })}
                onClick={() => foldSheet(tabId, mindId)}
                className="meeting-sheet-icon"
              >
                <ChevronDownLineIcon className="size-4" />
              </button>
            </div>
          </header>
          {detailsShown && (
            <div data-testid="meeting-sheet-details" className="meeting-sheet-details">
              {meeting.status !== "recording" && <MeetingAudioLine meeting={meeting} />}
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
          <div className="meeting-sheet-body">
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
                <ResumeLineIcon className="size-4" />
                <span>{t("meetings.foot.resume")}</span>
              </button>
              <button
                type="button"
                data-testid="meeting-sheet-review-speakers"
                // The review opens where the Transcript has it, at the top of its lines.
                onClick={() => void commands.run("meeting.reviewSpeakers")}
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
        {micPaused ? <MicOffLineIcon className="size-4" /> : <MicLineIcon className="size-4" />}
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
          <PauseLineIcon className="size-4" />
        ) : (
          <ResumeLineIcon className="size-4" />
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
        <BookmarkLineIcon className="size-4" />
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
        <ScreenLineIcon className="size-4" />
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
