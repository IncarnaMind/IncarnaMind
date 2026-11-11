/**
 * The line at the head of a Meeting's Transcript (#1031): what the Transcript is, from its first
 * line on, and how to hear a word only while a click plays one. With no lines the view's own
 * sentence stands alone, without the head line or a count, and under a problem in the recording
 * bar that sentence promises no lines as people speak. The two views that show a Transcript run
 * against a small DOM, the Transcript's file served to them by the test.
 */
import { DOMParser } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Document, Meeting } from "../../src/core/api";
import type { ViewerTarget } from "../../src/renderer/src/store";

const ONE_LINE = [
  "WEBVTT",
  "",
  "00:00:01.000 --> 00:00:04.000",
  "<v Dana>We agreed to raise the wall by forty centimetres.",
  "",
].join("\n");
const TWO_LINES = [
  ONE_LINE,
  "00:00:05.000 --> 00:00:08.000",
  "<v Sam>Not before the survey is back.",
  "",
].join("\n");
const NO_LINES = "WEBVTT\n";

let file = TWO_LINES;

class FileRequest {
  status = 200;
  responseType = "";
  response: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  send() {
    this.response = new TextEncoder().encode(file).buffer as ArrayBuffer;
    queueMicrotask(() => this.onload?.());
  }
  abort() {}
}

let root: Root | null = null;
let container: HTMLElement;

