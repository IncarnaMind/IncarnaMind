/**
 * A Meeting's shared screen (ADR-0031, #834): one window the User chooses
 * while the Meeting records, read as text on this computer each time what it
 * shows changes and settles (./screenChanges), so a Question asked during the
 * call can go with the screens' text and its Answer cite them. Everything is
 * held here, in memory: the frames, their text, and the Library Passages each
 * one matches. Nothing is written anywhere, and all of it is forgotten when
 * the Meeting stops, its Mind is deleted or IncarnaMind quits.
 *
 * Each settled picture is read twice, a second apart, so the figures the two
 * readings disagree on can be marked unsure (./screenText). A picture whose
 * text is the same as the screen before (a cursor moved, a video tile
 * changed) adds nothing.
 */
import { randomUUID } from "node:crypto";
import type {
  Logger,
  PagePicture,
  RecognizedLine,
  ScreenCapture,
  ScreenFrame,
  ScreenSession,
} from "../adapters";
import { ScreenCaptureError } from "../adapters";
import type { LiveTranscript } from "../answers/liveTranscript";
import type {
  EmbeddingModelStatus,
  MeetingScreen,
  ShareableWindow,
  SharedScreenFrame,
  SharedScreenProblem,
} from "../api";
import { isStopword, keywordText } from "../documents/keywords";
import type { WindowedPassage } from "../documents/search";
import { InvalidInputError } from "../errors";
import { createScreenChanges, type ScreenChanges } from "./screenChanges";
import { type LineBox, markedText, type ScreenText, screenText } from "./screenText";

/** How long after the first reading the second one is made. */
const SECOND_READING_MS = 1000;
/** The screens kept per Meeting; the oldest go first. */
const MAX_SCREENS = 200;
/** The newest screens whose pictures are kept, for their Citations' cards. */
const MAX_PICTURE_BYTES = 32 * 1024 * 1024;
/** The screens a Question goes with: the one showing now, and those most like the Question. */
const SCREENS_PER_QUESTION = 3;
/** A screen matches a Library Passage when this share of its words, and this many at least, are in it. */
const LIBRARY_SHARE = 0.6;
const LIBRARY_WORDS = 6;
/** Library Passages kept for a screen. */
const LIBRARY_MATCHES = 2;

/** What reading the screen needs from the text recognition model (../documents/scan). */
export interface ScreenReader {
  read(picture: PagePicture, page: number): Promise<RecognizedLine[]>;
  status(): EmbeddingModelStatus;
}

export interface SharedScreensOptions {
  capture: ScreenCapture;
  reader: ScreenReader;
  now: () => string;
  /** Whether a recording that starts asks to read the shared screen (Settings › Meetings). */
  asks(): boolean;
  pictureLimit(): number;
  providerId(mindId: string): string | null;
  /** Keyword search of the Library for a screen's text, best first. */
  searchLibrary(meetingId: string, text: string): Promise<WindowedPassage[]>;
  /** A Library Passage, if it is still there. */
  passage(meetingId: string, passageId: string): WindowedPassage | null;
  changed(): void;
  log: Logger;
}

interface Screen extends ScreenText {
  id: string;
  selection: AbortSignal;
  at: string;
  window: string;
  image: ScreenFrame["image"];
  library: string[];
}

/** One Meeting's shared screen, while it records or is paused. */
interface Shared {
  meetingId: string;
  memory: string;
  selection: AbortController;
  picturesSent: number;
  explainedModel: boolean;
  state: MeetingScreen["state"];
  window: string | null;
  /** The window chosen in IncarnaMind's picker: read again after a pause. */
  chosen: Pick<ShareableWindow, "id" | "name"> | null;
  listed: Map<string, string>;
  problem: SharedScreenProblem | null;
  session: ScreenSession | null;
  changes: ScreenChanges;
  screens: Screen[];
  /** A picture is being read. */
  reading: ScreenSession | null;
  /** The text recognition model is downloading or failed, while a picture waits to be read. */
  waitingForModel: boolean;
  /** Readings so far: each picture's number for the recogniser, and its screen's. */
  readings: number;
  /** Waiting for a later sample: resolve with it, or with null when the capture stops. */
  waiters: Set<(sample: { thumbnail: PagePicture; at: number } | null) => void>;
}

