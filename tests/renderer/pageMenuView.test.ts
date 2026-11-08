import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, PROPOSAL_INSERT_MARK } from "../../src/core/api";
import { AppliedEditLine, appliedLineIn } from "../../src/renderer/src/editor/appliedEditLine";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { ProposalReview } from "../../src/renderer/src/editor/proposalReview";
import {
  meetingNoteViewFor,
  showMeetingNoteView,
  useMeetingNoteView,
  useMeetingNoteViews,
} from "../../src/renderer/src/meetingViews";
import { holdReviewable, useReviewPanes } from "../../src/renderer/src/reviewPane";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const MIND = "meeting-note";
const TAB = "meeting-tab";
const ui = vi.hoisted(() => ({ close: vi.fn(), word: false }));

vi.mock("../../src/renderer/src/core", () => ({
  core: { recordAiUse: async () => undefined },
  files: {},
}));
vi.mock("../../src/renderer/src/editWithAi", () => ({ speak: () => undefined }));
vi.mock("../../src/renderer/src/mindCopies", () => ({
  EDIT_FROM_CORE: Symbol("edit-from-core"),
  FROM_CORE: Symbol("from-core"),
}));
vi.mock("../../src/renderer/src/store", () => {
  const state = {
    minds: [{ id: "meeting-note", title: "Meeting", folderId: null }],
    documents: [],
    reportError: (error: unknown) => {
      throw error;
    },
  };
  return {
    useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
      getState: () => state,
    }),
    allExamples: () => [],
  };
});
vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey, params?: MessageParams) => translate("en", key, params),
  translateNow: (key: MessageKey, params?: MessageParams) => translate("en", key, params),
  useLanguage: () => "en",
}));
vi.mock("../../src/renderer/src/components/ObjectMenu", () => ({
  ObjectMenu: ({ more }: { more?: (close: () => void) => ReactNode }) =>
    createElement("div", {}, more?.(ui.close)),
}));
vi.mock("../../src/renderer/src/components/tabs/tabItems", () => ({
  useTabPlace: () => ({ tabId: "meeting-tab", groupId: "group" }),
}));
vi.mock("../../src/renderer/src/components/usePopoverMenu", () => ({
  useSubmenu: () => ({ itemProps: {}, menuProps: {} }),
}));
vi.mock("../../src/renderer/src/components/MindStyle", () => ({
  useStyleValue: () => "Default",
  MindStyleChoices: () => null,
}));
vi.mock("../../src/renderer/src/components/ExamplesMenu", () => ({ ExampleChoices: () => null }));
vi.mock("../../src/renderer/src/components/MoveToPicker", () => ({ MoveToPicker: () => null }));
vi.mock("../../src/renderer/src/firstOpen", () => ({ useFirstOpen: () => false }));
vi.mock("../../src/renderer/src/folderDrag", () => ({}));
vi.mock("../../src/renderer/src/fileInfo", () => ({}));
vi.mock("../../src/renderer/src/linkedFolders", () => ({}));
vi.mock("../../src/renderer/src/mindStylePanel", () => ({}));
vi.mock("../../src/renderer/src/verify", () => ({}));
vi.mock("../../src/renderer/src/editor/LookMenu", () => ({ LookMenuItems: () => null }));
vi.mock("../../src/renderer/src/editor/MindSourceFoot", () => ({ MindSourceFoot: () => null }));
vi.mock("../../src/renderer/src/editor/WordCount", () => ({ MindCounts: () => null }));
vi.mock("../../src/renderer/src/editor/WordOrigin", () => ({
  useWordFile: () => ({
    file: ui.word ? { name: "Meeting.docx", documentId: null } : null,
    report: null,
  }),
  wordFileTooltip: () => "Word file",
}));

interface PageMenuProps {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  verification: null;
  readOnly: boolean;
  revealEditor(): void;
}

let root: Root | null = null;
let container: HTMLElement;
let editor: Editor | null = null;
let doc: Y.Doc | null = null;
let PageMenu: ComponentType<PageMenuProps>;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(async () => {
  ui.close.mockClear();
  ui.word = false;
  useMeetingNoteViews.setState({ views: {} });
  useReviewPanes.setState({ panes: {} });
  frames.clear();
  nextFrame = 0;
  const document = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
  Object.assign(document, { getSelection: () => null });
  const window = document.defaultView;
  for (const [name, value] of Object.entries({
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const path = "../../src/renderer/src/editor/PageMenu.tsx";
  ({ PageMenu } = await import(path));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  doc?.destroy();
  doc = null;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function noteWithAppliedEdit(): { editor: Editor; doc: Y.Doc } {
  const source = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "original" },
          content: [
            { type: "text", text: "Original " },
            {
              type: "text",
              text: "AI text",
              marks: [{ type: PROPOSAL_INSERT_MARK, attrs: { id: "change", request: "request" } }],
            },
          ],
        },
      ],
    },
  });
  doc = new Y.Doc();
  prosemirrorToYXmlFragment(source.state.doc, doc.getXmlFragment(MIND_CONTENT_FIELD));
  source.destroy();
  editor = new Editor({
    element: document.createElement("div"),
    editorProps: { handleScrollToSelection: () => true },
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      ProposalReview,
      AppliedEditLine.configure({ translate: (key) => key, undoKeys: () => "" }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return { editor, doc };
}

function NoteSurface({ editor }: { editor: Editor }) {
  const view = useMeetingNoteView(TAB, MIND);
  return createElement("div", {
    "data-testid": "note-surface",
    hidden: view !== "notes",
    ref: (element: HTMLDivElement | null) => {
      element?.append(editor.view.dom);
    },
  });
}

async function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => {
    for (const frame of pending) frame(0);
  });
}

