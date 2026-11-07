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
  hideTranscript: vi.fn(),
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
  const useMeetings = create<{ meetings: Meeting[] }>()(() => ({ meetings: [] }));
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
vi.mock("../../src/renderer/src/components/MeetingInMind", () => ({ MeetingInMind: () => null }));
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
vi.mock("../../src/renderer/src/requests", () => ({ useRequests: { getState: () => ({}) } }));
vi.mock("../../src/renderer/src/transcripts", () => ({
  showTranscript: actions.showTranscript,
  hideTranscript: actions.hideTranscript,
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
    this.response = new TextEncoder().encode(
      "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Me>Keep the go-live date.\n",
    ).buffer;
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
    transcript: { documentId: "transcript", lines: 1, state: "saved" },
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
    expect(find("mind-scroller").style.display).toBe("none");
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
    expect(scroller.style.display).not.toBe("none");
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
    expect(find("mind-scroller").style.display).not.toBe("none");
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
    expect(actions.focus).toHaveBeenLastCalledWith("meeting-view-chip");
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

  test("does not add views to a Voice memo or a Meeting without a Transcript", async () => {
    useMeetings.setState({ meetings: [meetingOf({ kind: "memo" })] });
    await show();
    expect(container.querySelector('[data-testid="meeting-view-chip"]')).toBeNull();
    await act(async () => useMeetings.setState({ meetings: [meetingOf({ transcript: null })] }));
    expect(container.querySelector('[data-testid="meeting-view-chip"]')).toBeNull();
  });

  test.each(["en", "zh-CN"] as const)("uses labelled radio choices in %s", async (language) => {
    actions.language = language;
    await show();
    expect(find("meeting-view-chip").getAttribute("aria-label")).toBe(
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

  test("the stopped Meeting's Transcript command uses the same local action without opening a Document tab", async () => {
    await show();
    const command = meetingCommands.find((each) => each.id === "meeting.transcript");
    if (!command) throw new Error("Missing Transcript command");
    const context = { surface: "palette", selection: [], focus: null } as const;
    expect(command.when?.(context)).toBe(true);
    expect(command.enabled?.(context)).toBe(true);
    if (typeof command.label !== "function") throw new Error("Expected a view-aware label");
    expect(command.label(context, translate.bind(null, "en"))).toBe("Transcript");
    await act(async () => command.run(context));
    expect(find("meeting-note-transcript")).toBeDefined();
    expect(command.label(context, translate.bind(null, "en"))).toBe("Notes");
    expect(command.keywords).toContain("meetings.views.transcript");
    await act(async () => command.run(context));
    expect(container.querySelector('[data-testid="meeting-note-transcript"]')).toBeNull();
    expect(actions.showTranscript).not.toHaveBeenCalled();
    expect(actions.changeLayout).not.toHaveBeenCalled();
  });

  test("the live Meeting's existing Transcript command still opens a Document beside it", async () => {
    useMeetings.setState({ meetings: [meetingOf({ status: "recording" })] });
    await show();
    const command = meetingCommands.find((each) => each.id === "meeting.transcript");
    if (!command) throw new Error("Missing Transcript command");
    const context = { surface: "palette", selection: [], focus: null } as const;
    await act(async () => command.run(context));
    expect(actions.showTranscript).toHaveBeenCalledWith("transcript", "group");
    expect(views.meetingNoteViewFor("tab", "note")).toBe("notes");
    expect(container.querySelector('[data-testid="meeting-view-chip"]')).toBeNull();
  });
});
