import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, useContext, useEffect } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Document, Meeting, Mind, NoteTurn, WindowLayout } from "../../src/core/api";
import type { AppState } from "../../src/renderer/src/store";
import { translate } from "../../src/shared/i18n";

const actions = vi.hoisted(() => ({
  changeLayout: vi.fn(),
  showTranscript: vi.fn(),
  openBeside: vi.fn(),
  addLine: vi.fn(async () => "added"),
  mounts: vi.fn(),
  unmounts: vi.fn(),
  focus: vi.fn(),
  retryDocument: vi.fn(),
  reportError: vi.fn(),
  language: "en" as "en" | "zh-CN",
  /** The core's answers a test sets, by method; any other method answers an empty list. */
  core: {} as Record<string, (...args: unknown[]) => unknown>,
}));

vi.mock("../../src/renderer/src/store", async () => {
  const { create } = await import("zustand");
  return {
    useAppStore: create<AppState>()(
      () =>
        ({
          minds: [],
          documents: [],
          skills: [],
          layout: null,
          status: { kind: "ready" },
          settings: null,
          changeLayout: actions.changeLayout,
          retryDocument: actions.retryDocument,
          reportError: actions.reportError,
        }) as unknown as AppState,
    ),
  };
});
vi.mock("../../src/renderer/src/meetings", async () => {
  const { create } = await import("zustand");
  const useMeetings = create<{
    meetings: Meeting[];
    detailsShown: Record<string, boolean>;
    audioProblems: Record<string, string>;
    problems: Record<string, string>;
    resumeProblems: Record<string, string>;
    gapsSeen: Record<string, number>;
    screenExplained: Record<string, boolean>;
    showDetails: (meetingId: string, shown?: boolean) => void;
  }>()((set) => ({
    meetings: [],
    detailsShown: {},
    audioProblems: {},
    problems: {},
    resumeProblems: {},
    gapsSeen: {},
    screenExplained: {},
    showDetails: (meetingId, shown) =>
      set((state) => ({
        detailsShown: {
          ...state.detailsShown,
          [meetingId]: shown ?? !state.detailsShown[meetingId],
        },
      })),
  }));
  return {
    useMeetings,
    useMeetingOf: (mindId: string) =>
      useMeetings((state) => state.meetings.find((meeting) => meeting.mindId === mindId)),
    useMeetingTime: (meeting: Meeting) => meeting.recordedMs,
    canRecordMeetings: () => false,
    isLive: (meeting?: Meeting) => meeting?.status === "recording" || meeting?.status === "paused",
    isWaitingForPermission: (meeting?: Meeting) =>
      meeting?.status === "recording" && meeting.sources.microphone === "waiting",
  };
});
vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "on" ? () => () => undefined : (actions.core[String(name)] ?? (async () => [])),
    },
  ),
  files: new Proxy({}, { get: () => () => () => undefined }),
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => translate.bind(null, actions.language),
  useLanguage: () => actions.language,
  useGap: () => () => " · ",
  translateNow: (key: Parameters<typeof translate>[1]) => translate(actions.language, key),
}));
vi.mock("../../src/renderer/src/dragDrop", () => ({
  useDropTarget: () => ({ over: false, props: {} }),
}));
vi.mock("../../src/renderer/src/mindStyles", () => ({ useWritingProperties: () => ({}) }));
vi.mock("../../src/renderer/src/quietAssistant", () => ({ useQuietAssistant: () => null }));
vi.mock("../../src/renderer/src/reviewPane", () => ({
  useRoomBeside: () => true,
  useReviewPanes: (select: (state: { panes: Record<string, { over: boolean }> }) => unknown) =>
    select({ panes: { note: { over: false } } }),
}));
vi.mock("../../src/renderer/src/undoPill", () => ({
  useUndoPillBands: () => 0,
  undoBandFor: () => 0,
}));
vi.mock("../../src/renderer/src/useWindowWidth", () => ({ useGroupsMerged: () => false }));
vi.mock("../../src/renderer/src/wordImport", () => ({ useWordImport: {} }));
vi.mock("../../src/renderer/src/components/ExportResultLine", () => ({
  ExportResultLine: () => null,
}));
vi.mock("../../src/renderer/src/components/FirstOpenSteps", () => ({ ExampleIntro: () => null }));
vi.mock("../../src/renderer/src/components/GettingStarted", () => ({ useIsExample: () => false }));
vi.mock("../../src/renderer/src/components/MakeSkillCard", () => ({ MakeSkillCard: () => null }));
// The page above the notes is drawn by its own tests; the sheet's audio line is drawn here.
vi.mock("../../src/renderer/src/components/MeetingInMind", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MeetingInMind: () => null,
}));
vi.mock("../../src/renderer/src/components/providers/ChatReadinessNotice", () => ({
  ChatReadinessNotice: () => null,
}));
vi.mock("../../src/renderer/src/components/MindEditor", async () => {
  const { PageSlotsContext } = await import("../../src/renderer/src/editor/mindContext");
  return {
    MindEditor: ({ mindId }: { mindId: string }) => {
      const slots = useContext(PageSlotsContext);
      useEffect(() => {
        actions.mounts(mindId);
        return () => actions.unmounts(mindId);
      }, [mindId]);
      return createElement(
        "div",
        null,
        createElement("input", { "data-testid": "retained-editor", defaultValue: "My notes" }),
        slots.menu &&
          createPortal(
            createElement("button", { type: "button", "data-testid": "note-menu" }, "⋯"),
            slots.menu,
          ),
        slots.count && createPortal(createElement("span", null, "Words"), slots.count),
        slots.badge && createPortal(createElement("span", null, "Check"), slots.badge),
      );
    },
  };
});
vi.mock("../../src/renderer/src/citationVersion", () => ({
  useCitationRecheck: () => null,
  useQuoteLook: () => null,
}));
vi.mock("../../src/renderer/src/evidence", () => ({ useLeftOutOfEvidence: () => false }));
vi.mock("../../src/renderer/src/components/ObjectMenu", () => ({
  useObjectMenu: () => ({ rowProps: {} }),
  ObjectMenu: () =>
    createElement("button", { type: "button", "data-testid": "document-menu" }, "Document menu"),
}));
vi.mock("../../src/renderer/src/components/DocumentsSection", () => ({
  YourNoteLabel: () => null,
}));
vi.mock("../../src/renderer/src/components/TagChips", () => ({ DocumentTagChips: () => null }));
vi.mock("../../src/renderer/src/components/library/DocumentMoveTo", () => ({
  moveDocumentsBeside: vi.fn(),
}));
vi.mock("../../src/renderer/src/useRename", () => ({
  useRename: () => ({ renaming: false, nameProps: {} }),
}));
vi.mock("../../src/renderer/src/transcriptNotes", () => ({ addLineToNote: actions.addLine }));
vi.mock("../../src/renderer/src/editor/meetingNotes", () => ({
  markNow: vi.fn(),
  noteOf: vi.fn(),
}));
vi.mock("../../src/renderer/src/requests", async () => {
  const { create } = await import("zustand");
  return {
    useRequests: create<{
      deleteAudio: { meetingId: string } | null;
      ask(request: { deleteAudio: { meetingId: string } }): void;
      clear(key: "deleteAudio"): void;
    }>()((set) => ({
      deleteAudio: null,
      ask: (request) => set(request),
      clear: (key) => set({ [key]: null }),
    })),
  };
});
vi.mock("../../src/renderer/src/transcripts", () => ({
  showTranscript: actions.showTranscript,
  openTranscriptBeside: actions.openBeside,
}));
vi.mock("../../src/renderer/src/motion", () => ({
  enterFrom: vi.fn(),
  exitToward: vi.fn(),
  motionMode: () => "off",
  subscribeMotion: () => () => undefined,
}));