const wordsOf = (text: string): Set<string> =>
  new Set(
    keywordText(text)
      .split(" ")
      .filter((word) => word !== "" && !isStopword(word)),
  );

const samePixels = (a: PagePicture, b: PagePicture) =>
  a.width === b.width &&
  a.height === b.height &&
  a.pixels.length === b.pixels.length &&
  a.pixels.every((value, index) => value === b.pixels[index]);

/** Two readings of a picture whose text is the same: nothing new was shown. */
const sameText = (a: string, b: string) => keywordText(a) === keywordText(b);

function needsPicture(screen: ScreenText): boolean {
  if (screen.unsure.length) return true;
  const labelledFigures = screen.text
    .split("\n")
    .filter((line) => /\d/.test(line) && /[\p{L}]{2}/u.test(line));
  return (
    screen.text.length < 48 &&
    labelledFigures.length < 2 &&
    !/[0-9][.,0-9]*(?:%|\s*(?:billion|million|元|亿|万)|[km]\b)/iu.test(screen.text)
  );
}

export type SharedScreens = ReturnType<typeof createSharedScreens>;

export function createSharedScreens(options: SharedScreensOptions) {
  const { capture, reader, log } = options;
  const clock = () => Date.parse(options.now());
  const meetings = new Map<string, Shared>();
  let opening: Promise<void> = Promise.resolve();

  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

  function sharedOf(meetingId: string): Shared {
    const shared = meetings.get(meetingId);
    if (!shared) throw new InvalidInputError({ key: "error.meeting.notRecording" });
    return shared;
  }

  function set(shared: Shared, change: Partial<Pick<Shared, "state" | "window" | "problem">>) {
    Object.assign(shared, change);
    options.changed();
  }

  /** Stops capturing: whatever waited for a sample gives up. What was read stays. */
  function endSession(shared: Shared): void {
    shared.listed.clear();
    shared.selection.abort();
    shared.selection = new AbortController();
    const session = shared.session;
    shared.session = null;
    shared.reading = null;
    shared.waitingForModel = false;
    session?.stop();
    for (const waiter of shared.waiters) waiter(null);
    shared.waiters.clear();
  }

  /** The next sample at least `ms` after `after`, or null if the capture stops first. */
  function sampleAfter(shared: Shared, after: number, ms: number) {
    return new Promise<{ thumbnail: PagePicture; at: number } | null>((resolve) => {
      const waiter = (sample: { thumbnail: PagePicture; at: number } | null) => {
        if (sample && sample.at - after < ms) return;
        shared.waiters.delete(waiter);
        resolve(sample);
      };
      shared.waiters.add(waiter);
    });
  }

  /** The Library Passages a screen's text is from: most of its words are in them. */
  async function libraryFor(meetingId: string, text: string): Promise<string[]> {
    const words = wordsOf(text);
    if (words.size < LIBRARY_WORDS) return [];
    const found = await options.searchLibrary(meetingId, text);
    return found
      .filter((passage) => {
        const held = wordsOf(passage.text);
        let both = 0;
        for (const word of words) if (held.has(word)) both++;
        return both / words.size >= LIBRARY_SHARE;
      })
      .slice(0, LIBRARY_MATCHES)
      .map((passage) => passage.passageId);
  }

  /** Reads what the window shows now, twice, and keeps it as a screen if it shows something new. */
  async function readNow(shared: Shared, session: ScreenSession) {
    shared.reading = session;
    try {
      const first: ScreenFrame = await session.grab(true);
      if (shared.session !== session) return;
      const firstAt = clock();
      const page = ++shared.readings;
      const read = async (frame: ScreenFrame) => {
        const status = reader.status().state;
        if (status !== "ready" && !shared.waitingForModel) {
          shared.waitingForModel = true;
          options.changed();
        }
        try {
          return await reader.read(frame.picture, page);
        } finally {
          if (shared.session === session && shared.waitingForModel) {
            shared.waitingForModel = false;
            options.changed();
          }
        }
      };
      const firstLines = await read(first);
      if (shared.session !== session) return;
      const later = await sampleAfter(shared, firstAt, SECOND_READING_MS);
      if (!later || shared.session !== session) return;
      // It moved since: it is read once it settles again.
      if ((shared.changes.changedAt ?? 0) > firstAt) return;
      const second = await session.grab(false);
      if (shared.session !== session) return;
      const secondLines = samePixels(first.picture, second.picture) ? null : await read(second);
      if (shared.session !== session) return;
      shared.changes.read(later.thumbnail);
      const text = screenText(firstLines, secondLines, first.picture);
      const last = shared.screens.at(-1);
      if (
        last?.selection === shared.selection.signal &&
        !needsPicture(text) &&
        sameText(last.text, text.text)
      )
        return;
      // Matched to the Library first, by the local search: a Question asked next has both.
      const library = await libraryFor(shared.meetingId, text.text).catch((error: unknown) => {
        log.warn("meeting.screenLibraryFailed", { message: describe(error) });
        return [];
      });
      if (shared.session !== session) return;
      shared.screens.push({
        ...text,
        id: `${shared.memory}/${page}`,
        selection: shared.selection.signal,
        at: new Date(firstAt).toISOString(),
        window: session.name,
        image: first.image,
        library,
      });
      if (shared.screens.length > MAX_SCREENS) shared.screens.shift();
      let retainedBytes = 0;
      for (let i = shared.screens.length - 1; i >= 0; i--) {
        const past = shared.screens[i];
        if (!past?.image) continue;
        retainedBytes += past.image.bytes;
        if (retainedBytes > MAX_PICTURE_BYTES) past.image = null;
      }
      log.info("meeting.screenRead", {
        meetingId: shared.meetingId,
        lines: text.lines.length,
        unsure: text.unsure.length,
        library: library.length,
      });
      options.changed();
    } catch (error) {
      if (shared.session !== session) return;
      log.error("meeting.screenReadFailed", {
        meetingId: shared.meetingId,
        message: describe(error),
      });
      endSession(shared);
      shared.chosen = null;
      set(shared, { state: "off", window: null, problem: "failed" });
    } finally {
      if (shared.reading === session) shared.reading = null;
    }
  }

  function sampled(shared: Shared, session: ScreenSession, thumbnail: PagePicture): void {
    if (shared.session !== session) return;
    const at = clock();
    const due = shared.changes.sample(thumbnail, at);
    for (const waiter of [...shared.waiters]) waiter({ thumbnail, at });
    if (due && !shared.reading) void readNow(shared, session);
  }

  /** Starts reading the window with `windowId`. */
  function startReading(
    shared: Shared,
    window: Pick<ShareableWindow, "id" | "name">,
  ): Promise<void> {
    endSession(shared);
    const selection = shared.selection.signal;
    shared.chosen = window;
    set(shared, { state: "choosing", window: null, problem: null });
    const next = () => openSelected(shared, window, selection);
    opening = opening.then(next, next);
    return opening;
  }

  async function openSelected(
    shared: Shared,
    window: Pick<ShareableWindow, "id" | "name">,
    selection: AbortSignal,
  ): Promise<void> {
    if (selection.aborted) return;
    let session: ScreenSession | null = null;
    try {
      session = await capture.start(
        window,
        {
          sample: (thumbnail) => {
            if (session) sampled(shared, session, thumbnail);
          },
          ended: () => {
            if (!session || shared.session !== session) return;
            log.info("meeting.screenEnded", { meetingId: shared.meetingId });
            endSession(shared);
            shared.chosen = null;
            set(shared, { state: "off", window: null, problem: "closed" });
          },
        },
        selection,
      );
    } catch (error) {
      const problem = error instanceof ScreenCaptureError ? error.reason : "failed";
      log.warn("meeting.screenRefused", { meetingId: shared.meetingId, problem });
      if (!selection.aborted) {
        shared.chosen = null;
        set(shared, { state: "off", window: null, problem });
      }
      return;
    }
    if (selection.aborted) {
      session.stop();
      return;
    }
    shared.session = session;
    shared.changes = createScreenChanges();
    shared.chosen = window;
    log.info("meeting.screenStarted", { meetingId: shared.meetingId });
    set(shared, { state: "reading", window: session.name, problem: null });
  }

  return {
    /**
     * The windows IncarnaMind's picker offers a recording Meeting; null when
     * the system doesn't let IncarnaMind capture one, which its line then says.
     */
    async windows(meetingId: string): Promise<ShareableWindow[] | null> {
      const shared = sharedOf(meetingId);
      const selection = shared.selection.signal;
      shared.listed.clear();
      try {
        const windows = await capture.windows();
        if (selection.aborted) return null;
        shared.listed = new Map(windows.map((window) => [window.id, window.name]));
        return windows;
      } catch (error) {
        if (!(error instanceof ScreenCaptureError) || error.reason !== "denied") throw error;
        log.warn("meeting.screenNotAllowed", { meetingId });
        set(shared, { state: "off", window: null, problem: "denied" });
        return null;
      }
    },

    /** The Meeting's shared screen, while it records or is paused; null when it has none. */
    of(meetingId: string, mindId: string): MeetingScreen | null {
      const shared = meetings.get(meetingId);
      if (!shared) return null;
      const status = reader.status();
      const permission = capture.permission();
      return {
        state: shared.state,
        window: shared.window,
        problem: shared.problem === "denied" && permission === "granted" ? null : shared.problem,
        memory: shared.memory,
        providerId: options.providerId(mindId),
        screens: shared.screens.length,
        retained: shared.screens.map((screen) => screen.id),
        permission,
        model: shared.waitingForModel && status.state !== "ready" ? status : null,
      };
    },

    /**
     * Recording started or resumed: the bar asks, the first time, whether
     * someone will share; a window read before a pause is read again where
     * IncarnaMind knows which it was.
     */
    begin(meetingId: string): void {
      const shared = meetings.get(meetingId);
      if (!shared) {
        meetings.set(meetingId, {
          meetingId,
          memory: randomUUID(),
          selection: new AbortController(),
          picturesSent: 0,
          explainedModel: false,
          state: options.asks() ? "ask" : "off",
          window: null,
          chosen: null,
          listed: new Map(),
          problem: null,
          session: null,
          changes: createScreenChanges(),
          screens: [],
          reading: null,
          waitingForModel: false,
          readings: 0,
          waiters: new Set(),
        });
        return;
      }
      if (shared.chosen !== null && shared.session === null && shared.state === "off") {
        void startReading(shared, shared.chosen);
      }
    },

    /** Recording paused (or the computer slept): nothing is captured until it records again. */
    pause(meetingId: string): void {
      const shared = meetings.get(meetingId);
      if (!shared) return;
      endSession(shared);
      // The window stays chosen, to be read again on Resume.
      set(shared, { state: "off", window: null });
    },

    /** The Meeting stopped, or its Mind was deleted: everything from its screen is forgotten. */
    forget(meetingId: string): void {
      const shared = meetings.get(meetingId);
      if (!shared) return;
      endSession(shared);
      meetings.delete(meetingId);
      log.info("meeting.screenForgotten", { meetingId, screens: shared.screens.length });
      shared.screens.length = 0;
    },

    /** Reads one window of a recording Meeting (see `CoreApi.readSharedScreen`). */
    async read(meetingId: string, windowId: unknown): Promise<void> {
      const shared = sharedOf(meetingId);
      if (typeof windowId !== "string" || windowId === "") {
        throw new InvalidInputError({ key: "error.meeting.noWindow" });
      }
      const name = shared.listed.get(windowId);
      if (name === undefined) throw new InvalidInputError({ key: "error.meeting.noWindow" });
      await startReading(shared, { id: windowId, name });
    },

    /** Not this time: the bar stops asking. */
    decline(meetingId: string): void {
      const shared = sharedOf(meetingId);
      if (shared.state === "ask") set(shared, { state: "off" });
    },

    /** Stops reading; what was read stays until the Meeting stops. */
    stop(meetingId: string): void {
      const shared = sharedOf(meetingId);
      endSession(shared);
      shared.chosen = null;
      set(shared, { state: "off", window: null, problem: null });
    },

    /**
     * The screens a Question asked now goes with: the newest, and the others
     * most like the Question, at most `SCREENS_PER_QUESTION`, in the order read.
     */
    forQuestion(meetingId: string, question: string): LiveTranscript["screen"] {
      const shared = meetings.get(meetingId);
      if (!shared?.session || shared.state !== "reading") return undefined;
      const selection = shared.selection.signal;
      const available = shared.screens.filter((screen) => screen.selection === selection);
      const newest = available.at(-1);
      if (!newest) return undefined;
      const asked = wordsOf(question);
      const scored = available
        .slice(0, -1)
        .map((screen, index) => {
          const words = wordsOf(screen.text);
          let score = 0;
          for (const word of asked) if (words.has(word)) score++;
          return { screen, index, score };
        })
        .filter((each) => each.score > 0)
        .sort((a, b) => b.score - a.score || b.index - a.index)
        .slice(0, SCREENS_PER_QUESTION - 1)
        .sort((a, b) => a.index - b.index)
        .map((each) => each.screen);
      const readings = [...scored, newest].map((screen) => ({
        id: screen.id,
        at: screen.at,
        window: screen.window,
        text: screen.text,
        marked: markedText(screen),
        library: screen.library.flatMap((passageId) => options.passage(meetingId, passageId) ?? []),
      }));
      const visual = needsPicture(newest);
      const refers =
        /\b(?:this|that|the) (?:chart|diagram|picture|slide|screen|graph)\b|(?:这|那)(?:张图|张幻灯片|个图表)|屏幕上|看一下屏幕/iu.test(
          question,
        );
      return {
        readings,
        ended: selection,
        firstTextOnlyAnswer() {
          if (shared.explainedModel) return false;
          shared.explainedModel = true;
          return true;
        },
        mostlyVisual: visual,
        refersToScreen: refers,
        picture() {
          if (selection.aborted || !newest.image) return { state: "text" };
          if (shared.picturesSent >= options.pictureLimit()) return { state: "limit" };
          shared.picturesSent++;
          return {
            state: "sent",
            data: newest.image.jpeg(),
            id: newest.id,
            refund() {
              shared.picturesSent--;
            },
          };
        },
      };
    },

    /** A screen still kept, with the quote between `from` and `to` (see `CoreApi.getSharedScreen`). */
    frame(id: string, from: number, to: number): SharedScreenFrame | null {
      for (const shared of meetings.values()) {
        const screen = shared.screens.find((each) => each.id === id);
        if (!screen) continue;
        const start = Math.max(0, Math.min(from, screen.text.length));
        const end = Math.max(start, Math.min(to, screen.text.length));
        const boxes: LineBox[] = screen.lines
          .filter((line) => end > start && line.start < end && line.end > start)
          .map((line) => line.box);
        return {
          id: screen.id,
          at: screen.at,
          window: screen.window,
          image: screen.image
            ? `data:image/jpeg;base64,${Buffer.from(screen.image.jpeg()).toString("base64")}`
            : "",
          quote: screen.text.slice(start, end),
          boxes,
        };
      }
      return null;
    },

    /** Whether a picture waits for the text recognition model to download or start. */
    waitingForModel: (): boolean => [...meetings.values()].some((shared) => shared.waitingForModel),

    /** IncarnaMind is closing: every capture stops, and nothing is kept. */
    close(): void {
      for (const meetingId of [...meetings.keys()]) this.forget(meetingId);
    },
  };
}