beforeEach(async () => {
  file = TWO_LINES;
  const dom = new DOMParser().parseFromString(
    "<!doctype html><html><body></body></html>",
    "text/html",
  );
  const window = dom.defaultView;
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) => {
        if (name === "on") return each.on;
        if (name === "listApprovalRequests" || name === "listUserQuestions") {
          return () => Promise.resolve([]);
        }
        return () => Promise.resolve(undefined);
      },
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document: dom,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (run: () => void) => {
      run();
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    navigator: { platform: "Linux", languages: ["en"] },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    XMLHttpRequest: FileRequest,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = dom.createElement("div", {}) as HTMLElement;
  dom.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const TRANSCRIPT = {
  id: "transcript-1",
  name: "Transcript",
  title: "Transcript",
  path: "/tmp/Transcript.vtt",
  kind: "transcript",
  status: "ready",
  contentHash: "hash-1",
  failure: null,
  speakers: null,
  tags: [],
} as unknown as Document;

type TranscriptState = NonNullable<Meeting["transcript"]>["state"];
type TranscriptProblem = NonNullable<Meeting["transcript"]>["problem"];

/**
 * The problems a Transcript can have before Stop, as the core reports them: the engine can't start
 * or stopped again and again, and the speech model can't be downloaded. Each with the state it
 * comes in while recording and after Stop, and the recording bar's line for it.
 */
const PROBLEMS = {
  "transcription stopped": {
    problem: { kind: "engine", message: "" },
    recording: "behind",
    afterStop: "failed",
    line: { en: "Transcription stopped. · Try again", "zh-CN": "转写已停止。· 重试" },
  },
  "the speech model can't be downloaded": {
    problem: { kind: "download", message: "offline" },
    recording: "preparing",
    afterStop: "finishing",
    line: {
      en: "The speech model couldn’t be downloaded: offline · Try again",
      "zh-CN": "无法下载语音模型：offline · 重试",
    },
  },
} as const;

const EMPTY_SAYS = {
  en: {
    whenItStarts: "Lines appear here when transcription starts.",
    asPeopleSpeak: "Lines appear here as people speak.",
    nothing: "Nothing was transcribed.",
  },
  "zh-CN": {
    whenItStarts: "转写开始后，文字会出现在这里。",
    asPeopleSpeak: "有人说话时，文字会出现在这里。",
    nothing: "没有转写内容。",
  },
} as const;

/** A Meeting whose Transcript has this many lines: before its first, it has no Document yet. */
const meetingOf = (
  status: Meeting["status"],
  state: TranscriptState,
  audioKept: boolean,
  lines = 2,
  problem: TranscriptProblem = null,
) =>
  ({
    id: "meeting-1",
    kind: "meeting",
    status,
    mindId: "mind-1",
    recordedMs: 8000,
    microphonePausedAtMs: null,
    audio: { kept: audioKept, expiresAt: null, deletedAt: null, keptUntilDeleted: false },
    transcript: {
      documentId: lines > 0 ? TRANSCRIPT.id : null,
      state,
      lines,
      partials: [],
      separating: false,
      problem,
    },
  }) as unknown as Meeting;

const target = { documentId: TRANSCRIPT.id, request: 1 } as ViewerTarget;

const settled = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

async function setMeeting(meeting: Meeting | null, language: "en" | "zh-CN" = "en") {
  const { useAppStore } = await import("../../src/renderer/src/store");
  const { useMeetings } = await import("../../src/renderer/src/meetings");
  await act(() => {
    useAppStore.setState({ settings: { language, device: {} } as never });
    useMeetings.setState({ meetings: meeting ? [meeting] : [] });
  });
  await settled();
}

/** The Transcript in its Meeting's page, or as a Document in a tab of its own. */
async function show(where: "page" | "tab", meeting: Meeting | null) {
  // Variable paths, so the test's tsconfig (no jsx) leaves the components to the runtime.
  const viewPath = "../../src/renderer/src/viewer/TranscriptView.tsx";
  const headerPath = "../../src/renderer/src/viewer/ViewerHeader.tsx";
  const { TranscriptView, MeetingTranscriptView } = await import(viewPath);
  const { ViewerFrameContext } = await import(headerPath);
  const frame = {
    document: TRANSCRIPT,
    target,
    tabId: "tab-1",
    preview: false,
    embedded: where === "page",
    keep: () => undefined,
  };
  const view =
    where === "page" && meeting
      ? createElement(MeetingTranscriptView, {
          meeting,
          document: meeting.transcript?.documentId ? TRANSCRIPT : undefined,
          target,
        })
      : createElement(TranscriptView, { document: TRANSCRIPT, target });
  await act(() => root?.render(createElement(ViewerFrameContext.Provider, { value: frame }, view)));
  await settled();
}

/** What the recording bar says of the Meeting's Transcript, drawn in a root of its own. */
async function barLine(meeting: Meeting): Promise<string | null> {
  const linesPath = "../../src/renderer/src/components/TranscriptLines.tsx";
  const { TranscriptLines } = await import(linesPath);
  const bar = container.ownerDocument.createElement("div");
  container.ownerDocument.body.append(bar);
  const barRoot = createRoot(bar);
  await act(() => barRoot.render(createElement(TranscriptLines, { meeting })));
  await settled();
  const text = bar.querySelector('[data-testid="meeting-transcript-line"]')?.textContent ?? null;
  await act(() => barRoot.unmount());
  bar.remove();
  return text;
}

const part = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const head = () => part("transcript-head");
const lines = () => part("transcript-lines");
/** The header's word for a Transcript being made: "Live", or "Recording…" when it lags. */
const beingMade = () => (part("transcript-live") ?? part("transcript-behind"))?.textContent ?? null;

const WHAT = "Transcribed automatically. Names, numbers and “not” can be misheard.";
const WHOLE = `${WHAT} Click a word to play from there.`;
const WHAT_ZH = "自动转写，人名、数字和“不”字可能听错。";
const WHOLE_ZH = `${WHAT_ZH}点一个词，从那里开始播放。`;

describe("The line at the head of a Meeting's Transcript (#1031)", () => {
  // protects=the line says how to hear a word exactly while a click plays one: not while the Meeting records, its engine starts again, it is paused or the rest is still being transcribed, then once its Transcript is saved, and no longer once its audio is deleted; the first two sentences stay throughout; fails_when=the last sentence shows while recording or after the audio is gone, is missing on a saved Transcript with its audio, or the line itself goes in any of these; no_claim=that the click plays, which the window spec covers.
  test("says how to hear a word once the Transcript is saved, not while it records, and not once the audio is deleted", async () => {
    const recording = meetingOf("recording", "live", true);
    await setMeeting(recording);
    await show("page", recording);
    expect(lines()?.textContent).toContain("We agreed to raise the wall by forty centimetres.");
    expect(head()?.textContent).toBe(WHAT);
    expect(part("transcript-count")?.textContent).toBe("2 lines");

    await setMeeting(meetingOf("recording", "preparing", true));
    expect(head()?.textContent).toBe(WHAT);
    await setMeeting(meetingOf("paused", "live", true));
    expect(head()?.textContent).toBe(WHAT);
    await setMeeting(meetingOf("stopped", "finishing", true));
    expect(head()?.textContent).toBe(WHAT);

    await setMeeting(meetingOf("stopped", "saved", true));
    expect(head()?.textContent).toBe(WHOLE);

    await setMeeting(meetingOf("stopped", "saved", false));
    expect(head()?.textContent).toBe(WHAT);
    expect(lines()?.textContent).toContain("Not before the survey is back.");
  });

  // protects=the same line in Chinese, with nothing between its sentences, and before the first line the Chinese words that say it is live, alone; fails_when=either state reads otherwise in Chinese, a space follows the full stop, or the head line or a count shows in Chinese over no lines; no_claim=the wording's choice.
  test("reads the same in Chinese", async () => {
    const beforeItsFirstLine = meetingOf("recording", "live", true, 0);
    await setMeeting(beforeItsFirstLine, "zh-CN");
    await show("page", beforeItsFirstLine);
    expect(beingMade()).toBe("实时");
    expect(part("transcript-empty")?.textContent).toBe("有人说话时，文字会出现在这里。");
    expect(head()).toBeNull();
    expect(part("transcript-count")).toBeNull();

    const saved = meetingOf("stopped", "saved", true);
    await setMeeting(saved, "zh-CN");
    await show("page", saved);
    expect(part("transcript-count")?.textContent).toBe("2 句");
    expect(head()?.textContent).toBe(WHOLE_ZH);
    await setMeeting(meetingOf("stopped", "saved", false), "zh-CN");
    expect(head()?.textContent).toBe(WHAT_ZH);
  });

  // protects=while a Meeting's Transcript has no lines the view says so in its own sentence alone, with no head line and no "0 lines" beside it: recording before the first line it still says it is live and that lines appear as people speak, with live text fallen behind it keeps "Recording…", and stopped with nothing transcribed or a failure it says nothing was transcribed; from the first line the count and the head line show in the same state; fails_when=the head line or a count shows over no lines, the words that say transcription is running go with the count, or either stays hidden once a line is there; no_claim=the sentence under a problem in the recording bar, which the test below covers.
  test.each<[string, Meeting["status"], TranscriptState, string | null, string, string]>([
    [
      "records before its first line",
      "recording",
      "live",
      "Live",
      "Lines appear here as people speak.",
      WHAT,
    ],
    [
      "records with live text fallen behind",
      "recording",
      "behind",
      "Recording…",
      "Lines appear here as people speak.",
      WHAT,
    ],
    ["is empty", "stopped", "empty", null, "Nothing was transcribed.", WHOLE],
    ["failed", "stopped", "failed", null, "Nothing was transcribed.", WHAT],
  ])(
    "a Transcript that %s has no head line and no count, and both from its first line",
    async (_name, status, state, running, says, headWithALine) => {
      const withoutLines = meetingOf(status, state, true, 0);
      await setMeeting(withoutLines);
      await show("page", withoutLines);
      expect(part("transcript-empty")?.textContent).toBe(says);
      expect(beingMade()).toBe(running);
      expect(head()).toBeNull();
      expect(part("transcript-count")).toBeNull();

      file = ONE_LINE;
      const withALine = meetingOf(status, state === "empty" ? "saved" : state, true, 1);
      await setMeeting(withALine);
      await show("page", withALine);
      expect(lines()?.textContent).toContain("We agreed to raise the wall by forty centimetres.");
      expect(part("transcript-empty")).toBeNull();
      expect(part("transcript-count")?.textContent).toBe("1 line");
      expect(head()?.textContent).toBe(headWithALine);
      expect(beingMade()).toBe(running);
    },
  );

  // protects=under a problem with Try again in the recording bar an empty Transcript promises no lines as people speak: while the Meeting records or is paused it says they appear when transcription starts, in English and Chinese, for each problem there is before Stop (transcription stopped, the speech model can't be downloaded); the same Meeting without the problem says what it said, after Stop it says nothing was transcribed, and beside a first line neither sentence shows; fails_when=the old sentence stays under either problem line, the new one shows without a problem, after Stop or beside a line, or the view reads another fact than the one the bar's line is drawn from; no_claim=which failures the core reports as each problem, which the transcript's own tests cover.
  test.each([
    ["transcription stopped", "en"],
    ["transcription stopped", "zh-CN"],
    ["the speech model can't be downloaded", "en"],
    ["the speech model can't be downloaded", "zh-CN"],
  ] as const)(
    "while %s an empty Transcript says when lines appear, not that they come as people speak (%s)",
    async (name, language) => {
      const { problem, recording, afterStop, line } = PROBLEMS[name];
      const says = EMPTY_SAYS[language];
      const sentence = () => part("transcript-empty")?.textContent ?? null;

      const withProblem = meetingOf("recording", recording, true, 0, problem);
      await setMeeting(withProblem, language);
      await show("page", withProblem);
      expect(await barLine(withProblem)).toBe(line[language]);
      expect(sentence()).toBe(says.whenItStarts);
      expect(container.textContent).not.toContain(says.asPeopleSpeak);

      await setMeeting(meetingOf("paused", recording, true, 0, problem), language);
      expect(sentence()).toBe(says.whenItStarts);

      const noProblem = meetingOf("recording", recording, true, 0);
      await setMeeting(noProblem, language);
      expect(await barLine(noProblem)).not.toBe(line[language]);
      expect(sentence()).toBe(says.asPeopleSpeak);

      const stopped = meetingOf("stopped", afterStop, true, 0, problem);
      await setMeeting(stopped, language);
      expect(await barLine(stopped)).toBe(line[language]);
      expect(sentence()).toBe(says.nothing);

      file = ONE_LINE;
      const withALine = meetingOf("recording", recording, true, 1, problem);
      await setMeeting(withALine, language);
      await show("page", withALine);
      expect(await barLine(withALine)).toBe(line[language]);
      expect(lines()?.textContent).toContain("We agreed to raise the wall by forty centimetres.");
      expect(sentence()).toBeNull();
      expect(container.textContent).not.toContain(says.whenItStarts);
      expect(container.textContent).not.toContain(says.asPeopleSpeak);
    },
  );

  // protects=the Transcript opened as a Document carries the same line by the same rule, and a transcript file the User added, which no Meeting made, carries none; fails_when=the tab's view has no line or a different one, or an added file is said to be transcribed automatically; no_claim=the header's other controls.
  test("shows in the Transcript's own tab too, and not on a transcript file no Meeting made", async () => {
    await setMeeting(meetingOf("stopped", "saved", true));
    await show("tab", null);
    expect(head()?.textContent).toBe(WHOLE);
    await setMeeting(meetingOf("stopped", "saved", false));
    expect(head()?.textContent).toBe(WHAT);

    await setMeeting(null);
    expect(lines()?.textContent).toContain("We agreed to raise the wall by forty centimetres.");
    expect(part("transcript-count")?.textContent).toBe("2 lines");
    expect(head()).toBeNull();
  });

  // protects=a transcript file with no lines, opened as a Document, says nothing was transcribed and shows no "0 lines" beside it; fails_when=a count shows over no lines in the tab's view; no_claim=a file with lines, whose count the test above reads.
  test("shows no count on a transcript file with no lines", async () => {
    file = NO_LINES;
    await setMeeting(null);
    await show("tab", null);
    expect(part("transcript-empty")?.textContent).toBe("Nothing was transcribed.");
    expect(part("transcript-count")).toBeNull();
    expect(head()).toBeNull();
  });

  // protects=the line is the app's own, outside the Transcript's selectable text: the pane a selection covers holds every line said and none of the head line; fails_when=the head line is drawn inside the Transcript's text or its list of lines; no_claim=what the clipboard holds, which the window spec checks on a real selection.
  test("is not part of the Transcript's text", async () => {
    const saved = meetingOf("stopped", "saved", true);
    await setMeeting(saved);
    await show("page", saved);
    const text = container.querySelector('[data-testid="viewer-transcript"]');
    expect(text?.textContent).toContain("We agreed to raise the wall by forty centimetres.");
    expect(text?.textContent).toContain("Not before the survey is back.");
    expect(text?.textContent).not.toContain("Transcribed automatically");
    expect(text?.textContent).not.toContain("Click a word");
    expect(text?.contains(head())).toBe(false);
    expect(head()?.textContent).toBe(WHOLE);
  });
});
