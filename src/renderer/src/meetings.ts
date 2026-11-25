import { useEffect, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AudioSource, Meeting, Settings, ShareableWindow } from "../../core/api";
import { meetingTimeAt } from "../../shared/blockTimes";
import { isPartialMeetingFill } from "../../shared/meetingFill";
import { mindName } from "../../shared/naming";
import { core, files } from "./core";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { currentMindIdOf, currentTabOf } from "./layoutSlice";
import { fillHeldInEditor, letGoOfUndoneFill, undoFillInEditor } from "./meetingFillSteps";
import { useAppStore } from "./store";
import { placeOf } from "./taggingStop";
import { useUndo } from "./undo";

type AppState = ReturnType<typeof useAppStore.getState>;

/**
 * Where the User is, for a meeting made with no Note in front (#3762): the Folder of the Note, its
 * figures or the Document in front; else none.
 */
function folderInView(layout: AppState["layout"], minds: AppState["minds"]): string | null {
  const item = currentTabOf(layout)?.item;
  if (item?.kind === "mind" || item?.kind === "figures") {
    return minds.find((each) => each.id === item.mindId)?.folderId ?? null;
  }
  if (item?.kind === "document") {
    // A Document filed by hand is placed in the Library's assignments; a linked folder's file
    // carries its Folder itself.
    const { documents, library } = useAppStore.getState();
    return (
      placeOf(library, item.documentId) ??
      documents.find((each) => each.id === item.documentId)?.folderId ??
      null
    );
  }
  return null;
}

interface MeetingsState {
  meetings: Meeting[];
  /** What went wrong with the last thing done to a Meeting, by its id, until the next try. */
  problems: Readonly<Record<string, string>>;
  /** What went wrong deleting or keeping a Meeting's audio, said on its audio line (#687). */
  audioProblems: Readonly<Record<string, string>>;
  starting: Readonly<Record<string, true>>;
  /** The Meeting whose start block Record just made: its Start recording takes the focus once it shows. */
  startToFocus: string | null;
  /** Record was chosen where this copy can't record audio: the sidebar's footer says so until it is dismissed. */
  cantRecord: boolean;
  /** The gaps the User has dismissed, by Meeting: how many of its gaps they have seen. */
  gapsSeen: Readonly<Record<string, number>>;
  /** The Meetings whose recording details are shown (#161). */
  detailsShown: Readonly<Record<string, boolean>>;
  /**
   * IncarnaMind's window picker for a Meeting's shared screen (ADR-0031),
   * while open: the windows to choose from, null while they are found.
   */
  screenPicker: { meetingId: string; windows: ShareableWindow[] | null } | null;
  /**
   * The Meetings whose bar has said why macOS will ask for Screen Recording:
   * Choose window… then asks for it.
   */
  screenExplained: Readonly<Record<string, boolean>>;
  /** Lists the Meetings, at startup; the core's events keep the list after that. */
  load(): Promise<void>;
  /**
   * "Record a meeting": the Meeting recording now, opened, or else a new Mind in a tab of its
   * own, in the Folder of the Mind in view, recording at once (#3762).
   */
  record(): Promise<void>;
  /**
   * Join and record (#190): a Meeting in this Note, the one a calendar event's Take notes made,
   * recording at once; the Meeting recording now is opened instead, as Record a meeting opens it.
   */
  recordIn(mindId: string): Promise<void>;
  /**
   * "Record a voice memo" (#1568): the Meeting recording now, opened; else a memo records at
   * once, in the empty Mind in front, or in a new Mind in a tab of its own, in the Folder of the
   * Mind in front (#1362).
   */
  recordMemo(): Promise<void>;
  clearCantRecord(): void;
  start(meetingId: string, systemAudio: boolean): Promise<void>;
  pause(meetingId: string): Promise<void>;
  resume(meetingId: string): Promise<void>;
  setMicrophonePaused(meetingId: string, paused: boolean): Promise<void>;
  stop(meetingId: string): Promise<void>;
  discard(meetingId: string): Promise<void>;
  deleteAudio(meetingId: string): Promise<void>;
  /** Keep audio (#687): kept until the User deletes it, with one Undo that lets it go again. */
  keepAudio(meetingId: string): Promise<void>;
  /** Tries the Meeting's Transcript again after a problem: the model's download, its engine, or saving it. */
  retryTranscript(meetingId: string): Promise<void>;
  /** Fills the notes in from the Transcript again (#142): Try again, or after an Undo. */
  fillNotes(meetingId: string): Promise<void>;
  stopNotes(meetingId: string): Promise<void>;
  /**
   * Takes back what filling the notes in added (#142). `editor`: the one whose line asks, which
   * takes the fill back itself while it holds it on top.
   */
  undoFill(meetingId: string, editor?: object): Promise<void>;
  /** The fill was taken back, or put back, with an editor's own Undo: the core follows. */
  followFillUndo(meetingId: string, undone: boolean): Promise<void>;
  openSettings(meetingId: string, source: AudioSource): Promise<void>;
  dismissGaps(meetingId: string): void;
  /** Shows or hides a Meeting's recording details; with no `shown`, the other way from now. */
  showDetails(meetingId: string, shown?: boolean): void;
  /**
   * Choose window…: IncarnaMind's picker with the windows it can read; on
   * macOS, the first time, the bar first says why macOS will ask.
   */
  chooseScreen(meetingId: string): Promise<void>;
  /** Reads the window chosen in IncarnaMind's picker, which closes. */
  readScreen(meetingId: string, windowId: string): Promise<void>;
  closeScreenPicker(): void;
  /** Not this time: the meeting bar stops asking. */
  declineScreen(meetingId: string): Promise<void>;
  stopScreen(meetingId: string): Promise<void>;
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