import { useMeetings } from "../../src/renderer/src/meetings";
import { useAppStore } from "../../src/renderer/src/store";

let root: Root | null = null;
let container: HTMLElement;
let MindTab: ComponentType<{ mindId: string }>;
let TabPlace: ComponentType<{
  value: { tabId: string; groupId: string };
  children?: React.ReactNode;
}>;
let views: typeof import("../../src/renderer/src/meetingViews");
let meetingCommands: typeof import("../../src/renderer/src/commands/meetings").meetingCommands;
let shortcutLabel: typeof import("../../src/renderer/src/commands/keymap").shortcutLabel;
let response: "ready" | "pending" | "missing" | "failed";
const FIRST_LINE = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Me>Keep the go-live date.\n";
/** The Transcript's file as the request reads it now. */
let served = FIRST_LINE;
const requests: string[] = [];

class BytesRequest {
  status = 200;
  responseType = "";
  response: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(_method: string, url: string) {
    requests.push(url);
  }
  send() {
    if (response === "pending") return;
    this.status = response === "missing" ? 404 : response === "failed" ? 500 : 200;
    this.response = new TextEncoder().encode(served).buffer;
    queueMicrotask(() => this.onload?.());
  }
  abort() {
    this.onabort?.();
  }
}

const meetingOf = (overrides: Partial<Meeting> = {}): Meeting =>
  ({
    id: "meeting",
    mindId: "note",
    kind: "meeting",
    status: "stopped",
    recordedMs: 60_000,
    transcript: { documentId: "transcript", lines: 1, state: "saved", partials: [] },
    audio: {
      kept: true,
      expiresAt: "2026-11-08T12:54:00.000Z",
      deletedAt: null,
      keptUntilDeleted: false,
    },
    gaps: [],
    sources: { microphone: "recording", system: "recording" },
    systemAudio: true,
    microphonePausedAtMs: null,
    screen: null,
    saveError: null,
    health: { realTimeFactor: null, measuredMs: 0, keepsUp: null, events: [] },
    fill: null,
    ...overrides,
  }) as Meeting;

const documentOf = (): Document =>
  ({
    id: "transcript",
    name: "Private transcript filename",
    kind: "transcript",
    contentHash: "v1",
    fileStatus: "available",
    status: "ready",
    failure: null,
    origin: "meeting",
  }) as unknown as Document;

const layoutOf = (): WindowLayout =>
  ({
    focusedGroupId: "group",
    groups: [
      {
        id: "group",
        activeTabId: "tab",
        tabs: [{ id: "tab", item: { kind: "mind", mindId: "note" }, preview: false }],
      },
    ],
  }) as WindowLayout;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  const path = "../../src/renderer/src/components/tabs/MindTab.tsx";
  ({ MindTab } = await import(path));
  const tabsPath = "../../src/renderer/src/components/tabs/tabItems.tsx";
  ({ TabPlaceContext: TabPlace } = await import(tabsPath));
  views = await import("../../src/renderer/src/meetingViews");
  ({ meetingCommands } = await import("../../src/renderer/src/commands/meetings"));
  ({ shortcutLabel } = await import("../../src/renderer/src/commands/keymap"));
  // The sheet and the control name their keys from the window's commands, as the app registers them.
  const { commands } = await import("../../src/renderer/src/commands/registry");
  for (const each of meetingCommands) commands.register(each);
});

