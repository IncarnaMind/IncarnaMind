import { useEffect, useState } from "react";
import { create } from "zustand";
import type { AudioSource, Meeting, Settings } from "../../core/api";
import { meetingTimeAt } from "../../shared/blockTimes";
import { mindName } from "../../shared/naming";
import { core, files } from "./core";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { currentMindIdOf } from "./layoutSlice";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

interface MeetingsState {
  meetings: Meeting[];
  /** What went wrong with the last thing done to a Meeting, by its id, until the next try. */
  problems: Readonly<Record<string, string>>;
  /** The Meeting whose Start, or the voice memo, waits for the one-time recording notice. */
  noticeFor: { meetingId: string; systemAudio: boolean } | { memo: true } | null;
  starting: Readonly<Record<string, true>>;
  /** The Meeting whose start block Record just made: its Start recording takes the focus once it shows. */
  startToFocus: string | null;
  /** Record was chosen where this copy can't record audio: the sidebar's footer says so until it is dismissed. */
  cantRecord: boolean;
  /** The gaps the User has dismissed, by Meeting: how many of its gaps they have seen. */
  gapsSeen: Readonly<Record<string, number>>;
  /** The Meetings whose recording details are shown (#161). */
  detailsShown: Readonly<Record<string, boolean>>;
  /** Lists the Meetings, at startup; the core's events keep the list after that. */
  load(): Promise<void>;
  /**
   * "Record a meeting": the Meeting recording now, opened, or else a new Mind in a tab of its
   * own, in the Folder of the Mind in view; it starts recording at once once the User has read
   * the one-time notice, and shows the start block before.
   */
  record(): Promise<void>;
  /**
   * "Record a voice memo" (#1568): the Meeting recording now, opened; else a memo records at
   * once, in the empty Mind in front, or in a new Mind in a tab of its own, in the Folder of the
   * Mind in front (#1362). The first time, after the one-time recording notice.
   */
  recordMemo(): Promise<void>;
  clearCantRecord(): void;
  /** Start recording, after the one-time notice if this device hasn't shown it. */
  start(meetingId: string, systemAudio: boolean): Promise<void>;
  /** The notice was read: recording starts, and the notice isn't shown again. */
  acceptNotice(): Promise<void>;
  cancelNotice(): void;
  pause(meetingId: string): Promise<void>;
  resume(meetingId: string): Promise<void>;
  setMicrophonePaused(meetingId: string, paused: boolean): Promise<void>;
  stop(meetingId: string): Promise<void>;
  discard(meetingId: string): Promise<void>;
  deleteAudio(meetingId: string): Promise<void>;
  /** Tries the Meeting's Transcript again after a problem: the model's download, its engine, or saving it. */
  retryTranscript(meetingId: string): Promise<void>;
  /** Fills the notes in from the Transcript again (#142): Try again, or after an Undo. */
  fillNotes(meetingId: string): Promise<void>;
  /** Takes back what filling the notes in added (#142). */
  undoFill(meetingId: string): Promise<void>;
  openSettings(meetingId: string, source: AudioSource): Promise<void>;
  dismissGaps(meetingId: string): void;
  /** Shows or hides a Meeting's recording details; with no `shown`, the other way from now. */
  showDetails(meetingId: string, shown?: boolean): void;
}

