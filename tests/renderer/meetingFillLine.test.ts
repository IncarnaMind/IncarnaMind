import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Meeting, MeetingFill } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import type { Undoable } from "../../src/renderer/src/undo";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const actions = vi.hoisted(() => {
  const language: { current: Language } = { current: "en" };
  const place: { current: { tabId: string; groupId: string } | null } = { current: null };
  const listeners = new Map<string, (payload: unknown) => void>();
  return {
    language,
    place,
    problems: {} as Record<string, string>,
    fillNotes: vi.fn(),
    undoFill: vi.fn(),
    showTranscript: vi.fn(),
    showMeetingNoteView: vi.fn(),
    listeners,
    push: vi.fn<(change: Undoable) => void>(),
    openMind: vi.fn(),
    undoMeetingFill: vi.fn(async (_meetingId: string) => undefined),
  };
});

vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey, params?: MessageParams) =>
    translate(actions.language.current, key, params),
  useLanguage: () => actions.language.current,
  translateNow: (key: MessageKey, params?: MessageParams) =>
    translate(actions.language.current, key, params),
}));
vi.mock("../../src/renderer/src/meetings", () => ({
  useMeetings: Object.assign(
    (select: (state: { problems: Record<string, string> }) => unknown) =>
      select({ problems: actions.problems }),
    { getState: () => actions },
  ),
}));
vi.mock("../../src/renderer/src/transcripts", () => ({
  showTranscript: actions.showTranscript,
}));
vi.mock("../../src/renderer/src/meetingViews", () => ({
  showMeetingNoteView: actions.showMeetingNoteView,
}));
vi.mock("../../src/renderer/src/components/DownloadSources", () => ({
  failedEverySource: () => false,
  useDownloadSources: () => ({}),
}));
vi.mock("../../src/renderer/src/components/tabs/tabItems", () => ({
  useTabPlace: () => actions.place.current,
}));
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: (name: string, listener: (payload: unknown) => void) => {
      actions.listeners.set(name, listener);
      return () => undefined;
    },
    undoMeetingFill: actions.undoMeetingFill,
  },
  files: {},
}));
vi.mock("../../src/renderer/src/layoutSlice", () => ({ currentMindIdOf: () => null }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ openMind: actions.openMind }) },
}));
vi.mock("../../src/renderer/src/undo", () => ({
  useUndo: { getState: () => ({ push: actions.push }) },
}));

let root: Root | null = null;
let container: HTMLElement;
let MeetingFillLine: ComponentType<{ meeting: Meeting; editor?: object }>;
/** The editor a line shows in, as MeetingFillAt passes it. */
const EDITOR = {};
let TranscriptLines: ComponentType<{ meeting: Meeting }>;

const fillOf = (fill: Partial<MeetingFill> = {}): MeetingFill => ({
  state: "filled",
  mode: "sections",
  local: false,
  problem: null,
  ...fill,
});

const meetingOf = (fill: MeetingFill | null): Meeting => ({
  id: "meeting-with-partial-notes",
  mindId: "meeting-note",
  kind: "meeting",
  status: "stopped",
  pausedBy: null,
  systemAudio: true,
  sources: { microphone: "off", system: "off" },
  recordedMs: 60_000,
  recordingSince: null,
  gaps: [],
  startedAt: "2026-11-04T10:00:00.000Z",
  stoppedAt: "2026-11-04T10:01:00.000Z",
  audio: { kept: false, expiresAt: null, deletedAt: null, keptUntilDeleted: false },
  saveError: null,
  transcript: {
    documentId: "actual-transcript-document",
    state: "saved",
    lines: 3,
    partials: [],
    model: null,
    cloud: null,
    fellBack: null,
    savedPath: null,
    separating: false,
    problem: null,
  },
  health: { realTimeFactor: null, measuredMs: 0, keepsUp: null, events: [] },
  microphonePausedAtMs: null,
  help: null,
  helps: [],
  helpTemplate: null,
  fill,
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:01:00.000Z",
});