beforeEach(() => {
  vi.clearAllMocks();
  actions.language = "en";
  response = "ready";
  served = FIRST_LINE;
  requests.length = 0;
  const document = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  const window = document.defaultView;
  Object.assign(window.HTMLElement.prototype, {
    hidePopover() {},
    focus(this: HTMLElement) {
      actions.focus(this.dataset.testid);
    },
  });
  for (const [name, value] of Object.entries({
    document,
    window,
    CSS: { escape: (text: string) => text },
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    XMLHttpRequest: BytesRequest,
    navigator: { languages: ["en"], platform: "Linux" },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(name, value);
  views.useMeetingNoteViews.setState({ views: {}, focus: null });
  useAppStore.setState({
    minds: [{ id: "note" }, { id: "other" }] as Mind[],
    documents: [documentOf()],
    layout: layoutOf(),
  });
  useMeetings.setState({ meetings: [meetingOf()] });
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
});

async function show(tabs = [{ tabId: "tab", mindId: "note" }]) {
  await act(async () =>
    root?.render(
      createElement(
        "div",
        null,
        ...tabs.map(({ tabId, mindId }) =>
          createElement(
            TabPlace,
            { key: `${tabId}:${mindId}`, value: { tabId, groupId: "group" } },
            createElement("div", { "data-tab-id": tabId }, createElement(MindTab, { mindId })),
          ),
        ),
      ),
    ),
  );
}

function find(id: string, within: ParentNode = container): HTMLElement {
  const found = within.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
}

async function click(id: string, within: ParentNode = container) {
  await act(async () =>
    find(id, within).dispatchEvent(new window.Event("click", { bubbles: true })),
  );
}

const sheetIn = (within: ParentNode = container) =>
  within.querySelector<HTMLElement>('[data-testid="meeting-sheet"]');

const focusesOf = (id: string) => actions.focus.mock.calls.filter(([each]) => each === id).length;

const command = (id: string) => {
  const found = meetingCommands.find((each) => each.id === id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
};
const PALETTE = { surface: "palette", selection: [], focus: null } as const;

describe("the Meeting's Transcript sheet over its Note", () => {
  test("raises over the same tab without changing Layout, and the notes keep their editor and scroll", async () => {
    await show();
    const editor = find("retained-editor") as HTMLInputElement;
    editor.value = "Typed while recording";
    const scroller = find("mind-scroller");
    scroller.scrollTop = 137;
    // After Stop the meeting's control is one button, Transcript, which raises the sheet.
    const control = find("meeting-foot");
    expect(control.getAttribute("data-status")).toBe("stopped");
    const transcriptButton = find("meeting-foot-transcript", control);
    expect(transcriptButton.textContent).toBe("Transcript");
    expect(transcriptButton.getAttribute("aria-expanded")).toBe("false");
    expect(sheetIn()).toBeNull();
    await click("meeting-foot-transcript");
    const sheet = find("meeting-sheet");
    expect(transcriptButton.getAttribute("aria-expanded")).toBe("true");
    expect(sheet.getAttribute("data-document-id")).toBe("transcript");
    expect(sheet.querySelector("h2")?.textContent).toBe("Transcript");
    expect(sheet.textContent).toContain("Keep the go-live date.");
    // Over the notes: they stay drawn under it, with their foot and the review beside them.
    expect(scroller.style.visibility).not.toBe("hidden");
    expect(container.querySelector<HTMLElement>(".mind-foot-slot")?.style.display).not.toBe("none");
    expect(container.querySelector(".review-slot")?.getAttribute("data-shown")).toBe("beside");
    // The sheet names the Transcript itself: the Document's own title and menu stay out.
    expect(sheet.querySelector('[data-testid="viewer-title"]')).toBeNull();
    expect(container.querySelector('[data-testid="document-menu"]')).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("transcript");
    await click("transcript-line-actions");
    const addToNote = Array.from(
      find("transcript-line-menu").querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === "Add to note");
    if (!addToNote) throw new Error("Missing Add to note in the saved line’s menu");
    await act(async () => addToNote.click());
    expect(actions.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: "meeting",
        document: expect.objectContaining({ id: "transcript" }),
        cue: expect.objectContaining({ text: "Keep the go-live date." }),
      }),
    );
    await click("meeting-sheet-hide");
    expect(sheetIn()).toBeNull();
    expect(transcriptButton.getAttribute("aria-expanded")).toBe("false");
    expect(find("retained-editor")).toBe(editor);
    expect(editor.value).toBe("Typed while recording");
    expect(scroller.scrollTop).toBe(137);
    expect(container.querySelector(".review-slot")?.getAttribute("data-shown")).toBe("beside");
    expect(actions.mounts).toHaveBeenCalledTimes(1);
    expect(actions.unmounts).not.toHaveBeenCalled();
    expect(actions.changeLayout).not.toHaveBeenCalled();
    expect(actions.showTranscript).not.toHaveBeenCalled();
    expect(useAppStore.getState().layout?.groups[0]?.tabs[0]?.id).toBe("tab");
  });

  test("keeps two tabs of one Note independent, and a tab reused for another Note shows its notes", async () => {
    await show([
      { tabId: "tab", mindId: "note" },
      { tabId: "second", mindId: "note" },
    ]);
    const first = container.querySelector('[data-tab-id="tab"]');
    const second = container.querySelector('[data-tab-id="second"]');
    if (!first || !second) throw new Error("Missing tabs");
    await click("meeting-foot-transcript", first);
    expect(sheetIn(first)).not.toBeNull();
    expect(sheetIn(second)).toBeNull();
    expect(find("meeting-foot-transcript", second).getAttribute("aria-expanded")).toBe("false");
    await act(async () =>
      useMeetings.setState({
        meetings: [meetingOf(), meetingOf({ id: "other-meeting", mindId: "other" })],
      }),
    );
    await show([{ tabId: "tab", mindId: "other" }]);
    expect(sheetIn()).toBeNull();
    expect(find("meeting-foot-transcript").getAttribute("aria-expanded")).toBe("false");
  });

  test.each(["pending", "missing", "failed"] as const)(
    "keeps %s file states in the sheet without Document rename chrome",
    async (state) => {
      response = state;
      await show();
      await click("meeting-foot-transcript");
      const transcript = find("meeting-sheet");
      expect(transcript.querySelector('[data-testid="viewer-title"]')).toBeNull();
      expect(transcript.querySelector('[data-testid="viewer-title-rename"]')).toBeNull();
      expect(transcript.querySelector('[data-testid="document-menu"]')).toBeNull();
      expect(transcript.textContent).toMatch(
        state === "pending"
          ? /Opening the Document/
          : state === "missing"
            ? /missing|found/i
            : /couldn.t be read/i,
      );
      expect(actions.changeLayout).not.toHaveBeenCalled();
    },
  );

  test("shows loading while the Meeting's Document metadata catches up, then loads its actual file", async () => {
    useAppStore.setState({ documents: [] });
    await show();
    await click("meeting-foot-transcript");
    expect(find("meeting-sheet").textContent).toContain("Opening the Document");
    expect(requests).toHaveLength(0);
    await act(async () => useAppStore.setState({ documents: [documentOf()] }));
    expect(find("meeting-sheet").textContent).toContain("Keep the go-live date.");
    expect(requests).toHaveLength(1);
  });

  test("takes the focus to the sheet once per opening from ⌘K, not on metadata updates, and its Hide gives it back to the control", async () => {
    await show();
    await act(async () => command("meeting.showTranscript").run(PALETTE));
    const sheet = find("meeting-sheet");
    expect(sheet.tagName).toBe("SECTION");
    expect(sheet.getAttribute("aria-label")).toBe("Transcript");
    expect(sheet.getAttribute("tabindex")).toBe("-1");
    expect(focusesOf("meeting-sheet")).toBe(1);
    await act(async () =>
      useAppStore.setState({ documents: [{ ...documentOf(), contentHash: "v2" }] }),
    );
    expect(focusesOf("meeting-sheet")).toBe(1);
    const toChevron = focusesOf("meeting-foot-transcript");
    await click("meeting-sheet-hide");
    expect(sheetIn()).toBeNull();
    expect(focusesOf("meeting-foot-transcript")).toBe(toChevron + 1);
    await act(async () => command("meeting.showTranscript").run(PALETTE));
    expect(sheetIn()).not.toBeNull();
    expect(focusesOf("meeting-sheet")).toBe(2);
  });

  test("retains the real file failure's Retry and rereads the VTT in place", async () => {
    response = "failed";
    useAppStore.setState({
      documents: [
        {
          ...documentOf(),
          status: "failed",
          failure: { reason: "processing-error", message: "test failure" },
        },
      ],
    });
    await show();
    await click("meeting-foot-transcript");
    const sheet = find("meeting-sheet");
    expect(find("viewer-retry", sheet)).toBeDefined();
    response = "ready";
    await click("viewer-retry", sheet);
    expect(actions.retryDocument).toHaveBeenCalledWith("transcript");
    expect(find("meeting-sheet").textContent).toContain("Keep the go-live date.");
    expect(actions.changeLayout).not.toHaveBeenCalled();
  });

  // protects=a live Transcript reads as a script: one Speaker's lines are one turn that grows in place, the same element, as each sentence comes; the words being said join its end; someone else's line is a turn of its own and the first Speaker's next words start a new turn after it; the reader's place holds while they read above; fails_when=a new sentence re-lays out the turn (a new element), words being said show as a row of their own, an interjection joins the turn, or the view jumps while the reader is up the page; no_claim=the route's cuts, which the core tests cover.
  test("a live Transcript grows its turn in place, and the reader's place holds", async () => {
    const vtt = (lines: [number, number, string, string][]) =>
      `WEBVTT\n\n${lines
        .map(
          ([from, to, who, text]) =>
            `00:00:${String(from).padStart(2, "0")}.000 --> 00:00:${String(to).padStart(2, "0")}.000\n<v ${who}>${text}`,
        )
        .join("\n\n")}\n`;
    const live = (lines: number, partials: NonNullable<Meeting["transcript"]>["partials"] = []) =>
      meetingOf({
        status: "recording",
        transcript: { documentId: "transcript", lines, state: "live", partials } as NonNullable<
          Meeting["transcript"]
        >,
      });
    const said: [number, number, string, string][] = [
      [1, 3, "Me", "Keep the go-live date."],
      [3, 5, "Me", "Then ship it."],
    ];
    served = vtt(said);
    useMeetings.setState({ meetings: [live(2)] });
    await show();
    await act(async () => views.showMeetingNoteView("tab", "note", "transcript"));
    const turns = () => [
      ...find("meeting-sheet").querySelectorAll('[data-testid="transcript-turn"]'),
    ];
    expect(turns()).toHaveLength(1);
    const turn = turns()[0] as HTMLElement;
    const scroller = find("viewer-transcript", find("meeting-sheet"));
    // The reader scrolls up to read.
    Object.assign(scroller, { scrollTop: 120 });
    await act(async () => scroller.dispatchEvent(new window.Event("scroll")));

    said.push([5, 7, "Me", "And tell the team."]);
    served = vtt(said);
    await act(async () =>
      useMeetings.setState({
        meetings: [live(3, [{ startMs: 7100, speaker: "Me", text: "We need a" }])],
      }),
    );
    expect(turns()).toHaveLength(1);
    expect(turns()[0]).toBe(turn);
    expect(turn.querySelectorAll('[data-testid="transcript-line"]')).toHaveLength(3);
    expect(turn.querySelector('[data-testid="transcript-partial"]')?.textContent).toContain(
      "We need a",
    );
    expect(scroller.scrollTop).toBe(120);

    said.push([7, 8, "Them", "Agreed."], [8, 10, "Me", "We need a date."]);
    served = vtt(said);
    await act(async () => useMeetings.setState({ meetings: [live(5)] }));
    expect(turns()).toHaveLength(3);
    expect(turns()[0]).toBe(turn);
    expect(
      turns().map((each) => each.querySelector('[data-testid="transcript-speaker"]')?.textContent),
    ).toEqual(["Me", "Them", "Me"]);
    expect(scroller.scrollTop).toBe(120);
  });

  test("draws no control and no sheet for a Voice memo, and a call with nothing transcribed says so in its sheet", async () => {
    useMeetings.setState({ meetings: [meetingOf({ kind: "memo" })] });
    await show();
    await act(async () => views.showMeetingNoteView("tab", "note", "transcript"));
    expect(container.querySelector('[data-testid="meeting-foot"]')).toBeNull();
    expect(sheetIn()).toBeNull();
    await act(async () => views.showMeetingNoteView("tab", "note", "notes"));
    await act(async () => useMeetings.setState({ meetings: [meetingOf({ transcript: null })] }));
    await click("meeting-foot-transcript");
    const sheet = find("meeting-sheet");
    expect(find("transcript-empty", sheet).textContent).toBe("Nothing was transcribed.");
    expect((find("meeting-sheet-beside", sheet) as HTMLButtonElement).disabled).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test.each(["en", "zh-CN"] as const)(
    "names the control's Transcript button and the sheet in %s",
    async (language) => {
      actions.language = language;
      await show();
      const keys = shortcutLabel("meeting.nextView");
      const button = find("meeting-foot-transcript");
      expect(button.textContent).toBe(translate(language, "meetings.views.transcript"));
      expect(button.getAttribute("aria-label")).toBe(
        translate(language, "meetings.foot.show", { keys }),
      );
      await click("meeting-foot-transcript");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.getAttribute("aria-label")).toBe(
        translate(language, "meetings.foot.hide", { keys }),
      );
      const sheet = find("meeting-sheet");
      expect(sheet.getAttribute("aria-label")).toBe(
        translate(language, "meetings.views.transcript"),
      );
      expect(find("meeting-sheet-hide", sheet).getAttribute("aria-label")).toBe(
        translate(language, "meetings.foot.hide", { keys }),
      );
      expect(find("meeting-sheet-beside", sheet).getAttribute("aria-label")).toBe(
        translate(language, "meetings.views.besideCommand"),
      );
    },
  );

  // protects=a call whose notes failed on a provider's refusal still reaches its Transcript without the fill line, which then offers the fix and Try again in its place (#3099): the meeting's control, "Transcript" / "转写稿", raises it; fails_when=the control is gone or its Transcript button doesn't open the Transcript in that state; no_claim=the fill line's own actions, which tests/renderer/meetingFillLine.test.ts covers.
  test.each(["en", "zh-CN"] as const)(
    "with its notes failed on a refused key, the control still opens the Transcript (%s)",
    async (language) => {
      actions.language = language;
      useMeetings.setState({
        meetings: [
          meetingOf({
            fill: {
              state: "failed",
              mode: "sections",
              local: false,
              omitted: 0,
              unfinishedParts: 1,
              problem: {
                kind: "model",
                message: "provider diagnostic",
                error: "auth",
                model: { providerId: "provider-1", modelId: "claude-haiku-5-5" },
              },
            },
          } as unknown as Partial<Meeting>),
        ],
      });
      await show();
      expect(find("meeting-foot").getAttribute("data-status")).toBe("stopped");
      expect(find("meeting-foot-transcript").textContent).toBe(
        translate(language, "meetings.views.transcript"),
      );
      await click("meeting-foot-transcript");
      expect(find("meeting-sheet").textContent).toContain("Keep the go-live date.");
      expect(find("meeting-foot-transcript").getAttribute("aria-expanded")).toBe("true");
    },
  );

  test.each(["stopped", "recording"] as const)(
    "⌘K's views of a %s call raise and fold the sheet in place, and Open beside opens the Transcript next to it",
    async (status) => {
      useMeetings.setState({ meetings: [meetingOf({ status })] });
      await show();
      expect(command("meeting.showNotes").when?.(PALETTE)).toBe(false);
      expect(command("meeting.showTranscript").when?.(PALETTE)).toBe(true);
      expect(command("meeting.showTranscript").label).toBe("meetings.views.showTranscript");
      await act(async () => command("meeting.showTranscript").run(PALETTE));
      expect(sheetIn()).not.toBeNull();
      expect(find("meeting-foot-transcript").getAttribute("aria-expanded")).toBe("true");
      expect(command("meeting.showTranscript").when?.(PALETTE)).toBe(false);
      expect(command("meeting.showNotes").when?.(PALETTE)).toBe(true);
      await act(async () => command("meeting.previousView").run(PALETTE));
      expect(sheetIn()).toBeNull();
      await act(async () => command("meeting.nextView").run(PALETTE));
      expect(sheetIn()).not.toBeNull();
      await act(async () => command("meeting.showNotes").run(PALETTE));
      expect(sheetIn()).toBeNull();
      expect(find("meeting-foot-transcript").getAttribute("aria-expanded")).toBe("false");
      // My notes is a view once the call is over.
      expect(command("meeting.showMyNotes").when?.(PALETTE)).toBe(status === "stopped");
      expect(command("meeting.previousView").shortcut?.keys).toBe("CmdOrCtrl+Alt+Left");
      expect(command("meeting.nextView").shortcut?.keys).toBe("CmdOrCtrl+Alt+Right");
      expect(command("meeting.nextView").palette).toBe(false);
      expect(command("meeting.transcriptBeside").enabled?.(PALETTE)).toBe(true);
      await act(async () => command("meeting.transcriptBeside").run(PALETTE));
      expect(actions.openBeside).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: "tab", groupId: "group" }),
      );
      expect(actions.changeLayout).not.toHaveBeenCalled();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "while it records, the sheet shows both sides' words being said before its first line, between its line to tell everyone and the recording's controls (%s)",
    async (language) => {
      actions.language = language;
      useAppStore.setState({ documents: [] });
      useMeetings.setState({
        meetings: [
          meetingOf({
            status: "recording",
            transcript: {
              documentId: null,
              lines: 0,
              state: "live",
              partials: [
                { startMs: 200, text: "The budget holds", speaker: "Me" },
                { startMs: 400, text: "Thanks for making", speaker: "Them" },
              ],
            },
          } as unknown as Partial<Meeting>),
        ],
      });
      await show();
      await act(async () => views.showMeetingNoteView("tab", "note", "transcript"));
      const transcript = find("meeting-sheet");
      expect(transcript.hasAttribute("data-live")).toBe(true);
      expect(find("meeting-sheet-time", transcript).textContent).toBe("1:00");
      expect(transcript.querySelector(".meeting-sheet-consent")?.textContent).toBe(
        translate(language, "meetings.foot.tell"),
      );
      const foot = find("meeting-sheet-foot", transcript);
      for (const id of ["meeting-sheet-mic", "meeting-sheet-pause", "meeting-sheet-mark"])
        expect(find(id, foot)).toBeDefined();
      const said = [...transcript.querySelectorAll('[data-testid="transcript-partial"]')];
      expect(said.map((each) => each.querySelector(".transcript-text")?.textContent)).toEqual([
        "The budget holds",
        "Thanks for making",
      ]);
      expect(
        said.map((each) => each.querySelector('[data-testid="transcript-speaker"]')?.textContent),
      ).toEqual(language === "en" ? ["Me", "Them"] : ["我", "对方"]);
      expect(transcript.querySelectorAll('[data-testid="transcript-line"]')).toHaveLength(0);
      expect(transcript.querySelector('[data-testid="transcript-empty"]')).toBeNull();
      expect(requests).toHaveLength(0);
      expect(find("meeting-foot").getAttribute("data-status")).toBe("recording");
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "before its first line, a live call's Transcript can't open beside yet, and says why (%s)",
    async (language) => {
      actions.language = language;
      useMeetings.setState({
        meetings: [
          meetingOf({
            status: "recording",
            transcript: { documentId: null, lines: 0, state: "live", partials: [] },
          } as unknown as Partial<Meeting>),
        ],
      });
      await show();
      expect(command("meeting.transcriptBeside").enabled?.(PALETTE)).toEqual({
        reason: "meetings.bar.transcriptSoon",
      });
      await click("meeting-foot-transcript");
      const beside = find("meeting-sheet-beside", find("meeting-sheet")) as HTMLButtonElement;
      expect(beside.disabled).toBe(true);
      expect(beside.title).toBe(translate(language, "meetings.bar.transcriptSoon"));
    },
  );
});

/** Esc pressed where `target` has the focus, reaching the window as a key the page didn't stop does. */
function pressEscape(target: EventTarget): Event {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, { key: "Escape", isComposing: false });
  target.dispatchEvent(event);
  if (target !== window) window.dispatchEvent(event);
  return event;
}

const STOPPED_AT = "2026-11-25T10:00:00.000Z";

const turnOf = (request: string, at: string, outcome: NoteTurn["outcome"] = "landed"): NoteTurn =>
  ({
    id: `turn-${at}`,
    request,
    quote: "",
    reply: "",
    outcome,
    problem: null,
    at,
    citations: [],
    questions: [],
    closed: [],
    mode: null,
  }) as NoteTurn;

/** A stopped call whose notes the User's own AI writes, as Stop leaves it. */
const ownAiCall = (overrides: Partial<Meeting> = {}) =>
  meetingOf({
    stoppedAt: STOPPED_AT,
    fill: { state: "own-ai", agentId: "pairing", mode: null, local: false, problem: null },
    ...overrides,
  } as Partial<Meeting>);

/** Shows the Note again, as closing and reopening its tab does. */
async function reopen() {
  await act(async () => root?.unmount());
  root = createRoot(container);
  await show();
}

describe("the meeting's control and sheet after #3762's review", () => {
  beforeEach(async () => {
    actions.core = {};
    const { useRequests } = await import("../../src/renderer/src/requests");
    useRequests.setState({ deleteAudio: null });
    useMeetings.setState({ detailsShown: {} });
  });

  test.each(["en", "zh-CN"] as const)(
    "Write notes shows while the notes can be written, and once asked stays gone across a reopen (%s)",
    async (language) => {
      actions.language = language;
      const asked = translate(language, "meetings.foot.writeNotesRequest");
      let turns: NoteTurn[] = [];
      actions.core.noteConversation = async () => turns;
      useMeetings.setState({ meetings: [ownAiCall()] });
      await show();
      const write = find("meeting-write-notes");
      expect(write.textContent).toBe(translate(language, "meetings.foot.writeNotes"));
      // The design system's primary button, at its own height and padding.
      expect(write.className).toContain("bg-ink");
      expect(write.className).toContain("h-8");

      // Asked before Stop, or asked and failed, it is still to do.
      turns = [
        turnOf(asked, "2026-11-25T09:59:00.000Z"),
        turnOf(asked, "2026-11-25T10:01:00.000Z", "failed"),
      ];
      await reopen();
      expect(container.querySelector('[data-testid="meeting-write-notes"]')).not.toBeNull();

      // Asked since Stop, in either language, it stays gone when the Note opens again.
      turns = [turnOf(translate("en", "meetings.foot.writeNotesRequest"), "2026-11-25T10:02:00Z")];
      await reopen();
      expect(container.querySelector('[data-testid="meeting-write-notes"]')).toBeNull();
      turns = [
        turnOf(translate("zh-CN", "meetings.foot.writeNotesRequest"), "2026-11-25T10:02:00Z"),
      ];
      await reopen();
      expect(container.querySelector('[data-testid="meeting-write-notes"]')).toBeNull();

      // Not while it records, nor when the notes are another model's to write.
      turns = [];
      useMeetings.setState({ meetings: [ownAiCall({ status: "paused" })] });
      await reopen();
      expect(container.querySelector('[data-testid="meeting-write-notes"]')).toBeNull();
      useMeetings.setState({ meetings: [ownAiCall({ fill: null })] });
      await reopen();
      expect(container.querySelector('[data-testid="meeting-write-notes"]')).toBeNull();
    },
  );

  test("Write notes goes at once when pressed and stays gone across a reopen while its request runs", async () => {
    const stoppedAt = "2026-11-25T11:00:00.000Z";
    actions.core.askInNote = async () => ({
      kind: "started",
      turnId: "write-turn",
      pairing: { id: "pairing", name: "Claude Code" },
    });
    useMeetings.setState({ meetings: [ownAiCall({ stoppedAt })] });
    await show();
    await click("meeting-write-notes");
    expect(container.querySelector('[data-testid="meeting-write-notes"]')).toBeNull();
    await reopen();
    expect(container.querySelector('[data-testid="meeting-write-notes"]')).toBeNull();
    expect(actions.reportError).not.toHaveBeenCalled();
  });

  test.each(["en", "zh-CN"] as const)(
    "while the system's permission prompt is open, the control and the sheet say so, with no level or timer (%s)",
    async (language) => {
      actions.language = language;
      useMeetings.setState({
        meetings: [
          meetingOf({
            id: "waiting-call",
            status: "recording",
            sources: { microphone: "waiting", system: "recording" },
          } as Partial<Meeting>),
        ],
      });
      await show();
      const level = find("meeting-foot-level");
      const waiting = translate(language, "meetings.bar.waiting");
      expect(level.getAttribute("title")).toBe(waiting);
      expect(level.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(waiting);
      expect(level.querySelector('[data-testid="level-bars"]')).toBeNull();
      await click("meeting-foot-transcript");
      const sheet = find("meeting-sheet");
      expect(find("meeting-sheet-waiting", sheet).textContent).toBe(waiting);
      expect(sheet.querySelector('[role="timer"]')).toBeNull();
      // Answered, the level and the time come back.
      await act(async () =>
        useMeetings.setState({
          meetings: [
            meetingOf({
              id: "waiting-call",
              status: "recording",
              sources: { microphone: "recording", system: "recording" },
            } as Partial<Meeting>),
          ],
        }),
      );
      expect(find("meeting-foot-level").getAttribute("title")).toBe(
        translate(language, "meetings.level.label"),
      );
      expect(sheet.querySelector('[role="timer"]')?.textContent).toBe("1:00");
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "audio that couldn't be saved while it records shows over the control, or in the sheet while it is up, never both (%s)",
    async (language) => {
      actions.language = language;
      useMeetings.setState({
        meetings: [
          meetingOf({
            status: "recording",
            health: {
              realTimeFactor: null,
              measuredMs: 0,
              keepsUp: null,
              events: [{ kind: "audioLost", cause: "full", atMs: 0, durationMs: 5000 }],
            },
          } as unknown as Partial<Meeting>),
        ],
      });
      await show();
      const unsaved = () => [
        ...container.querySelectorAll<HTMLElement>('[data-testid="meeting-line-unsaved"]'),
      ];
      expect(unsaved()).toHaveLength(1);
      expect(unsaved()[0]?.closest(".meeting-foot-over")).not.toBeNull();
      const { durationLabel } = await import("../../src/renderer/src/meetingTime");
      expect(unsaved()[0]?.textContent).toContain(
        translate(language, "meetings.health.unsaved", {
          duration: durationLabel(5000, (key, params) => translate(language, key, params)),
        }),
      );
      await click("meeting-foot-transcript");
      expect(unsaved()).toHaveLength(1);
      expect(unsaved()[0]?.closest('[data-testid="meeting-sheet"]')).not.toBeNull();
      // Its Details opens the sheet's recording details, in place.
      await click("meeting-line-details", find("meeting-sheet"));
      expect(find("meeting-sheet-details")).toBeDefined();
    },
  );

  test("after Stop the sheet's foot holds the template and Fill in again behind ⋯ once the notes can be filled in again", async () => {
    useMeetings.setState({
      meetings: [
        meetingOf({
          fill: { state: "filling", mode: "notes", local: false, problem: null },
        } as Partial<Meeting>),
      ],
    });
    await show();
    await click("meeting-foot-transcript");
    const foot = () => find("meeting-sheet-foot");
    expect(foot().querySelector('[data-testid="meeting-sheet-more"]')).toBeNull();
    await act(async () =>
      useMeetings.setState({
        meetings: [
          meetingOf({
            fill: { state: "filled", mode: "notes", local: false, problem: null },
          } as Partial<Meeting>),
        ],
      }),
    );
    const more = find("meeting-sheet-more", foot());
    expect(more.getAttribute("aria-label")).toBe(translate("en", "meetings.bar.more"));
    expect(find("meeting-sheet-resume-meeting", foot())).toBeDefined();
    expect(find("meeting-sheet-review-speakers", foot())).toBeDefined();
  });

  test("Esc inside the audio's question keeps the audio and leaves the sheet up; the next Esc folds it", async () => {
    await show();
    await act(async () => useMeetings.getState().showDetails("meeting", true));
    await click("meeting-foot-transcript");
    await click("meeting-audio-delete", find("meeting-sheet"));
    const question = find("meeting-audio-confirm");
    const keep = find("meeting-audio-delete-confirm", question);
    let event: Event | null = null;
    await act(async () => {
      event = pressEscape(keep);
    });
    expect(event).not.toBeNull();
    expect(container.querySelector('[data-testid="meeting-audio-confirm"]')).toBeNull();
    expect(find("meeting-audio")).toBeDefined();
    expect(sheetIn()).not.toBeNull();
    // The test's document knows no :modal; no dialog is open.
    const query = document.querySelector.bind(document);
    vi.spyOn(document, "querySelector").mockImplementation((selector: string) =>
      selector === "dialog:modal" ? null : query(selector),
    );
    await act(async () => {
      pressEscape(window);
    });
    expect(sheetIn()).toBeNull();
  });

  test("Esc inside the speaker review closes the review, and only the review", async () => {
    await show();
    await click("meeting-foot-transcript");
    // The sheet opens the review from its foot: the Transcript's own opener stays out.
    const body = find("meeting-sheet").querySelector<HTMLElement>(".meeting-sheet-body");
    if (!body) throw new Error("Missing the sheet's body");
    expect(body.textContent).not.toContain(translate("en", "meetings.review.open"));
    await click("meeting-sheet-review-speakers");
    const panel = () =>
      find("meeting-sheet").querySelector<HTMLElement>(
        `section[aria-label="${translate("en", "meetings.review.title")}"]`,
      );
    const open = panel();
    if (!open) throw new Error("The review didn't open");
    await act(async () => {
      pressEscape(open);
    });
    expect(panel()).toBeNull();
    expect(sheetIn()).not.toBeNull();
  });

  test("⌘K's Delete audio on a stopped call with the sheet down raises it at the audio's question, and folding it keeps the audio", async () => {
    await show();
    expect(sheetIn()).toBeNull();
    await act(async () => command("meeting.deleteAudio").run(PALETTE));
    const sheet = find("meeting-sheet");
    expect(find("meeting-sheet-details", sheet)).toBeDefined();
    const question = find("meeting-audio-confirm", sheet);
    expect(question.textContent).toContain(translate("en", "meetings.audio.confirm"));
    await click("meeting-sheet-hide");
    expect(sheetIn()).toBeNull();
    const { useRequests } = await import("../../src/renderer/src/requests");
    expect(useRequests.getState().deleteAudio).toBeNull();
  });

  test("the unsaved audio's Details on a stopped call's page raises the sheet with its details open", async () => {
    const path = "../../src/renderer/src/components/MeetingInMind.tsx";
    const { raiseMeetingDetails } = (await import(path)) as {
      raiseMeetingDetails(tabId: string, meeting: { id: string; mindId: string }): void;
    };
    await show();
    await act(async () => raiseMeetingDetails("tab", { id: "meeting", mindId: "note" }));
    expect(find("meeting-sheet-details", find("meeting-sheet"))).toBeDefined();
  });

  test.each([
    [
      "en",
      "soniox",
      "Transcribing with Soniox. The Transcript opens here. Tell everyone you’re recording.",
    ],
    ["zh-CN", "soniox", "正在用 Soniox 转写。转写稿在这里打开。告诉所有人你正在录音。"],
    ["zh-CN", "qwen", "正在用通义千问转写。转写稿在这里打开。告诉所有人你正在录音。"],
    [
      "en",
      null,
      "Transcribing on this computer. The Transcript opens here. Tell everyone you’re recording.",
    ],
  ] as const)(
    "the first tip names the way it transcribes and says to tell everyone (%s, %s)",
    async (language, cloud, said) => {
      actions.language = language;
      useMeetings.setState({
        meetings: [
          meetingOf({
            id: `tip-${language}-${cloud}`,
            status: "recording",
            transcript: { documentId: "transcript", lines: 1, state: "live", partials: [], cloud },
          } as unknown as Partial<Meeting>),
        ],
      });
      await show();
      expect(find("meeting-foot-tip").textContent).toBe(said);
      await click("meeting-foot-tip-close");
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "after its audio was deleted and the call resumed, only the lines said since play (%s)",
    async (language) => {
      actions.language = language;
      served =
        "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\n<v Me>Before the deletion.\n\n" +
        "00:00:03.000 --> 00:00:05.000\n<v Them>After the resume.\n";
      useMeetings.setState({
        meetings: [
          meetingOf({
            audio: {
              kept: true,
              expiresAt: "2026-11-08T12:54:00.000Z",
              deletedAt: null,
              keptUntilDeleted: false,
              keptFromMs: 2500,
            },
          } as Partial<Meeting>),
        ],
      });
      await show();
      await click("meeting-foot-transcript");
      const [before, after] = [
        ...find("meeting-sheet").querySelectorAll<HTMLElement>('[data-testid="transcript-line"]'),
      ];
      if (!before || !after) throw new Error("Missing the Transcript's two lines");
      expect(before.querySelector("[data-word]")?.hasAttribute("data-playable")).toBe(false);
      expect(after.querySelector("[data-word]")?.getAttribute("data-playable")).toBe("true");
      const play = command("meeting.playFromHere");
      await act(async () => before.dispatchEvent(new window.Event("focusin", { bubbles: true })));
      expect(play.enabled?.(PALETTE)).toEqual({ reason: "meetings.command.lineAudioDeleted" });
      expect(translate(language, "meetings.command.lineAudioDeleted")).not.toBe("");
      await act(async () => after.dispatchEvent(new window.Event("focusin", { bubbles: true })));
      expect(play.enabled?.(PALETTE)).toBe(true);
    },
  );

  test("a turn running across the deletion point offers to play only its words said since", async () => {
    served =
      "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\n<v Me>Before the deletion.\n\n" +
      "00:00:03.000 --> 00:00:05.000\n<v Me>After the resume.\n";
    useMeetings.setState({
      meetings: [
        meetingOf({
          audio: {
            kept: true,
            expiresAt: "2026-11-08T12:54:00.000Z",
            deletedAt: null,
            keptUntilDeleted: false,
            keptFromMs: 2500,
          },
        } as Partial<Meeting>),
      ],
    });
    await show();
    await click("meeting-foot-transcript");
    const turns = find("meeting-sheet").querySelectorAll('[data-testid="transcript-turn"]');
    expect(turns).toHaveLength(1);
    const [before, after] = [
      ...find("meeting-sheet").querySelectorAll<HTMLElement>('[data-testid="transcript-line"]'),
    ];
    if (!before || !after) throw new Error("Missing the turn's two lines");
    for (const word of before.querySelectorAll<HTMLElement>("[data-word]")) {
      expect(word.hasAttribute("data-playable")).toBe(false);
      expect(word.getAttribute("title")).toBeNull();
    }
    for (const word of after.querySelectorAll<HTMLElement>("[data-word]")) {
      expect(word.getAttribute("data-playable")).toBe("true");
      expect(word.getAttribute("title")).toBe(translate("en", "transcript.word.play"));
    }
  });

  test("a press on the control or its cards keeps the conversation open; the sheet rising folds it", async () => {
    const { useNoteColumns } = await import("../../src/renderer/src/ownAiInNote");
    useMeetings.setState({
      meetings: [
        meetingOf({
          status: "recording",
          transcript: { documentId: "transcript", lines: 1, state: "live", partials: [] },
        } as unknown as Partial<Meeting>),
      ],
    });
    await show();
    const beside = find("meeting-foot").closest("[data-beside-conversation]");
    expect(beside).not.toBeNull();
    expect(beside?.querySelector(".meeting-foot-over")).not.toBeNull();
    useNoteColumns.setState((state) => ({ open: { ...state.open, note: true } }));
    await click("meeting-foot-transcript");
    expect(sheetIn()).not.toBeNull();
    expect(useNoteColumns.getState().open.note).toBe(false);
  });

  test("the sheet's Transcript leaves out its own header, head line and Review speakers… opener", async () => {
    await show();
    await click("meeting-foot-transcript");
    const sheet = find("meeting-sheet");
    expect(sheet.querySelector('[data-testid="viewer-embedded-header"]')).toBeNull();
    expect(sheet.querySelector('[data-testid="transcript-count"]')).toBeNull();
    // The one line under the sheet's head is the sheet's own.
    const heads = [...sheet.querySelectorAll('[data-testid="transcript-head"]')];
    expect(heads).toHaveLength(1);
    expect(heads[0]?.closest(".meeting-sheet-consent")).not.toBeNull();
    expect(sheet.querySelector(".transcript-review-row")).toBeNull();
  });
});