/** Meetings (#135), as the core lists them, and what the UI does with them. */
export const useMeetings = create<MeetingsState>()((set, get) => {
  /** Runs one action on a Meeting, keeping its failure as that Meeting's problem. */
  const attempt = async (meetingId: string, action: () => Promise<unknown>) => {
    set((state) => ({ problems: withoutKey(state.problems, meetingId) }));
    try {
      await action();
    } catch (error) {
      set((state) => ({
        problems: { ...state.problems, [meetingId]: errorMessage(error, translateNow) },
      }));
    }
  };

  // Asked for twice quickly, a memo is made once.
  let makingMemo = false;
  const memoNow = async () => {
    if (makingMemo) return;
    makingMemo = true;
    const { layout, minds } = useAppStore.getState();
    const inFront = minds.find((each) => each.id === currentMindIdOf(layout));
    const emptyInFront =
      inFront &&
      mindName(inFront) === "" &&
      !get().meetings.some((each) => each.mindId === inFront.id)
        ? inFront
        : null;
    try {
      const memo = await core.recordMemo(
        emptyInFront
          ? { mindId: emptyInFront.id }
          : inFront?.folderId
            ? { folderId: inFront.folderId }
            : undefined,
      );
      // Listed at once, so its Mind shows the bar from its first paint.
      set((state) => ({
        meetings: [memo, ...state.meetings.filter((each) => each.id !== memo.id)],
      }));
      useAppStore.setState({ bodyToFocus: memo.mindId });
      if (!emptyInFront) {
        await useAppStore.getState().changeLayout({
          type: "open",
          item: { kind: "mind", mindId: memo.mindId },
          where: { in: "group" },
        });
      }
    } catch (error) {
      useAppStore.getState().reportError(error);
    } finally {
      makingMemo = false;
    }
  };

  return {
    meetings: [],
    problems: {},
    noticeFor: null,
    cantRecord: false,
    starting: {},
    startToFocus: null,
    gapsSeen: {},
    detailsShown: {},

    async load() {
      try {
        set({ meetings: await core.listMeetings() });
      } catch (error) {
        useAppStore.getState().reportError(error);
      }
    },

    async record() {
      const recording = get().meetings.find((each) => each.status === "recording");
      if (recording) {
        useAppStore.getState().openMind(recording.mindId);
        return;
      }
      const { settings, layout, minds } = useAppStore.getState();
      if (!settings) return;
      if (settings.meetingAudio === "none") {
        set({ cantRecord: true });
        return;
      }
      let created: string | null = null;
      try {
        const inView = currentMindIdOf(layout);
        const folderId = minds.find((each) => each.id === inView)?.folderId ?? null;
        const meeting = await core.createMeeting(folderId ? { folderId } : undefined);
        created = meeting.id;
        const starts = settings.device.meetingNoticeAccepted;
        if (starts) set((state) => ({ starting: { ...state.starting, [meeting.id]: true } }));
        // The notes come first in a meeting: the text has the cursor, as in a Mind made with ⌘T.
        // Under the start block it is the block's, so that Enter starts and Esc keeps the Mind as a note.
        if (starts) useAppStore.setState({ bodyToFocus: meeting.mindId });
        else set({ startToFocus: meeting.id });
        // A tab of its own, as New Mind opens one: never in place of the Mind the User is in.
        await useAppStore.getState().changeLayout({
          type: "open",
          item: { kind: "mind", mindId: meeting.mindId },
          where: { in: "group" },
        });
        if (starts) await get().start(meeting.id, meeting.systemAudio);
        // The core's event can come after start() returns, and showing the start block between
        // would flash it: the Meeting leaves "starting" with its status, or here if the start failed.
        if (meeting.id in get().problems) set(stopStarting(meeting.id));
      } catch (error) {
        useAppStore.getState().reportError(error);
        if (created) set({ ...stopStarting(created)(get()), startToFocus: null });
      }
    },

    async recordMemo() {
      const recording = get().meetings.find((each) => each.status === "recording");
      if (recording) {
        useAppStore.getState().openMind(recording.mindId);
        return;
      }
      const { settings } = useAppStore.getState();
      if (!settings) return;
      if (settings.meetingAudio === "none") {
        set({ cantRecord: true });
        return;
      }
      if (!settings.device.meetingNoticeAccepted) {
        set({ noticeFor: { memo: true } });
        return;
      }
      await memoNow();
    },

    clearCantRecord: () => set({ cantRecord: false }),

    async start(meetingId, systemAudio) {
      if (!useAppStore.getState().settings?.device.meetingNoticeAccepted) {
        set({ noticeFor: { meetingId, systemAudio } });
        return;
      }
      await attempt(meetingId, () => core.startMeeting({ meetingId, systemAudio }));
    },

    async acceptNotice() {
      const waiting = get().noticeFor;
      set({ noticeFor: null });
      if (!waiting) return;
      if ("memo" in waiting) {
        try {
          await core.updateSettings({ device: { meetingNoticeAccepted: true } });
        } catch (error) {
          useAppStore.getState().reportError(error);
          return;
        }
        await memoNow();
        return;
      }
      await attempt(waiting.meetingId, async () => {
        await core.updateSettings({ device: { meetingNoticeAccepted: true } });
        await core.startMeeting(waiting);
      });
    },

    cancelNotice: () => set({ noticeFor: null }),
    pause: (meetingId) => attempt(meetingId, () => core.pauseMeeting(meetingId)),
    resume: (meetingId) => attempt(meetingId, () => core.resumeMeeting(meetingId)),
    async setMicrophonePaused(meetingId, paused) {
      const before = get().meetings.find((each) => each.id === meetingId);
      const show = (meeting: Meeting) =>
        set((state) => ({
          meetings: state.meetings.map((each) => (each.id === meetingId ? meeting : each)),
        }));
      // The button answers at once; the core's own answer replaces this one a moment later.
      const shown = before && {
        ...before,
        microphonePausedAtMs: paused
          ? (before.microphonePausedAtMs ?? meetingTimeAt(before, Date.now()))
          : null,
      };
      if (shown) show(shown);
      await attempt(meetingId, async () => {
        try {
          await core.setMeetingMicrophone({ meetingId, paused });
        } catch (error) {
          // Only over the Meeting shown at once: one the core sent since is newer (#2302).
          if (before && get().meetings.find((each) => each.id === meetingId) === shown) {
            show(before);
          }
          throw error;
        }
      });
    },
    stop: (meetingId) => attempt(meetingId, () => core.stopMeeting(meetingId)),
    async discard(meetingId) {
      const mindId = get().meetings.find((each) => each.id === meetingId)?.mindId;
      await attempt(meetingId, () => core.discardMeeting(meetingId));
      // The block it leaves had the focus: the Mind stays as a note, and its text takes the cursor.
      if (mindId && !(meetingId in get().problems)) useAppStore.setState({ bodyToFocus: mindId });
    },
    deleteAudio: (meetingId) => attempt(meetingId, () => core.deleteMeetingAudio(meetingId)),
    retryTranscript: (meetingId) => attempt(meetingId, () => core.retryTranscript(meetingId)),
    fillNotes: (meetingId) => attempt(meetingId, () => core.fillMeetingNotes(meetingId)),
    undoFill: (meetingId) => attempt(meetingId, () => core.undoMeetingFill(meetingId)),
    openSettings: (meetingId, source) =>
      attempt(meetingId, async () => {
        await core.openAudioSettings(source);
        await files.showPermissionGuide(source);
      }),
    dismissGaps(meetingId) {
      const meeting = get().meetings.find((each) => each.id === meetingId);
      set((state) => ({
        gapsSeen: { ...state.gapsSeen, [meetingId]: meeting?.gaps.length ?? 0 },
      }));
    },
    showDetails(meetingId, shown) {
      set((state) => ({
        detailsShown: {
          ...state.detailsShown,
          [meetingId]: shown ?? !state.detailsShown[meetingId],
        },
      }));
    },
  };
});

