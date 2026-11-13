/**
 * A sentence whose figures the check couldn't read in a Document's page says which page, and its
 * card opens that page (#2510).
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaimCheckAttributes } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { unreadFiguresDetail } from "../../src/shared/unreadFigures";

const SENTENCE = "Revenue in 2024 was £20.";
const DETAIL = unreadFiguresDetail({
  documentId: "annual-report",
  documentName: "Annual report",
  contentHash: "v1",
  pageFrom: 14,
  pageTo: 14,
  location: { kind: "page", from: 14, to: 14 },
});

const CHECK: ClaimCheckAttributes = {
  id: "check",
  request: "request",
  action: "check-against-documents",
  state: "not-checked",
  text: SENTENCE,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  reason: "figures-not-read",
  detail: DETAIL,
  providerId: null,
  modelId: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [{ documentId: "annual-report", contentHash: "v1" }],
  excluded: [],
  checkedAt: "2026-11-04T00:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLElement;
let editor: Editor | null = null;

beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  const window = document.defaultView;
  const lists = new Set([
    "listUserQuestions",
    "listApprovalRequests",
    "listConsentRequests",
    "listRegisteredDataFlows",
    "listFileWriteRequests",
  ]);
  const bridge = new Proxy(
    { on: () => () => undefined },
    {
      get: (each, name) =>
        name in each
          ? each[name as keyof typeof each]
          : lists.has(String(name))
            ? () => Promise.resolve([])
            : () => Promise.resolve(undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function card(language: string) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  const openDocument = vi.fn();
  useAppStore.setState({
    settings: { language, user: { personId: "person" } },
    openDocument,
  } as never);
  const content: JSONContent[] = [
    { type: "paragraph", content: [{ type: "text", text: SENTENCE }] },
  ];
  editor = new Editor({
    element: globalThis.document.createElement("div"),
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  const claim = {
    check: CHECK,
    reads: CHECK,
    from: 0,
    to: SENTENCE.length,
    sentence: { from: 0, to: SENTENCE.length, text: SENTENCE },
    shown: { state: "not-checked" as const, reason: "figures-not-read" as const },
  };
  const noop = () => undefined;
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const cardPath = "../../src/renderer/src/editor/ClaimCheckCard.tsx";
  const { ClaimCard }: { ClaimCard: ComponentType<Record<string, unknown>> } = await import(
    cardPath
  );
  await act(() =>
    root?.render(
      createElement(ClaimCard, {
        rootRef: { current: null },
        claim,
        heading: "Not checked",
        onSourcePickerChange: noop,
        checking: false,
        verified: null,
        cited: [],
        fixes: false,
        notFound: false,
        keep: false,
        corrections: [],
        editor,
        decision: { kind: "none" },
        added: 0,
        onAdd: noop,
        onWiden: noop,
        onReplace: noop,
        partCitations: { claim, onAdd: noop, onWiden: noop, onReplace: noop },
        onCheckAgain: noop,
        onCheckPart: noop,
        onUseWording: noop,
        onOpen: noop,
        onFix: noop,
        onFindSources: noop,
        onSearchWeb: noop,
        onTurnOnWebSearch: noop,
        onRemove: noop,
        onCut: noop,
        onCutSentence: noop,
        onKeep: noop,
        onCorrect: noop,
        use: false,
        onUse: noop,
      }),
    ),
  );
  return { openDocument };
}

describe.each([
  {
    language: "en",
    reason: "The figures in “Annual report”, p. 14, couldn’t be read.",
    open: "Open the page",
  },
  { language: "zh-CN", reason: "无法读取“Annual report”第 14 页中的数字。", open: "打开该页" },
])("a card whose figures couldn't be read ($language)", (example) => {
  test("names the page and opens it", async () => {
    const { openDocument } = await card(example.language);
    const reason = container.querySelector('[data-testid="claim-reason"]');
    expect(reason?.textContent).toBe(example.reason);
    const open = container.querySelector<HTMLButtonElement>('[data-testid="claim-open-unread"]');
    expect(open?.textContent).toBe(example.open);
    await act(() => open?.click());
    expect(openDocument).toHaveBeenCalledTimes(1);
    expect(openDocument.mock.calls[0]?.[0]).toMatchObject({
      documentId: "annual-report",
      pageFrom: 14,
      pageTo: 14,
      citation: { check: "not-checked", contentHash: "v1" },
    });
  });
});