beforeEach(async () => {
  vi.clearAllMocks();
  actions.problems = {};
  actions.language.current = "en";
  actions.place.current = { tabId: "meeting-tab", groupId: "meeting-group" };
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  for (const [name, value] of Object.entries({
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const componentPath = "../../src/renderer/src/components/MeetingFillLine.tsx";
  ({ MeetingFillLine } = await import(componentPath));
  const transcriptPath = "../../src/renderer/src/components/TranscriptLines.tsx";
  ({ TranscriptLines } = await import(transcriptPath));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

/** Fill steps an editor holds, as `followSteps` makes them: done and on top until told otherwise. */
function heldSteps() {
  const listeners = new Set<() => void>();
  const steps = {
    now: "done" as "done" | "undone",
    top: true,
    state: () => steps.now,
    onTop: () => steps.now === "done" && steps.top,
    add: () => undefined,
    undo: vi.fn(() => undefined),
    observe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tell: () => {
      for (const listener of listeners) listener();
    },
  };
  return steps;
}

async function show(meeting: Meeting) {
  await act(async () => root?.render(createElement(MeetingFillLine, { meeting, editor: EDITOR })));
  return container.querySelector('[data-testid="meeting-fill-line"]');
}

async function click(testId: string) {
  const button = container.querySelector(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`Missing action: ${testId}`);
  await act(async () => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

describe("meeting notes with unfinished Transcript parts", () => {
  test.each([
    [
      "en",
      1,
      "Note partly filled in · 1 Transcript part couldn’t be finished · View Transcript · Undo",
    ],
    [
      "en",
      3,
      "Note partly filled in · 3 Transcript parts couldn’t be finished · View Transcript · Undo",
    ],
    ["zh-CN", 1, "笔记未能全部补全 · 1 段转写稿未处理完 · 查看转写稿 · 撤销"],
    ["zh-CN", 3, "笔记未能全部补全 · 3 段转写稿未处理完 · 查看转写稿 · 撤销"],
  ] as const)(
    "counts %s unfinished parts (%i), not unknown items or quote failures",
    async (language, unfinishedParts, text) => {
      actions.language.current = language;
      const meeting = meetingOf(
        fillOf({
          unfinishedParts,
          problem: { kind: "model", message: "provider diagnostic" },
        }),
      );
      const line = await show(meeting);
      expect(line?.textContent).toBe(text);
      expect(line?.getAttribute("title")).toBeNull();
      await click("meeting-fill-undo");
      expect(actions.undoFill.mock.calls).toEqual([[meeting.id, EDITOR]]);
    },
  );

  test.each([
    [
      "en",
      "Note partly filled in · 1 item couldn’t be added · 2 Transcript parts couldn’t be finished · View Transcript · Undo",
    ],
    ["zh-CN", "笔记未能全部补全 · 1 项内容未能添加 · 2 段转写稿未处理完 · 查看转写稿 · 撤销"],
  ] as const)(
    "reports both actual counts in %s when both problems occurred",
    async (language, text) => {
      actions.language.current = language;
      const line = await show(meetingOf(fillOf({ omitted: 1, unfinishedParts: 2 })));
      expect(line?.textContent).toBe(text);
      expect(line?.querySelectorAll("button")).toHaveLength(2);
    },
  );
});

describe("meeting notes with omitted items", () => {
  test.each([
    ["en", 1, "Note partly filled in · 1 item couldn’t be added · View Transcript · Undo"],
    ["en", 2, "Note partly filled in · 2 items couldn’t be added · View Transcript · Undo"],
    ["zh-CN", 1, "笔记未能全部补全 · 1 项内容未能添加 · 查看转写稿 · 撤销"],
    ["zh-CN", 2, "笔记未能全部补全 · 2 项内容未能添加 · 查看转写稿 · 撤销"],
  ] as const)(
    "counts %s omitted items (%i), opens the Transcript and undoes once",
    async (language, omitted, text) => {
      actions.language.current = language;
      const meeting = meetingOf(fillOf({ omitted }));
      const line = await show(meeting);
      expect(line?.textContent).toBe(text);
      expect(line?.querySelectorAll("button")).toHaveLength(2);
      await click("meeting-fill-transcript");
      expect(actions.showMeetingNoteView.mock.calls).toEqual([
        ["meeting-tab", meeting.mindId, "transcript", { focus: true }],
      ]);
      expect(actions.showTranscript).not.toHaveBeenCalled();
      expect(actions.undoFill).not.toHaveBeenCalled();
      await click("meeting-fill-undo");
      expect(actions.undoFill.mock.calls).toEqual([[meeting.id, EDITOR]]);
      expect(actions.fillNotes).not.toHaveBeenCalled();
    },
  );

  describe.each(["en", "zh-CN"] as const)("generic rejected additions in %s", (language) => {
    test.each(["invalid metadata", "conflicting identity", "missing required Overview"])(
      "%s is an item that could not be added, not a diagnosed quote failure",
      async () => {
        actions.language.current = language;
        const line = await show(meetingOf(fillOf({ omitted: 1 })));
        expect(line?.textContent).toBe(
          language === "en"
            ? "Note partly filled in · 1 item couldn’t be added · View Transcript · Undo"
            : "笔记未能全部补全 · 1 项内容未能添加 · 查看转写稿 · 撤销",
        );
      },
    );
  });

  test.each([
    ["en", "No notes added · 2 items couldn’t be added · View Transcript · Try again"],
    ["zh-CN", "未添加笔记 · 2 项内容未能添加 · 查看转写稿 · 重试"],
  ] as const)(
    "with no safe additions in %s, never claims the notes were filled or offers Undo",
    async (language, text) => {
      actions.language.current = language;
      const meeting = meetingOf(
        fillOf({
          state: "failed",
          omitted: 2,
          problem: { kind: "model", message: "provider diagnostic" },
        }),
      );
      const line = await show(meeting);
      expect(line?.textContent).toBe(text);
      expect(line?.getAttribute("role")).toBe("alert");
      expect(line?.getAttribute("title")).toBe("provider diagnostic");
      expect(container.querySelector('[data-testid="meeting-fill-undo"]')).toBeNull();
      await click("meeting-fill-transcript");
      expect(actions.showMeetingNoteView.mock.calls).toEqual([
        ["meeting-tab", meeting.mindId, "transcript", { focus: true }],
      ]);
      expect(actions.showTranscript).not.toHaveBeenCalled();
      await click("meeting-fill-again");
      expect(actions.fillNotes.mock.calls).toEqual([[meeting.id]]);
      expect(actions.undoFill).not.toHaveBeenCalled();
    },
  );
});

describe("meeting notes retained before a later failure", () => {
  test.each([
    ["en", "Note partly filled in · View Transcript · Undo"],
    ["zh-CN", "笔记未能全部补全 · 查看转写稿 · 撤销"],
  ] as const)(
    "with no known counts in %s, reports partial results without provider text",
    async (language, text) => {
      actions.language.current = language;
      for (const counts of [{}, { omitted: 0, unfinishedParts: 0 }]) {
        const line = await show(
          meetingOf(
            fillOf({
              ...counts,
              problem: { kind: "model", message: "private provider diagnostic" },
            }),
          ),
        );
        expect(line?.textContent).toBe(text);
        expect(line?.getAttribute("title")).toBeNull();
      }
    },
  );

  test("a later failure still qualifies the fill when only an omission count is known", async () => {
    const line = await show(
      meetingOf(
        fillOf({
          omitted: 1,
          problem: { kind: "model", message: "private provider diagnostic" },
        }),
      ),
    );
    expect(line?.textContent).toBe(
      "Note partly filled in · 1 item couldn’t be added · View Transcript · Undo",
    );
  });

  test.each([
    ["en", "Note partly filled in · View Transcript · Undo"],
    ["zh-CN", "笔记未能全部补全 · 查看转写稿 · 撤销"],
  ] as const)(
    "unknown-size malformed output in %s has no invented item or part count",
    async (language, text) => {
      actions.language.current = language;
      const line = await show(
        meetingOf(
          fillOf({
            problem: { kind: "model", message: "Malformed frame with no known item identity" },
          }),
        ),
      );
      expect(line?.textContent).toBe(text);
      expect(line?.textContent).not.toMatch(/\d|quote|引用/);
    },
  );
});

describe("The Transcript line of a stopped Meeting whose transcription stopped (#2957)", () => {
  // protects=the line says the recording is kept only while it is: deleting the audio while the line shows turns it to the plain line at once, with nothing reloaded, in both languages; fails_when=the line keeps saying the recording is kept after its audio went; no_claim=the times of day, which meetingAudioWords' tests hold with a fixed clock.
  test.each([
    [
      "en",
      "Transcription stopped before the end. Your recording is kept. · Try again",
      "Transcription stopped. · Try again",
    ],
    ["zh-CN", "转写中途停止，录音已保留。· 重试", "转写已停止。· 重试"],
  ] as const)("in %s, deleting its audio turns the line plain", async (language, kept, deleted) => {
    actions.language.current = language;
    const base = meetingOf(fillOf({ state: "waiting" }));
    const meeting: Meeting = {
      ...base,
      audio: { kept: true, expiresAt: null, deletedAt: null, keptUntilDeleted: true },
      transcript: base.transcript && {
        ...base.transcript,
        state: "failed",
        problem: { kind: "engine", message: "The transcription model was stopped." },
      },
    };
    const lineText = () =>
      container.querySelector('[data-testid="meeting-transcript-line"]')?.textContent;

    await act(async () => root?.render(createElement(TranscriptLines, { meeting })));
    expect(lineText()).toBe(kept);
    const gone: Meeting = {
      ...meeting,
      audio: {
        kept: false,
        expiresAt: null,
        deletedAt: "2026-11-04T10:05:00.000Z",
        keptUntilDeleted: false,
      },
    };
    await act(async () => root?.render(createElement(TranscriptLines, { meeting: gone })));
    expect(lineText()).toBe(deleted);
  });
});

describe("Transcript entry points", () => {
  test.each(["en", "zh-CN"] as const)(
    "the saved Transcript uses the Note view in %s",
    async (language) => {
      actions.language.current = language;
      const meeting = meetingOf(fillOf());
      await act(async () => root?.render(createElement(TranscriptLines, { meeting })));
      await click("meeting-transcript-open");
      expect(actions.showMeetingNoteView.mock.calls).toEqual([
        ["meeting-tab", meeting.mindId, "transcript", { focus: true }],
      ]);
      expect(actions.showTranscript).not.toHaveBeenCalled();
    },
  );

  test.each(["memo", "live"] as const)(
    "the existing %s Transcript entry keeps its side-view behavior",
    async (kind) => {
      const meeting = meetingOf(fillOf());
      if (kind === "memo") meeting.kind = "memo";
      else {
        meeting.status = "recording";
        if (meeting.transcript) {
          meeting.transcript.state = "live";
          meeting.transcript.problem = { kind: "speakers", message: "Separation failed" };
        }
      }
      await act(async () => root?.render(createElement(TranscriptLines, { meeting })));
      await click("meeting-transcript-open");
      expect(actions.showTranscript.mock.calls).toEqual([
        ["actual-transcript-document", "meeting-group"],
      ]);
      expect(actions.showMeetingNoteView).not.toHaveBeenCalled();
    },
  );

  test("without a Note tab context, never opens an independent Transcript Document", async () => {
    actions.place.current = null;
    await show(meetingOf(fillOf({ omitted: 1 })));
    expect(container.querySelector('[data-testid="meeting-fill-transcript"]')).toBeNull();
    expect(actions.showMeetingNoteView).not.toHaveBeenCalled();
    expect(actions.showTranscript).not.toHaveBeenCalled();
  });

  test.each(["filled", "failed"] as const)(
    "with %s notes but no Transcript Document, renders no dead action",
    async (state) => {
      const meeting = meetingOf(fillOf({ state, omitted: 1 }));
      const withoutDocument = meeting.transcript
        ? { ...meeting.transcript, documentId: null }
        : null;
      for (const transcript of [null, withoutDocument]) {
        const line = await show({ ...meeting, transcript });
        expect(container.querySelector('[data-testid="meeting-fill-transcript"]')).toBeNull();
        expect(line?.querySelectorAll("button")).toHaveLength(1);
        expect(line?.querySelector("button")?.textContent).toBe(
          state === "filled" ? "Undo" : "Try again",
        );
      }
      expect(actions.showTranscript).not.toHaveBeenCalled();
    },
  );
});

describe.each(["en", "zh-CN"] as const)("existing fill behavior in %s", (language) => {
  beforeEach(() => {
    actions.language.current = language;
  });

  test("a fill the editor holds on top says so with its check and one Undo", async () => {
    const { holdFillSteps } = await import("../../src/renderer/src/meetingFillSteps");
    for (const counts of [{}, { omitted: 0, unfinishedParts: 0 }]) {
      const steps = heldSteps();
      const release = holdFillSteps("meeting-with-partial-notes", EDITOR, steps);
      const line = await show(meetingOf(fillOf(counts)));
      expect(line?.textContent).toBe(
        language === "en" ? "Note filled in from the call · Undo" : "已补全笔记 · 撤销",
      );
      expect(line?.querySelector("svg")).not.toBeNull();
      expect(line?.querySelectorAll("button")).toHaveLength(1);
      await click("meeting-fill-undo");
      await act(async () => release());
    }
    expect(actions.undoFill.mock.calls).toEqual([
      ["meeting-with-partial-notes", EDITOR],
      ["meeting-with-partial-notes", EDITOR],
    ]);
    expect(actions.showTranscript).not.toHaveBeenCalled();
  });

  test("the page stays bare: once the User types, or when no editor holds the fill, no line shows; taken back with ⌘Z, it offers Fill in again", async () => {
    const { holdFillSteps } = await import("../../src/renderer/src/meetingFillSteps");
    const meeting = meetingOf(fillOf());
    expect(await show(meeting)).toBeNull();
    const steps = heldSteps();
    const release = holdFillSteps(meeting.id, EDITOR, steps);
    expect(await show(meeting)).not.toBeNull();
    steps.top = false;
    await act(async () => steps.tell());
    expect(container.querySelector('[data-testid="meeting-fill-line"]')).toBeNull();
    steps.now = "undone";
    await act(async () => steps.tell());
    expect(container.querySelector('[data-testid="meeting-fill-line"]')?.textContent).toBe(
      language === "en" ? "Fill-in undone · Fill in again" : "已撤销补全 · 重新补全",
    );
    await act(async () => release());
  });

  test("a fill another copy of the Note holds on top draws no line in this one", async () => {
    const { holdFillSteps } = await import("../../src/renderer/src/meetingFillSteps");
    const release = holdFillSteps("meeting-with-partial-notes", {}, heldSteps());
    expect(await show(meetingOf(fillOf()))).toBeNull();
    await act(async () => release());
  });

  test("what couldn't be done to the fill says so in its line, which keeps its action", async () => {
    const problem = translate(language, "error.meeting.fillUndo");
    actions.problems = { "meeting-with-partial-notes": problem };
    const line = await show(meetingOf(fillOf({ state: "undone" })));
    expect(line?.getAttribute("role")).toBe("alert");
    expect(line?.textContent).toBe(
      language === "en"
        ? "The fill-in can only be taken back or put back. · Fill in again"
        : "补全只能撤销或恢复。· 重新补全",
    );
    await click("meeting-fill-again");
    expect(actions.fillNotes.mock.calls).toEqual([["meeting-with-partial-notes"]]);
  });

  test("no fill draws no line", async () => {
    expect(await show(meetingOf(null))).toBeNull();
  });

  // protects=after Stop, the line says each step only while it runs: the Transcript finishing, its speakers told apart while the notes wait for them, the note filled in, how many claims are checked, and the speakers still told apart beside a call's note being filled in (#2839); fails_when=a step's words show while another runs, the count or the pass is left out, or the line offers an action; no_claim=which step the core is in, which tests/core/meetingFill.test.ts covers.
  test.each([
    ["waiting", "finishing", false, false, 0, "Finishing the transcript…", "正在完成转写稿…", null],
    ["waiting", "saved", true, false, 0, "Telling the speakers apart…", "正在区分发言人…", null],
    ["waiting", "saved", false, false, 0, "Filling in the note…", "正在补全笔记…", null],
    ["filling", "saved", false, false, 0, "Filling in the note…", "正在补全笔记…", null],
    [
      "filling",
      "saved",
      false,
      true,
      0,
      "Filling in the note on this computer…",
      "正在这台电脑上补全笔记…",
      null,
    ],
    [
      "filling",
      "saved",
      true,
      false,
      0,
      "Filling in the note…",
      "正在补全笔记…",
      ["Telling the speakers apart…", "正在区分发言人…"],
    ],
    ["filling", "saved", false, false, 1, "Checking 1 claim…", "正在核对 1 条说法…", null],
    [
      "filling",
      "saved",
      false,
      true,
      3,
      "Checking 3 claims on this computer…",
      "正在这台电脑上核对 3 条说法…",
      null,
    ],
    [
      "filling",
      "saved",
      true,
      false,
      17,
      "Checking 17 claims…",
      "正在核对 17 条说法…",
      ["Telling the speakers apart…", "正在区分发言人…"],
    ],
  ] as const)(
    "%s, Transcript %s (speakers being told apart: %s, local: %s, claims checked: %i) says what is under way, with the live dot and no actions",
    async (state, transcriptState, separating, local, checking, en, zh, detail) => {
      const meeting = meetingOf(fillOf({ state, local, checking }));
      const transcript = meeting.transcript;
      if (!transcript) throw new Error("The meeting has no Transcript.");
      const line = await show({
        ...meeting,
        transcript: { ...transcript, state: transcriptState, separating },
      });
      const words = language === "en" ? en : zh;
      const also = detail ? (language === "en" ? detail[0] : detail[1]) : null;
      expect(line?.textContent).toBe(also ? `${words} · ${also}` : words);
      expect(line?.getAttribute("role")).toBe("status");
      expect(line?.querySelector(".answer-writing")?.textContent).toBe(words);
      expect(line?.querySelectorAll("button")).toHaveLength(0);
    },
  );

  // protects=a call's note filled in while its speakers are still told apart says so beside its Undo until the pass ends, as its Citations may then name who spoke (#2839); fails_when=the line hides the pass, or keeps saying it once the pass has ended; no_claim=the Citations' speakers, which tests/core/meetingFill.test.ts covers.
  test("a note filled in while its speakers are told apart says so until the pass ends", async () => {
    const { holdFillSteps } = await import("../../src/renderer/src/meetingFillSteps");
    const release = holdFillSteps("meeting-with-partial-notes", EDITOR, heldSteps());
    const meeting = meetingOf(fillOf({ state: "filled" }));
    const transcript = meeting.transcript;
    if (!transcript) throw new Error("The meeting has no Transcript.");
    const telling = await show({ ...meeting, transcript: { ...transcript, separating: true } });
    expect(telling?.textContent).toBe(
      language === "en"
        ? "Note filled in from the call · Telling the speakers apart… · Undo"
        : "已补全笔记 · 正在区分发言人… · 撤销",
    );
    const told = await show(meeting);
    expect(told?.textContent).toBe(
      language === "en" ? "Note filled in from the call · Undo" : "已补全笔记 · 撤销",
    );
    await act(async () => release());
  });

  // protects=from Stop, while the speech model the Transcript is finished with still downloads, the note's line says how far, in the transcript's own words (#2773); fails_when=it says only that the transcript is being finished, or nothing; no_claim=the download itself.
  test("while the speech model downloads after Stop, the line says how far", async () => {
    const meeting = meetingOf(fillOf({ state: "waiting" }));
    const transcript = meeting.transcript;
    if (!transcript) throw new Error("The meeting has no Transcript.");
    const line = await show({
      ...meeting,
      transcript: {
        ...transcript,
        state: "finishing",
        model: {
          name: "qwen3-asr-0.6b-int8",
          host: "huggingface.co",
          state: "downloading",
          downloadedBytes: 240_000_000,
          totalBytes: 960_000_000,
          error: null,
        },
      },
    });
    expect(line?.textContent).toBe(
      language === "en"
        ? "Finishing the transcript: downloading the speech model, 25% of 960 MB…"
        : "正在完成转写稿：正在下载语音模型（25%，共 960 MB）…",
    );
    expect(line?.querySelector(".answer-writing")).not.toBeNull();
  });

  // protects=a voice memo keeps its own waiting words with no live dot, since its Transcript's own line already says it is being finished (#2773); fails_when=the memo shows "Finishing the transcript…" twice; no_claim=a call's line, which the test above covers.
  test("a voice memo waiting for its Transcript keeps its own words", async () => {
    const line = await show({ ...meetingOf(fillOf({ state: "waiting" })), kind: "memo" });
    expect(line?.textContent).toBe(
      language === "en"
        ? "Your note is written once the transcript is saved…"
        : "转写稿保存后写入笔记…",
    );
    expect(line?.querySelector(".answer-writing")).toBeNull();
  });

  // protects=a Transcript that stopped with a problem says why in its own line, so the note's line doesn't claim it is being finished (#2773); fails_when=the line says "Finishing the transcript…" with the live dot while nothing is being finished; no_claim=the Transcript's problem line, which TranscriptLines' tests cover.
  test("a Transcript that stopped leaves the note waiting, with no live dot", async () => {
    const meeting = meetingOf(fillOf({ state: "waiting" }));
    const transcript = meeting.transcript;
    if (!transcript) throw new Error("The meeting has no Transcript.");
    const line = await show({
      ...meeting,
      transcript: { ...transcript, state: "failed", problem: { kind: "engine", message: "" } },
    });
    expect(line?.textContent).toBe(
      language === "en"
        ? "The note is filled in once the transcript is saved…"
        : "转写稿保存后补全笔记…",
    );
    expect(line?.querySelector(".answer-writing")).toBeNull();
  });

  test("an undone fill still offers Fill in again, not Transcript or Undo", async () => {
    const meeting = meetingOf(fillOf({ state: "undone", omitted: 2, unfinishedParts: 1 }));
    const line = await show(meeting);
    expect(line?.textContent).toBe(
      language === "en" ? "Fill-in undone · Fill in again" : "已撤销补全 · 重新补全",
    );
    expect(line?.querySelectorAll("button")).toHaveLength(1);
    await click("meeting-fill-again");
    expect(actions.fillNotes.mock.calls).toEqual([[meeting.id]]);
  });

  test.each([
    [
      "failed",
      "stopped",
      "The note wasn’t filled in: IncarnaMind closed before they were done. · Try again",
      "未能补全笔记：补全完成前 IncarnaMind 已关闭。· 重试",
    ],
    [
      "off",
      "no-model",
      "The note wasn’t filled in: choose an AI model first. · Try again",
      "未能补全笔记：请先选择一个 AI 模型。· 重试",
    ],
    [
      "failed",
      "model",
      "The note wasn’t filled in: the model couldn’t fill in the notes. · Try again",
      "未能补全笔记：模型未能补全笔记。· 重试",
    ],
  ] as const)(
    "%s with %s keeps its existing failure text and retry",
    async (state, kind, en, zh) => {
      const meeting = meetingOf(
        fillOf({ state, problem: { kind, message: "provider diagnostic" } }),
      );
      const line = await show(meeting);
      expect(line?.textContent).toBe(language === "en" ? en : zh);
      expect(line?.getAttribute("role")).toBe("alert");
      expect(line?.getAttribute("title")).toBe(kind === "model" ? "provider diagnostic" : null);
      expect(line?.querySelectorAll("button")).toHaveLength(1);
      await click("meeting-fill-again");
      expect(actions.fillNotes.mock.calls).toEqual([[meeting.id]]);
    },
  );

  test("Memo text stays unchanged even with counts and a problem on a filled memo", async () => {
    const meeting = meetingOf(
      fillOf({
        mode: "memo",
        omitted: 2,
        unfinishedParts: 1,
        problem: { kind: "model", message: "provider diagnostic" },
      }),
    );
    const line = await show({ ...meeting, kind: "memo" });
    expect(line?.textContent).toBe(
      language === "en" ? "Memo written · Undo" : "已写入语音备忘 · 撤销",
    );
    expect(line?.querySelectorAll("button")).toHaveLength(1);
    await click("meeting-fill-undo");
    expect(actions.undoFill.mock.calls).toEqual([[meeting.id, EDITOR]]);
    expect(actions.showTranscript).not.toHaveBeenCalled();
  });

  test("a Memo's as-is Transcript fallback keeps its own explanation", async () => {
    const meeting = meetingOf(
      fillOf({
        mode: "transcript",
        problem: { kind: "added", message: "not for display" },
      }),
    );
    const line = await show({ ...meeting, kind: "memo" });
    expect(line?.textContent).toBe(
      language === "en"
        ? "Transcript written in as it is: the tidied note had words you didn’t say. · Undo"
        : "已按原样写入转写稿：整理后的笔记里有你没说过的词。· 撤销",
    );
    expect(line?.querySelectorAll("button")).toHaveLength(1);
  });
});

describe("meeting-fill Undo notice", () => {
  let store: typeof import("../../src/renderer/src/meetings");
  beforeAll(async () => {
    store = await vi.importActual("../../src/renderer/src/meetings");
  });

  function completed(meeting: Meeting) {
    store.useMeetings.setState({
      meetings: [{ ...meeting, fill: fillOf({ state: "filling" }) }],
    });
    const changed = actions.listeners.get("meetings.changed");
    if (!changed) throw new Error("No subscription to meeting changes");
    changed([meeting]);
  }

  const said = (change: Undoable, language: Language) =>
    change.said(
      (key, params) => translate(language, key, params),
      (name) => name,
    );

  test.each([
    { omitted: 1 },
    { unfinishedParts: 2 },
    { problem: { kind: "model", message: "Unknown-size malformed frame" } },
  ] satisfies Partial<MeetingFill>[])(
    "retained partial results %j have an honest notice and one Undo",
    async (fill) => {
      const meeting = meetingOf(fillOf(fill));
      completed(meeting);
      const change = actions.push.mock.calls[0]?.[0];
      if (!change) throw new Error("No Undo offered for retained meeting additions");
      expect(said(change, "en")).toBe("Note partly filled in");
      expect(said(change, "zh-CN")).toBe("笔记未能全部补全");
      change.also?.run();
      expect(actions.openMind.mock.calls).toEqual([[meeting.mindId]]);
      await change.undo();
      expect(actions.undoMeetingFill.mock.calls).toEqual([[meeting.id]]);
      actions.listeners.get("meetings.changed")?.([meeting]);
      expect(actions.push).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["meeting", "memo"] as const)(
    "a complete %s keeps its ordinary completion notice",
    (kind) => {
      completed({ ...meetingOf(fillOf()), kind });
      const change = actions.push.mock.calls[0]?.[0];
      if (!change) throw new Error("No Undo offered for completed additions");
      expect(said(change, "en")).toBe(
        kind === "memo" ? "Memo written" : "Note filled in from the call",
      );
      expect(said(change, "zh-CN")).toBe(kind === "memo" ? "已写入语音备忘" : "已补全笔记");
    },
  );

  test("a Memo ignores meeting-only incompleteness signals", () => {
    completed({ ...meetingOf(fillOf({ omitted: 1, unfinishedParts: 2 })), kind: "memo" });
    const change = actions.push.mock.calls[0]?.[0];
    if (!change) throw new Error("No Undo offered for the Memo");
    expect(said(change, "en")).toBe("Memo written");
  });

  test("a failed fill with no additions never offers an Undo notice", () => {
    completed(meetingOf(fillOf({ state: "failed", omitted: 2 })));
    expect(actions.push).not.toHaveBeenCalled();
  });
});