const stopStarting =
  (meetingId: string) =>
  (state: MeetingsState): Pick<MeetingsState, "starting"> => ({
    starting: withoutKey(state.starting, meetingId),
  });

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

/** Notes just filled in go on the undo stack, as a change made for the User: ⌘Z takes them back. */
function offerUndoOfFill(before: readonly Meeting[], after: readonly Meeting[]): void {
  for (const meeting of after) {
    if (meeting.fill?.state !== "filled") continue;
    const was = before.find((each) => each.id === meeting.id)?.fill?.state;
    if (was === undefined || was === "filled") continue;
    const memo = meeting.kind === "memo";
    useUndo.getState().push({
      said: (t) => t(memo ? "memos.fill.filled" : "meetings.fill.filled"),
      name: (t) => t(memo ? "memos.fill.undoName" : "meetings.fill.undoName"),
      undo: () => core.undoMeetingFill(meeting.id).then(() => undefined),
      also: {
        label: (t) => t("meetings.fill.show"),
        testId: "meeting-fill-show",
        run: () => useAppStore.getState().openMind(meeting.mindId),
      },
    });
  }
}

core.on("meetings.notesShown", ({ mindId }) => useAppStore.getState().openMind(mindId));

core.on("meetings.changed", (meetings) => {
  offerUndoOfFill(useMeetings.getState().meetings, meetings);
  useMeetings.setState((state) => ({
    meetings,
    starting: Object.fromEntries(
      Object.keys(state.starting)
        .filter((id) => meetings.some((each) => each.id === id && each.status === "ready"))
        .map((id) => [id, true as const]),
    ),
  }));
});

export const canRecordMeetings = (settings: Settings | null): boolean =>
  !!settings && settings.meetingAudio !== "none";

/** The Mind's Meeting, if it has one. */
export const useMeetingOf = (mindId: string): Meeting | undefined =>
  useMeetings((state) => state.meetings.find((each) => each.mindId === mindId));

/** A Meeting is recording or paused: its Mind shows the meeting bar. */
export const isLive = (meeting: Meeting | undefined): meeting is Meeting =>
  meeting?.status === "recording" || meeting?.status === "paused";

/** Whether some Meeting's audio is being captured now: background work waits meanwhile. */
export const useCapturing = (): boolean =>
  useMeetings((state) => state.meetings.some((each) => each.recordingSince !== null));

/** The Meeting's time now, in ms, ticking each second while it records. */
export function useMeetingTime(meeting: Meeting): number {
  const since = meeting.recordingSince;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return meetingTimeAt(meeting, now);
}
