import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mind, MindExportPreview } from "../../src/core/api";
import { type ExportResult, useExports } from "../../src/renderer/src/exports";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const state = vi.hoisted(() => ({
  language: "en" as "en" | "zh-CN",
  format: "docx" as "docx" | "pdf",
  preview: {
    fileName: "Memo.docx",
    pictures: [],
    citations: 0,
    citedDocuments: 0,
    numbered: true,
    unverifiedCitations: 0,
    questions: 0,
    hiddenColumns: 0,
    fromWord: true,
    theirChanges: 0,
    citationPlace: null,
    markAiText: true,
    othersFile: false,
    othersComments: false,
    myComments: 0,
    myCommentsShown: true,
    myCommentsOptional: true,
    fileComments: 0,
  } as MindExportPreview,
}));

vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => state.language,
  useT: () => (key: MessageKey, params?: MessageParams) => translate(state.language, key, params),
  translateNow: (key: MessageKey, params?: MessageParams) => translate(state.language, key, params),
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    previewMindExport: async () => state.preview,
    getExportMarks: async () => ({ pageNumbers: false, watermark: "none", watermarkText: "" }),
    getOutputSettings: async () => ({ location: null, defaultLocation: "/tmp/Exports" }),
    on: () => () => undefined,
  },
  files: {
    openSavedFile: async () => undefined,
    showSavedFile: async () => undefined,
  },
}));

vi.mock("../../src/renderer/src/commands/keymap", () => ({
  shortcutLabel: () => "⇧⌘E",
}));

const exportOptions = () => ({
  format: state.format,
  docx: {
    includeQuestions: false,
    trackChanges: true,
    markAiText: "mark" as const,
    commentFailedChecks: true,
  },
  pdf: { includeQuestions: false },
  html: { includeQuestions: false },
  markdown: { includeQuestions: false },
  citationPlace: "footnotes" as const,
});

vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: Object.assign(
    (
      selector: (store: {
        minds: Mind[];
        settings: { author: string; user: { exportOptions: ReturnType<typeof exportOptions> } };
      }) => unknown,
    ) =>
      selector({
        minds: [],
        settings: { author: "Priya Raman", user: { exportOptions: exportOptions() } },
      }),
    {
      getState: () => ({
        minds: [],
        settings: {
          language: state.language,
          author: "Priya Raman",
          user: { exportOptions: exportOptions() },
        },
        reportError: () => undefined,
        openSettings: () => undefined,
        updateSettings: async () => undefined,
      }),
    },
  ),
}));

vi.mock("../../src/renderer/src/citationStylePicker", () => ({
  useCitationStylePicker: () => () => undefined,
  useStyleLabel: () => "Numbered",
}));

vi.mock("../../src/renderer/src/home", () => ({
  useMindNoteStates: () => new Map(),
  ownMindsOf: () => [],
}));

vi.mock("../../src/renderer/src/motion", () => ({
  enter: () => undefined,
}));

vi.mock("../../src/renderer/src/useHeld", () => ({
  useHeld: () => false,
}));

vi.mock("../../src/renderer/src/components/useModal", () => ({
  useModal: () => undefined,
}));

vi.mock("../../src/renderer/src/escapeDismiss", () => ({
  useDismissOnEscape: () => undefined,
}));

const MIND: Mind = {
  id: "mind-1",
  title: "Memo",
  autoTitle: "",
  kind: "note",
  folderId: null,
  createdAt: "2026-10-02T09:00:00Z",
  updatedAt: "2026-10-02T09:00:00Z",
};

const BASE_SAVED: Extract<ExportResult, { state: "saved" }> = {
  mindId: MIND.id,
  state: "saved",
  format: "docx",
  path: "/tmp/Exports/Memo.docx",
  name: "Memo.docx",
  withCsv: false,
  failures: [],
  folder: "Exports",
  inDefaultFolder: true,
  at: Date.now(),
  unverified: 0,
  hiddenColumns: 0,
  othersFile: false,
  changedFile: null,
  checks: {
    contradicted: 0,
    notFound: 0,
    unsupported: 0,
    needsRecheck: 0,
    commented: false,
    comments: 0,
  },
  tracked: 0,
  kept: [],
  notKept: [],
  needsDetails: [],
  sentKept: true,
  defaulted: false,
  citations: 0,
  citedDocuments: 0,
  footnotes: 0,
  numbered: false,
  citationPlace: null,
  markAiText: true,
  myComments: 0,
  myCommentsShown: true,
  fileComments: 0,
};

