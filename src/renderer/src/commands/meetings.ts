import { isInTable } from "@tiptap/pm/tables";
import type { Meeting } from "../../../core/api";
import { writingTime } from "../../../shared/blockTimes";
import { markNow, noteOf } from "../editor/meetingNotes";
import { translateNow } from "../i18n";
import { currentMindIdOf, currentTabOf } from "../layoutSlice";
import { helpKeysLabel } from "../meetingHelp";
import { canRecordMeetings, isLive, useMeetings } from "../meetings";
import {
  hasMeetingViews,
  type MeetingNoteView,
  meetingNoteViewFor,
  meetingViewsOf,
  showMeetingNoteView,
  stepMeetingNoteView,
} from "../meetingViews";
import { useRequests } from "../requests";
import { useAppStore } from "../store";
import { openTranscriptBeside } from "../transcripts";
import { readMindHandle, transcriptHandle } from "./handles";
import type { Command, CommandContext } from "./registry";

/*
 * Recording a Meeting (#135), from the keyboard, the menus and ⌘K. ⌘⇧P is a
 * window-wide key, like a media key: it acts while the User types in the
 * meeting's notes, and pauses the meeting that records from any Mind. It
 * resumes only the meeting in view, so a paused one never starts from elsewhere.
 */

/** The Meeting these act on: the Mind in view's, while it is live, else the one recording. */
function liveMeeting(): Meeting | undefined {
  const { meetings } = useMeetings.getState();
  const mindId = currentMindIdOf(useAppStore.getState().layout);
  const inView = meetings.find((each) => each.mindId === mindId);
  if (isLive(inView)) return inView;
  return meetings.find((each) => each.status === "recording");
}

const meetingsOn = () => canRecordMeetings(useAppStore.getState().settings);

const whileLive = () => (liveMeeting() ? true : { reason: "meetings.command.noneLive" as const });

const whileRecording = () => {
  const meeting = liveMeeting();
  if (!meeting) return { reason: "meetings.command.noneLive" as const };
  return meeting.status === "recording" ? true : { reason: "meetings.command.markPaused" as const };
};

/**
 * Mark (⌘D): an empty bullet at the Meeting's time now, the cursor in it, in the
 * Meeting's notes, wherever the User is. ⌘Z in the notes takes it back, as it
 * does any line.
 */
async function leaveMark(): Promise<void> {
  const meeting = liveMeeting();
  if (!meeting) return;
  const note = await noteOf(meeting.mindId);
  const current = useMeetings.getState().meetings.find((each) => each.id === meeting.id);
  const ms = writingTime(current, Date.now());
  if (!note || ms === null || !markNow(note, ms)) {
    throw new Error(translateNow("meetings.mark.noNote"));
  }
}

/**
 * The Mind in view's Meeting, once it has started: the one whose recording details there are.
 * A command aimed at a Mind, as its own line's button is, takes that Mind's Meeting, which a
 * second group beside it doesn't change.
 */
function startedMeetingInView(ctx?: CommandContext): Meeting | undefined {
  const mindId =
    ctx?.focus?.kind === "mind" ? ctx.focus.id : currentMindIdOf(useAppStore.getState().layout);
  const meeting = useMeetings.getState().meetings.find((each) => each.mindId === mindId);
  return meeting && meeting.status !== "ready" ? meeting : undefined;
}

const whereMeetings = (ctx?: CommandContext) =>
  meetingsOn() || startedMeetingInView(ctx) !== undefined;

const whileAudioKept = (ctx: CommandContext) => {
  const meeting = startedMeetingInView(ctx);
  if (!meeting) return { reason: "meetings.command.noMeetingInView" as const };
  if (meeting.status === "recording") {
    return { reason: "meetings.command.audioWhileRecording" as const };
  }
  if (meeting.audio.kept) return true;
  return {
    reason: meeting.audio.deletedAt ? "meetings.audio.deleted" : "meetings.audio.none",
  } as const;
};