  const onAudio = async (meetingId: string, action: () => Promise<unknown>) => {
    set((state) => ({ audioProblems: withoutKey(state.audioProblems, meetingId) }));
    try {
      await action();
    } catch (error) {
      set((state) => ({
        audioProblems: {
          ...state.audioProblems,
          [meetingId]: errorMessage(error, translateNow),
        },
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

  /** A Meeting just made, shown (`show`) and started at once, the first time too (#3762). */
  const startMade = async (meeting: Meeting, show: () => Promise<unknown>) => {
    set((state) => ({ starting: { ...state.starting, [meeting.id]: true } }));
    // The notes come first in a meeting: the text has the cursor, as in a Mind made with ⌘T.
    useAppStore.setState({ bodyToFocus: meeting.mindId });
    await show();
    await get().start(meeting.id, meeting.systemAudio);
    // The core's event can come after start() returns, and showing the start block between
    // would flash it: the Meeting leaves "starting" with its status, or here if the start failed.
    if (meeting.id in get().problems) set(stopStarting(meeting.id));
  };

  return {
    meetings: [],
    problems: {},
    audioProblems: {},
    cantRecord: false,
    starting: {},
    startToFocus: null,
    gapsSeen: {},
    detailsShown: {},
    screenPicker: null,
    screenExplained: {},

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
        const folderId = folderInView(layout, minds);
        const meeting = await core.createMeeting(folderId ? { folderId } : undefined);
        created = meeting.id;
        await startMade(meeting, () =>
          // A tab of its own, as New Mind opens one: never in place of the Mind the User is in.
          useAppStore.getState().changeLayout({
            type: "open",
            item: { kind: "mind", mindId: meeting.mindId },
            where: { in: "group" },
          }),
        );
      } catch (error) {
        useAppStore.getState().reportError(error);
        if (created) set({ ...stopStarting(created)(get()), startToFocus: null });
      }
    },

    async recordIn(mindId) {
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
      let created: string | null = null;
      try {
        const meeting = await core.createMeeting({ mindId });
        created = meeting.id;
        // Listed at once, so the Note shows its start or its bar from the next paint.
        set((state) => ({
          meetings: [meeting, ...state.meetings.filter((each) => each.id !== meeting.id)],
        }));
        await startMade(meeting, async () => undefined);
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
      await memoNow();
    },

    clearCantRecord: () => set({ cantRecord: false }),

    async start(meetingId, systemAudio) {
      await attempt(meetingId, () => core.startMeeting({ meetingId, systemAudio }));
    },

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
    deleteAudio: (meetingId) => onAudio(meetingId, () => core.deleteMeetingAudio(meetingId)),
    keepAudio: (meetingId) =>
      onAudio(meetingId, async () => {
        const keep = (kept: boolean) => async () => {
          await core.keepMeetingAudio({ meetingId, kept });
        };
        await keep(true)();
        // Taken back past the day's end, the audio goes at the next sweep, as it would have.
        useUndo.getState().push({
          said: (t) => t("meetings.audio.keptLine"),
          name: (t) => t("meetings.command.keepAudio"),
          undo: keep(false),
          redo: keep(true),
        });
      }),
    retryTranscript: (meetingId) => attempt(meetingId, () => core.retryTranscript(meetingId)),
    stopNotes: (meetingId) => attempt(meetingId, () => core.stopMeetingNotes(meetingId)),
    fillNotes: (meetingId) =>
      attempt(meetingId, async () => {
        // At once, before the core says it fills: ⇧⌘Z can't put the old fill back beside the new.
        // The core fills anew only after an Undo it knows of, which a failed follow left it without.
        if (letGoOfUndoneFill(meetingId)) {
          await core.followMeetingFillUndo({ meetingId, undone: true });
        }
        await core.fillMeetingNotes(meetingId);
      }),
    // An editor showing the Note holds a fill it took in as its own step: Undo is that step's.
    undoFill: (meetingId, editor) =>
      attempt(meetingId, async () => {
        if (!(await undoFillInEditor(meetingId, editor))) await core.undoMeetingFill(meetingId);
      }),
    followFillUndo: (meetingId, undone) =>
      attempt(meetingId, () => core.followMeetingFillUndo({ meetingId, undone })),
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
    async chooseScreen(meetingId) {
      const meeting = get().meetings.find((each) => each.id === meetingId);
      // macOS asks for Screen Recording the first time: the bar says why before it does.
      if (meeting?.screen?.permission === "not-asked" && !get().screenExplained[meetingId]) {
        set((state) => ({ screenExplained: { ...state.screenExplained, [meetingId]: true } }));
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
        );
        if (!get().meetings.some((each) => each.id === meetingId && each.status === "recording"))
          return;
      }
      set({ screenPicker: { meetingId, windows: null } });
      await attempt(meetingId, async () => {
        try {
          const windows = await core.listShareableWindows(meetingId);
          set((state) =>
            state.screenPicker?.meetingId !== meetingId
              ? {}
              : { screenPicker: windows ? { meetingId, windows } : null },
          );
        } catch (error) {
          set({ screenPicker: null });
          throw error;
        }
      });
    },
    async readScreen(meetingId, windowId) {
      set({ screenPicker: null });
      await attempt(meetingId, () => core.readSharedScreen({ meetingId, windowId }));
    },
    closeScreenPicker: () => set({ screenPicker: null }),
    declineScreen: (meetingId) => attempt(meetingId, () => core.declineSharedScreen(meetingId)),
    stopScreen: (meetingId) => attempt(meetingId, () => core.stopSharedScreen(meetingId)),
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
    // The editor showing the Note took it in as its own Undo, with its line there.
    if (meeting.fill?.state !== "filled" || fillHeldInEditor(meeting.id)) continue;
    const was = before.find((each) => each.id === meeting.id)?.fill?.state;
    if (was === undefined || was === "filled") continue;
    const memo = meeting.kind === "memo";
    useUndo.getState().push({
      said: (t) =>
        t(
          memo
            ? "memos.fill.filled"
            : isPartialMeetingFill(meeting.fill)
              ? "meetings.fill.partial"
              : "meetings.fill.filled",
        ),
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

/**
 * A Meeting's Note the host shows, from the tray or an offer taken there. A window made for it opens
 * on Home as its load ends, so the Note goes in front once that is done.
 */
function showNotes(mindId: string): void {
  const loading = (state: AppState) => state.status.kind === "loading";
  if (!loading(useAppStore.getState())) {
    useAppStore.getState().openMind(mindId);
    return;
  }
  const stop = useAppStore.subscribe((state) => {
    if (loading(state)) return;
    stop();
    if (state.status.kind === "ready") state.openMind(mindId);
  });
}

core.on("meetings.notesShown", ({ mindId }) => showNotes(mindId));

core.on("meetings.changed", (meetings) => {
  offerUndoOfFill(useMeetings.getState().meetings, meetings);
  useMeetings.setState((state) => ({
    meetings,
    screenPicker: meetings.some(
      (meeting) => meeting.id === state.screenPicker?.meetingId && meeting.status === "recording",
    )
      ? state.screenPicker
      : null,
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
export const isLive = (
  meeting: Meeting | undefined,
): meeting is Meeting & { status: "recording" | "paused" } =>
  meeting?.status === "recording" || meeting?.status === "paused";

/** It is recording, but the system's microphone prompt is still open: nothing is captured yet. */
export const isWaitingForPermission = (meeting: Meeting | undefined): boolean =>
  meeting?.status === "recording" && meeting.sources.microphone === "waiting";

/**
 * The frame ids that recording Meetings still retain for Citations.
 */
export const useKeptScreens = (): string[] =>
  useMeetings(
    useShallow((state) => state.meetings.flatMap((meeting) => meeting.screen?.retained ?? [])),
  );

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