let root: Root | null = null;
let container: HTMLElement;
let ExportDialog: ComponentType<{ mind: Mind | null; onClose(): void }>;
let ExportResultLine: ComponentType<{ mindId: string }>;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const globals: Record<string, unknown> = {
    document,
    window,
    navigator: { platform: "MacIntel" },
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  state.language = "en";
  state.format = "docx";
  state.preview = {
    ...state.preview,
    myComments: 0,
    myCommentsShown: true,
    myCommentsOptional: true,
    fileComments: 0,
  };
  useExports.setState({ result: null });
  const dialogPath = "../../src/renderer/src/components/ExportDialog.tsx";
  const resultPath = "../../src/renderer/src/components/ExportResultLine.tsx";
  ExportDialog = (await import(dialogPath)).ExportDialog;
  ExportResultLine = (await import(resultPath)).ExportResultLine;
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  useExports.setState({ result: null });
  vi.unstubAllGlobals();
});

async function renderDialog(mind: Mind | null): Promise<void> {
  await act(async () => {
    root?.render(createElement(ExportDialog, { mind, onClose: () => {} }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Export dialog disclosure for original Word file comments (#3821)", () => {
  test("shows the disclosure under Include my comments when both file and user comments exist, in EN and zh-CN", async () => {
    state.preview = {
      ...state.preview,
      myComments: 1,
      myCommentsOptional: true,
      fileComments: 2,
    };
    await renderDialog(MIND);

    const toggle = container.querySelector('[data-testid="export-include-my-comments"]');
    const note = container.querySelector('[data-testid="export-file-comments"]');
    expect(toggle).not.toBeNull();
    expect(note?.textContent).toBe("2 comments from the Word file stay in the exported file.");

    state.language = "zh-CN";
    await renderDialog(null);
    await renderDialog(MIND);
    expect(container.querySelector('[data-testid="export-file-comments"]')?.textContent).toBe(
      "原 Word 文件中的 2 条批注会保留在导出文件中。",
    );
  });

  test("still shows the disclosure in Word options when the User added no comments of their own", async () => {
    state.preview = {
      ...state.preview,
      myComments: 0,
      myCommentsOptional: false,
      fileComments: 1,
    };
    await renderDialog(MIND);

    expect(container.querySelector('[data-testid="export-include-my-comments"]')).toBeNull();
    expect(container.querySelector('[data-testid="export-file-comments"]')?.textContent).toBe(
      "1 comment from the Word file stays in the exported file.",
    );
  });

  test("omits the disclosure when fileComments is zero or the chosen format is not Word", async () => {
    state.preview = { ...state.preview, myComments: 1, myCommentsOptional: true, fileComments: 0 };
    await renderDialog(MIND);
    expect(container.querySelector('[data-testid="export-file-comments"]')).toBeNull();

    state.format = "pdf";
    state.preview = { ...state.preview, fileComments: 2 };
    await renderDialog(null);
    await renderDialog(MIND);
    expect(container.querySelector('[data-testid="export-file-comments"]')).toBeNull();
  });
});

describe("Saved line disclosure for original Word file comments (#3821)", () => {
  test("shows kept file comments alongside left-out user comments in EN and zh-CN", async () => {
    await act(() => {
      useExports.setState({
        result: {
          ...BASE_SAVED,
          at: Date.now(),
          myComments: 1,
          myCommentsShown: false,
          fileComments: 1,
        },
      });
      root?.render(createElement(ExportResultLine, { mindId: MIND.id }));
    });
    expect(container.querySelector('[data-testid="export-my-comments"]')?.textContent).toContain(
      "Your comment was left out",
    );
    expect(container.querySelector('[data-testid="export-file-comments"]')?.textContent).toBe(
      "Kept 1 comment from the Word file",
    );

    state.language = "zh-CN";
    await act(() => {
      useExports.setState({
        result: {
          ...BASE_SAVED,
          at: Date.now(),
          myComments: 0,
          myCommentsShown: true,
          fileComments: 3,
        },
      });
      root?.render(createElement(ExportResultLine, { mindId: MIND.id }));
    });
    expect(container.querySelector('[data-testid="export-file-comments"]')?.textContent).toBe(
      "已保留原文件中的 3 条批注",
    );
  });

  test("omits the part when fileComments is zero or the saved format is not Word", async () => {
    await act(() => {
      useExports.setState({
        result: { ...BASE_SAVED, at: Date.now(), fileComments: 0 },
      });
      root?.render(createElement(ExportResultLine, { mindId: MIND.id }));
    });
    expect(container.querySelector('[data-testid="export-file-comments"]')).toBeNull();

    await act(() => {
      useExports.setState({
        result: { ...BASE_SAVED, at: Date.now(), format: "pdf", fileComments: 2 },
      });
      root?.render(createElement(ExportResultLine, { mindId: MIND.id }));
    });
    expect(container.querySelector('[data-testid="export-file-comments"]')).toBeNull();
  });
});