function meetingPageInView(ctx: CommandContext) {
  const layout = useAppStore.getState().layout;
  const tab = currentTabOf(layout);
  if (tab?.item.kind !== "mind") return null;
  const mindId = tab.item.mindId;
  if (ctx.focus && (ctx.focus.kind !== "mind" || ctx.focus.id !== mindId)) return null;
  const meeting = useMeetings.getState().meetings.find((each) => each.mindId === mindId);
  if (!hasMeetingViews(meeting)) return null;
  const groupId = layout?.groups.find((group) => group.tabs.some((each) => each.id === tab.id))?.id;
  return { tabId: tab.id, groupId, mindId, meeting };
}

const showViewCommand = (
  id: string,
  view: MeetingNoteView,
  label: "meetings.views.showNotes" | "meetings.views.showMine" | "meetings.views.showTranscript",
): Command => ({
  id: `meeting.${id}`,
  label,
  keywords: [
    "meetings.views.label",
    "meetings.views.notes",
    "meetings.views.mine",
    "meetings.views.transcript",
  ],
  group: "main",
  // Another view is one more choice away.
  reversible: true,
  assistant: false,
  when: (ctx) => {
    const page = meetingPageInView(ctx);
    return (
      page !== null &&
      meetingViewsOf(page.meeting).includes(view) &&
      meetingNoteViewFor(page.tabId, page.mindId) !== view
    );
  },
  run(ctx) {
    const page = meetingPageInView(ctx);
    if (page) showMeetingNoteView(page.tabId, page.mindId, view, { focus: true });
  },
});

/** The notes' cursor is in a table: there ⌥⌘← and ⌥⌘→ add a column, as they do in any note. */
function typingInTable(): boolean {
  const editor = readMindHandle.current?.editor;
  return !!editor && !editor.isDestroyed && editor.view.hasFocus() && isInTable(editor.state);
}

const stepViewCommand = (id: string, by: -1 | 1, keys: string): Command => ({
  id: `meeting.${id}`,
  label: by < 0 ? "meetings.views.showNotes" : "meetings.views.showTranscript",
  shortcut: { keys },
  palette: false,
  group: "main",
  reversible: true,
  assistant: false,
  when: (ctx) => meetingPageInView(ctx) !== null && !typingInTable(),
  run(ctx) {
    const page = meetingPageInView(ctx);
    if (page) stepMeetingNoteView(page.tabId, page.meeting, by);
  },
});

