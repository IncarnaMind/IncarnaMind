import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import type { Meeting } from "../../../../core/api";
import { shortcutLabel } from "../../commands/keymap";
import { commands } from "../../commands/registry";
import { useT } from "../../i18n";
import { isLive, useMeetingOf, useMeetings, useMeetingTime } from "../../meetings";
import { clockTime } from "../../meetingTime";
import { askInNote, setColumnOpen } from "../../ownAiInNote";
import { useAppStore, type ViewerTarget } from "../../store";
import { openTranscriptBeside } from "../../transcripts";
import { MeetingTranscriptView } from "../../viewer/TranscriptView";
import { type ViewerFrame, ViewerFrameContext } from "../../viewer/ViewerHeader";
import { CaptureDetails, CaptureDetailsToggle } from "../CaptureDetails";
import {
  BookmarkLineIcon,
  ChevronDownLineIcon,
  CloseLineIcon,
  MicLineIcon,
  MicOffLineIcon,
  OpenBesideLineIcon,
  PauseLineIcon,
  ResumeLineIcon,
  ScreenLineIcon,
  StopLineIcon,
} from "../lineIcons";
import { CallHelpToggle, MeetingLines } from "../MeetingBar";
import { useTabPlace } from "../tabs/tabItems";
import { buttonStyle } from "../ui";
import { LevelBars } from "./LevelBars";
import { MeetingTemplatePicker } from "./MeetingTemplatePicker";