test("Review changes reveals this tab's Note before focusing its retained editor", async () => {
  const { applyArrived, offersReview } = await import("../../src/renderer/src/appliedEdits");
  const { editor, doc } = noteWithAppliedEdit();
  expect(
    applyArrived(editor, MIND, new Set(["request"]), {
      created: false,
      changed: 1,
      wrote: 0,
      tables: 0,
    }),
  ).toBe("applied");
  expect(offersReview(editor)).toBe(true);
  showMeetingNoteView(TAB, MIND, "transcript");
  showMeetingNoteView("other-tab", MIND, "transcript");
  const focused: { view: string; hidden: boolean }[] = [];
  const reviewed: { view: string; hidden: boolean }[] = [];
  editor.on("transaction", () => {
    if (appliedLineIn(editor.state)?.kind !== "review" || reviewed.length > 0) return;
    const surface = container.querySelector<HTMLElement>('[data-testid="note-surface"]');
    if (!surface) throw new Error("The Note surface is missing");
    reviewed.push({ view: meetingNoteViewFor(TAB, MIND), hidden: surface.hasAttribute("hidden") });
  });
  vi.spyOn(editor.view, "focus").mockImplementation(() => {
    const surface = container.querySelector<HTMLElement>('[data-testid="note-surface"]');
    if (!surface) throw new Error("The Note surface is missing");
    focused.push({ view: meetingNoteViewFor(TAB, MIND), hidden: surface.hasAttribute("hidden") });
  });
  await act(async () => {
    root?.render(
      createElement(
        "div",
        {},
        createElement(PageMenu, {
          editor,
          doc,
          mindId: MIND,
          verification: null,
          readOnly: false,
          revealEditor: () => flushSync(() => showMeetingNoteView(TAB, MIND, "notes")),
        }),
        createElement(NoteSurface, { editor }),
      ),
    );
  });
  frames.clear();
  const button = container.querySelector('[data-testid="page-review-changes"]');
  if (!button) throw new Error("Review changes is missing");
  await act(async () => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  expect(ui.close).toHaveBeenCalledOnce();
  expect(meetingNoteViewFor(TAB, MIND)).toBe("transcript");
  expect(appliedLineIn(editor.state)?.kind).toBe("applied");
  await flushFrame();
  await flushFrame();
  expect(appliedLineIn(editor.state)?.kind).toBe("review");
  expect(reviewed).toEqual([{ view: "notes", hidden: false }]);
  expect(focused).toEqual([{ view: "notes", hidden: false }]);
  expect(meetingNoteViewFor("other-tab", MIND)).toBe("transcript");
});

test("Review their changes reveals the Note before opening its imported-Word review pane", async () => {
  ui.word = true;
  const { editor, doc } = noteWithAppliedEdit();
  onTestFinished(holdReviewable(MIND, { editor, has: () => true, open: () => undefined }));
  showMeetingNoteView(TAB, MIND, "transcript");
  showMeetingNoteView("other-tab", MIND, "transcript");
  await act(async () => {
    root?.render(
      createElement(
        "div",
        {},
        createElement(PageMenu, {
          editor,
          doc,
          mindId: MIND,
          verification: null,
          readOnly: false,
          revealEditor: () => flushSync(() => showMeetingNoteView(TAB, MIND, "notes")),
        }),
        createElement(NoteSurface, { editor }),
      ),
    );
  });
  const opened: { view: string; hidden: boolean }[] = [];
  onTestFinished(
    useReviewPanes.subscribe((state) => {
      if (!state.panes[MIND]?.over) return;
      const surface = container.querySelector<HTMLElement>('[data-testid="note-surface"]');
      if (!surface) throw new Error("The Note surface is missing");
      opened.push({ view: meetingNoteViewFor(TAB, MIND), hidden: surface.hasAttribute("hidden") });
    }),
  );
  const button = container.querySelector('[data-testid="page-review"]');
  if (!button) throw new Error("Review their changes is missing");
  await act(async () => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  expect(ui.close).toHaveBeenCalledOnce();
  expect(useReviewPanes.getState().panes[MIND]).toMatchObject({ over: true, opened: 1 });
  expect(opened).toEqual([{ view: "notes", hidden: false }]);
  expect(meetingNoteViewFor("other-tab", MIND)).toBe("transcript");
});