export const meetingCommands: readonly Command[] = [
  {
    id: "meeting.record",
    recording: "starts",
    label: "meetings.record",
    keywords: ["meetings.record.keywords"],
    group: "main",
    // A new Mind, which ⌘Z takes back.
    reversible: true,
    run: () => useMeetings.getState().record(),
  },
  {
    id: "memo.record",
    recording: "starts",
    label: "memos.record",
    keywords: ["memos.record.keywords"],
    group: "main",
    // A Mind it makes is taken back by Delete; the note it writes, by its Undo.
    reversible: true,
    run: () => useMeetings.getState().recordMemo(),
  },
  {
    id: "meeting.pauseResume",
    recording: "starts",
    label: (_ctx, t) =>
      t(liveMeeting()?.status === "paused" ? "meetings.command.resume" : "meetings.command.pause"),
    shortcut: { keys: "CmdOrCtrl+Shift+P" },
    group: "main",
    // Pressed again, it undoes itself.
    reversible: true,
    when: meetingsOn,
    enabled: whileLive,
    run() {
      const meeting = liveMeeting();
      if (!meeting) return;
      const { pause, resume } = useMeetings.getState();
      return meeting.status === "recording" ? pause(meeting.id) : resume(meeting.id);
    },
  },
  {
    id: "meeting.microphone",
    recording: "starts",
    label: (_ctx, t) =>
      t(liveMeeting()?.microphonePausedAtMs != null ? "meetings.mic.resume" : "meetings.mic.pause"),
    group: "main",
    // Pressed again, it undoes itself.
    reversible: true,
    when: meetingsOn,
    enabled: whileLive,
    globalKeys: () => helpKeysLabel("mic", useAppStore.getState().settings),
    run() {
      const meeting = liveMeeting();
      if (!meeting) return;
      return useMeetings
        .getState()
        .setMicrophonePaused(meeting.id, meeting.microphonePausedAtMs === null);
    },
  },
  {
    id: "meeting.mark",
    label: "meetings.command.mark",
    shortcut: { keys: "CmdOrCtrl+D" },
    group: "main",
    // A line in the notes: ⌘Z there takes it back.
    reversible: true,
    when: meetingsOn,
    enabled: whileRecording,
    run: leaveMark,
  },
  {
    id: "meeting.addLine",
    label: "meetings.command.addLine",
    group: "main",
    // Its Undo line, and ⌘Z outside a text field, take it back.
    reversible: true,
    when: () => transcriptHandle.current !== null,
    enabled: () =>
      transcriptHandle.current?.hasLine() ? true : { reason: "meetings.command.noLine" },
    run: () => transcriptHandle.current?.addLine(),
  },
  {
    id: "meeting.changeSpeaker",
    label: "meetings.command.changeSpeaker",
    keywords: ["transcript.speaker.new", "transcript.speaker.all"],
    group: "main",
    // Its menu's choice has an Undo line, and ⌘Z outside a text field takes it back.
    reversible: true,
    when: () => transcriptHandle.current !== null,
    enabled: () =>
      !transcriptHandle.current?.hasLine()
        ? { reason: "meetings.command.noLine" }
        : transcriptHandle.current.canChangeSpeaker()
          ? true
          : { reason: "meetings.command.noSpeaker" },
    run: () => transcriptHandle.current?.changeSpeaker(),
  },
  showViewCommand("showNotes", "notes", "meetings.views.showNotes"),
  showViewCommand("showMyNotes", "mine", "meetings.views.showMine"),
  showViewCommand("showTranscript", "transcript", "meetings.views.showTranscript"),
  stepViewCommand("previousView", -1, "CmdOrCtrl+Alt+Left"),
  stepViewCommand("nextView", 1, "CmdOrCtrl+Alt+Right"),
  {
    id: "meeting.transcriptBeside",
    label: "meetings.views.besideCommand",
    keywords: ["meetings.views.transcript", "command.openBeside"],
    group: "main",
    // Its tab closes again.
    reversible: true,
    assistant: false,
    when: (ctx) => meetingPageInView(ctx) !== null,
    enabled: (ctx) =>
      meetingPageInView(ctx)?.meeting.transcript?.documentId
        ? true
        : { reason: "meetings.bar.transcriptSoon" },
    run(ctx) {
      const page = meetingPageInView(ctx);
      if (page) openTranscriptBeside(page);
    },
  },
  {
    id: "meeting.stop",
    label: "meetings.command.stop",
    recording: "ends",
    group: "main",
    // Nothing recorded is lost, but a stopped Meeting can't be picked up again.
    reversible: { confirm: "meetings.command.stopConfirm" },
    when: meetingsOn,
    enabled: whileLive,
    run() {
      const meeting = liveMeeting();
      if (meeting) return useMeetings.getState().stop(meeting.id);
    },
  },
  {
    id: "meeting.details",
    label: (_ctx, t) => {
      const meeting = startedMeetingInView();
      const shown = meeting && useMeetings.getState().detailsShown[meeting.id];
      return t(shown ? "meetings.health.hide" : "meetings.health.show");
    },
    group: "main",
    // Pressed again, it undoes itself.
    reversible: true,
    when: () => whereMeetings(),
    enabled: () => (startedMeetingInView() ? true : { reason: "meetings.health.none" }),
    run() {
      const meeting = startedMeetingInView();
      if (meeting) useMeetings.getState().showDetails(meeting.id);
    },
  },
  {
    id: "meeting.deleteAudio",
    assistant: { never: "permanent" },
    label: "meetings.command.deleteAudio",
    group: "danger",
    destructive: true,
    reversible: { confirm: "meetings.audio.confirm" },
    when: whereMeetings,
    enabled: whileAudioKept,
    run(ctx) {
      const meeting = startedMeetingInView(ctx);
      if (meeting) useRequests.getState().ask({ deleteAudio: { meetingId: meeting.id } });
    },
  },
];