/** Whether a meeting Note's Transcript sheet is up, per Note, and the words a Citation asked it to show. */
const useSheets = create<{ open: Record<string, boolean>; tipSeen: boolean; quote: string }>(
  () => ({ open: {}, tipSeen: false, quote: "" }),
);
const setSheet = (mindId: string, open: boolean) =>
  useSheets.setState((state) => ({
    open: { ...state.open, [mindId]: open },
    tipSeen: true,
    quote: open ? state.quote : "",
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
  setColumnOpen(meeting.mindId, false);
  useSheets.setState((state) => ({
    open: { ...state.open, [meeting.mindId]: true },
    tipSeen: true,
    quote,
  }));
  return true;
}

/** Whether the meeting's control stands at the Note's foot: while it records, and after Stop until notes are asked for. */
export function useMeetingFootShown(mindId: string): boolean {
  const meeting = useMeetingOf(mindId);
  if (!meeting || meeting.kind !== "meeting" || meeting.status === "ready") return false;
  return isLive(meeting) || meeting.fill?.state === "own-ai";
}

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
  const time = clockTime(useMeetingTime(meeting));
  const [asked, setAsked] = useState(false);
  const live = isLive(meeting);
  const { stop, resume } = useMeetings.getState();
  const keys = shortcutLabel("meeting.nextView");
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
      {live && !tipSeen && (
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
            <CloseLineIcon className="size-3.5" />
          </button>
        </div>
      )}
      {!live && !asked && (
        <button
          type="button"
          data-testid="meeting-write-notes"
          onClick={() => void writeNotes()}
          className={`${buttonStyle("primary")} meeting-write-notes`}
        >
          {t("meetings.foot.writeNotes")}
        </button>
      )}
      <div
        data-testid="meeting-foot"
        data-status={meeting.status}
        role="group"
        aria-label={t("meetings.bar.label")}
        className="meeting-foot"
      >
        <button
          type="button"
          data-testid="meeting-foot-transcript"
          aria-expanded={open}
          aria-label={t(open ? "meetings.foot.hide" : "meetings.foot.show", { keys })}
          title={t(open ? "meetings.foot.hide" : "meetings.foot.show", { keys })}
          onClick={() => setSheet(mindId, !open)}
          className="meeting-foot-button meeting-foot-main"
        >
          {live ? (
            <>
              <span aria-hidden="true" data-status={meeting.status} className="recording-dot" />
              <span role="timer" className="meeting-foot-time">
                {time}
              </span>
              <LevelBars meeting={meeting} />
            </>
          ) : (
            <span>{t("meetings.views.transcript")}</span>
          )}
          <ChevronDownLineIcon className={`size-4 ${open ? "" : "rotate-180"}`} />
        </button>
        {live ? (
          <button
            type="button"
            data-testid="meeting-foot-stop"
            aria-label={t("meetings.bar.stopLabel")}
            title={t("meetings.bar.stopLabel")}
            onClick={() => void stop(meeting.id)}
            className="meeting-foot-button"
          >
            <StopLineIcon className="size-4" />
            <span className="meeting-foot-word">{t("meetings.bar.stop")}</span>
          </button>
        ) : (
          <button
            type="button"
            data-testid="meeting-foot-resume"
            aria-label={t("meetings.foot.resumeTip")}
            title={t("meetings.foot.resumeTip")}
            onClick={() => void resume(meeting.id)}
            className="meeting-foot-button"
          >
            <ResumeLineIcon className="size-4" />
            <span className="meeting-foot-word">{t("meetings.foot.resume")}</span>
          </button>
        )}
      </div>
    </div>
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
  const document = useAppStore((state) => state.documents.find((each) => each.id === documentId));
  const target = useMemo<ViewerTarget>(
    () => ({ documentId: documentId ?? "", request: 0 }),
    [documentId],
  );
  const frame = useMemo<ViewerFrame>(
    () => ({ document, tabId, target, embedded: true, preview: false, keep: () => undefined }),
    [document, tabId, target],
  );
  const quote = useSheets((state) => state.quote);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = body.current;
    if (!open || !root) return;
    for (const line of root.querySelectorAll("[data-cited]")) line.removeAttribute("data-cited");
    if (!quote) return;
    const start = quote.slice(0, 24);
    const line = [...root.querySelectorAll<HTMLElement>('[data-testid="transcript-line"]')].find(
      (each) => (each.textContent ?? "").includes(start),
    );
    if (!line) return;
    line.setAttribute("data-cited", "true");
    line.scrollIntoView({ block: "center" });
  });
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheet(mindId, false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, mindId]);
  if (!meeting || !open) return null;
  const live = isLive(meeting);
  return (
    <section
      data-testid="meeting-sheet"
      aria-label={t("meetings.views.transcript")}
      className="meeting-sheet viewer-pane [container:viewer/inline-size]"
    >
      <header className="meeting-sheet-head">
        <h2 className="meeting-sheet-title">{t("meetings.views.transcript")}</h2>
        <div className="ml-auto flex items-center gap-1">
          {live && <CaptureDetailsToggle meeting={meeting} />}
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
            onClick={() => setSheet(mindId, false)}
            className="meeting-sheet-icon"
          >
            <ChevronDownLineIcon className="size-4" />
          </button>
        </div>
      </header>
      {live && <p className="meeting-sheet-consent">{t("meetings.foot.tell")}</p>}
      {live && <MeetingLines meeting={meeting} />}
      {live && <CaptureDetails meeting={meeting} />}
      <div ref={body} className="meeting-sheet-body">
        <ViewerFrameContext.Provider value={frame}>
          <MeetingTranscriptView
            key={meeting.id}
            meeting={meeting}
            document={document}
            target={target}
            aside={null}
          />
        </ViewerFrameContext.Provider>
      </div>
      {live && <SheetFoot meeting={meeting} />}
    </section>
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
      <MeetingTemplatePicker meeting={meeting} />
      <button
        type="button"
        data-testid="meeting-sheet-language"
        aria-label={t("meetings.foot.languageTip")}
        title={t("meetings.foot.languageTip")}
        onClick={() => useAppStore.getState().openSettings("meetings")}
        className="meeting-button meeting-button--words"
      >
        <span>{t("meetings.foot.language")}</span>
        <ChevronDownLineIcon className="size-3 shrink-0" />
      </button>
    </footer>
  );
}
