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
    showDetails: (meetingId: string) => void;
  }>()((set) => ({
    meetings: [],
    detailsShown: {},
    audioProblems: {},
    showDetails: (meetingId) =>
      set((state) => ({
        detailsShown: { ...state.detailsShown, [meetingId]: !state.detailsShown[meetingId] },
      })),
  }));
  return {
    useMeetings,
    useMeetingOf: (mindId: string) =>
      useMeetings((state) => state.meetings.find((meeting) => meeting.mindId === mindId)),
    canRecordMeetings: () => false,
    isLive: (meeting?: Meeting) => meeting?.status === "recording" || meeting?.status === "paused",
  };
});
vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy(
    {},
    { get: (_target, name) => (name === "on" ? () => () => undefined : async () => []) },
  ),
  files: {},
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
  LiveMeetingBar: () => createElement("section", { "data-testid": "meeting-bar" }),
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
vi.mock("../../src/renderer/src/citationVersion", () => ({ useCitationRecheck: () => null }));
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
vi.mock("../../src/renderer/src/motion", () => ({ enterFrom: vi.fn(), exitToward: vi.fn() }));

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
  views.useMeetingNoteViews.setState({ views: {} });
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

describe("the Meeting's Note-local views", () => {
  test("switches the same tab without changing Layout and retains the editor and scroll", async () => {
    await show();
    const editor = find("retained-editor") as HTMLInputElement;
    editor.value = "Typed while recording";
    const scroller = find("mind-scroller");
    scroller.scrollTop = 137;
    expect(find("meeting-view-chip").textContent).toContain("Recorded 1:00");
    await click("meeting-view-transcript");
    expect(find("mind-scroller").style.visibility).toBe("hidden");
    expect(container.querySelector<HTMLElement>(".mind-foot-slot")?.style.display).toBe("none");
    expect(container.querySelector(".review-slot")?.getAttribute("data-shown")).toBe("closed");
    expect(find("meeting-note-transcript").textContent).toContain("Keep the go-live date.");
    expect(find("transcript-count").textContent).toBe("1 line");
    expect(find("meeting-view-chip").textContent).toContain("Transcript");
    expect(container.querySelector('[data-testid="viewer-title"]')).toBeNull();
    expect(container.querySelector('[data-testid="document-menu"]')).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("transcript");
    await click("transcript-add");
    expect(actions.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: "meeting",
        document: expect.objectContaining({ id: "transcript" }),
        cue: expect.objectContaining({ text: "Keep the go-live date." }),
      }),
    );
    await click("meeting-view-notes");
    expect(container.querySelector('[data-testid="meeting-note-transcript"]')).toBeNull();
    expect(find("retained-editor")).toBe(editor);
    expect(editor.value).toBe("Typed while recording");
    expect(scroller.scrollTop).toBe(137);
    expect(scroller.style.visibility).not.toBe("hidden");
    expect(container.querySelector<HTMLElement>(".mind-foot-slot")?.style.display).not.toBe("none");
    expect(container.querySelector(".review-slot")?.getAttribute("data-shown")).toBe("beside");
    expect(actions.mounts).toHaveBeenCalledTimes(1);
    expect(actions.unmounts).not.toHaveBeenCalled();
    expect(actions.changeLayout).not.toHaveBeenCalled();
    expect(actions.showTranscript).not.toHaveBeenCalled();
    expect(useAppStore.getState().layout?.groups[0]?.tabs[0]?.id).toBe("tab");
  });

  test("keeps two tabs of one Note independent and a reused tab defaults to Notes", async () => {
    await show([
      { tabId: "tab", mindId: "note" },
      { tabId: "second", mindId: "note" },
    ]);
    const first = container.querySelector('[data-tab-id="tab"]');
    const second = container.querySelector('[data-tab-id="second"]');
    if (!first || !second) throw new Error("Missing tabs");
    await click("meeting-view-transcript", first);
    expect(first.querySelector('[data-testid="meeting-note-transcript"]')).not.toBeNull();
    expect(second.querySelector('[data-testid="meeting-note-transcript"]')).toBeNull();
    await act(async () =>
      useMeetings.setState({
        meetings: [meetingOf(), meetingOf({ id: "other-meeting", mindId: "other" })],
      }),
    );
    await show([{ tabId: "tab", mindId: "other" }]);
    expect(container.querySelector('[data-testid="meeting-note-transcript"]')).toBeNull();
    expect(find("mind-scroller").style.visibility).not.toBe("hidden");
  });

  test.each(["pending", "missing", "failed"] as const)(
    "keeps %s file states in place without Document rename chrome",
    async (state) => {
      response = state;
      await show();
      await click("meeting-view-transcript");
      const transcript = find("meeting-note-transcript");
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
    await click("meeting-view-transcript");
    expect(find("meeting-note-transcript").textContent).toContain("Opening the Document");
    expect(requests).toHaveLength(0);
    await act(async () => useAppStore.setState({ documents: [documentOf()] }));
    expect(find("meeting-note-transcript").textContent).toContain("Keep the go-live date.");
    expect(requests).toHaveLength(1);
  });

  test("focuses the accessible Transcript region once per opening, not on metadata updates", async () => {
    await show();
    await click("meeting-view-transcript");
    expect(find("meeting-note-transcript").tagName).toBe("SECTION");
    expect(find("meeting-note-transcript").getAttribute("aria-label")).toBe("Transcript");
    expect(find("meeting-note-transcript").getAttribute("tabindex")).toBe("-1");
    expect(
      actions.focus.mock.calls.filter(([id]) => id === "meeting-note-transcript"),
    ).toHaveLength(1);
    await act(async () =>
      useAppStore.setState({ documents: [{ ...documentOf(), contentHash: "v2" }] }),
    );
    expect(
      actions.focus.mock.calls.filter(([id]) => id === "meeting-note-transcript"),
    ).toHaveLength(1);
    await click("meeting-view-notes");
    await click("meeting-view-transcript");
    expect(
      actions.focus.mock.calls.filter(([id]) => id === "meeting-note-transcript"),
    ).toHaveLength(2);
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
    await click("meeting-view-transcript");
    expect(find("viewer-retry")).toBeDefined();
    response = "ready";
    await click("viewer-retry");
    expect(actions.retryDocument).toHaveBeenCalledWith("transcript");
    expect(find("meeting-note-transcript").textContent).toContain("Keep the go-live date.");
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
    const turns = () => [...container.querySelectorAll('[data-testid="transcript-turn"]')];
    expect(turns()).toHaveLength(1);
    const turn = turns()[0] as HTMLElement;
    const scroller = find("viewer-transcript");
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

  test("adds no chip to a Voice memo, and no Transcript view to a call without a Transcript", async () => {
    useMeetings.setState({ meetings: [meetingOf({ kind: "memo" })] });
    await show();
    expect(container.querySelector('[data-testid="meeting-view-chip"]')).toBeNull();
    await act(async () => useMeetings.setState({ meetings: [meetingOf({ transcript: null })] }));
    expect(find("meeting-view-chip").textContent).toContain("Recorded 1:00");
    expect(find("meeting-view-notes")).toBeDefined();
    expect(container.querySelector('[data-testid="meeting-view-transcript"]')).toBeNull();
  });

  test.each(["en", "zh-CN"] as const)("uses labelled radio choices in %s", async (language) => {
    actions.language = language;
    await show();
    expect(find("meeting-view-menu").getAttribute("aria-label")).toBe(
      translate(language, "meetings.views.label"),
    );
    expect(find("meeting-view-notes").getAttribute("role")).toBe("menuitemradio");
    expect(find("meeting-view-notes").getAttribute("aria-checked")).toBe("true");
    await click("meeting-view-transcript");
    expect(find("meeting-view-transcript").getAttribute("aria-checked")).toBe("true");
    expect(find("meeting-view-chip").textContent).toContain(
      translate(language, "meetings.views.transcript"),
    );
  });

  test.each(["stopped", "recording"] as const)(
    "⌘K's views of a %s call switch the page in place and Open beside opens the Transcript next to it",
    async (status) => {
      useMeetings.setState({ meetings: [meetingOf({ status })] });
      await show();
      const command = (id: string) => {
        const found = meetingCommands.find((each) => each.id === id);
        if (!found) throw new Error(`Missing ${id}`);
        return found;
      };
      const context = { surface: "palette", selection: [], focus: null } as const;
      expect(command("meeting.showNotes").when?.(context)).toBe(false);
      expect(command("meeting.showTranscript").when?.(context)).toBe(true);
      expect(command("meeting.showTranscript").label).toBe("meetings.views.showTranscript");
      await act(async () => command("meeting.showTranscript").run(context));
      expect(find("meeting-note-transcript")).toBeDefined();
      expect(command("meeting.showTranscript").when?.(context)).toBe(false);
      await act(async () => command("meeting.previousView").run(context));
      expect(container.querySelector('[data-testid="meeting-note-transcript"]')).toBeNull();
      await act(async () => command("meeting.nextView").run(context));
      expect(find("meeting-note-transcript")).toBeDefined();
      expect(command("meeting.previousView").shortcut?.keys).toBe("CmdOrCtrl+Alt+Left");
      expect(command("meeting.nextView").shortcut?.keys).toBe("CmdOrCtrl+Alt+Right");
      expect(command("meeting.nextView").palette).toBe(false);
      expect(command("meeting.transcriptBeside").enabled?.(context)).toBe(true);
      await act(async () => command("meeting.transcriptBeside").run(context));
      expect(actions.openBeside).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: "tab", groupId: "group" }),
      );
      expect(actions.changeLayout).not.toHaveBeenCalled();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "while it records, the Transcript view shows both sides' words being said before its first line, under the bar (%s)",
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
      const transcript = find("meeting-note-transcript");
      expect(find("meeting-bar", transcript)).toBeDefined();
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
      const beside = find("meeting-transcript-beside", transcript) as HTMLButtonElement;
      expect(beside.textContent).toBe(translate(language, "command.openBeside"));
      expect(beside.disabled).toBe(true);
      expect(beside.title).toBe(translate(language, "meetings.bar.transcriptSoon"));
      expect(container.querySelector('[data-testid="meeting-view-chip"]')).toBeNull();
    },
  );

  test("before its first line, a live call's Transcript can't open beside yet, and says why", async () => {
    useMeetings.setState({
      meetings: [
        meetingOf({
          status: "recording",
          transcript: { documentId: null, lines: 0, state: "live", partials: [] },
        } as unknown as Partial<Meeting>),
      ],
    });
    await show();
    const command = meetingCommands.find((each) => each.id === "meeting.transcriptBeside");
    const context = { surface: "palette", selection: [], focus: null } as const;
    expect(command?.enabled?.(context)).toEqual({ reason: "meetings.bar.transcriptSoon" });
  });
});
