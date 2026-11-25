import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, useContext, useEffect } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Document, Meeting, Mind, WindowLayout } from "../../src/core/api";
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
  language: "en" as "en" | "zh-CN",
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
    gapsSeen: Record<string, number>;
    screenExplained: Record<string, boolean>;
    showDetails: (meetingId: string) => void;
  }>()((set) => ({
    meetings: [],
    detailsShown: {},
    audioProblems: {},
    problems: {},
    gapsSeen: {},
    screenExplained: {},
    showDetails: (meetingId) =>
      set((state) => ({
        detailsShown: { ...state.detailsShown, [meetingId]: !state.detailsShown[meetingId] },
      })),
  }));
  return {
    useMeetings,
    useMeetingOf: (mindId: string) =>
      useMeetings((state) => state.meetings.find((meeting) => meeting.mindId === mindId)),
    useMeetingTime: (meeting: Meeting) => meeting.recordedMs,
    canRecordMeetings: () => false,
    isLive: (meeting?: Meeting) => meeting?.status === "recording" || meeting?.status === "paused",
    isWaitingForPermission: () => false,
  };
});
vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy(
    {},
    { get: (_target, name) => (name === "on" ? () => () => undefined : async () => []) },
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
vi.mock("../../src/renderer/src/components/MeetingInMind", () => ({
  MeetingInMind: () => null,
  MeetingAudioLine: () => null,
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
    useRequests: create<{ deleteAudio: null; clear: () => void }>()(() => ({
      deleteAudio: null,
      clear: () => undefined,
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
