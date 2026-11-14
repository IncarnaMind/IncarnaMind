/**
 * A sentence whose cited Document is outside its Note's Search scope says which, and its card's
 * one action searches all Documents: checked again in the same scope, it would be left out again
 * (#3083). A sentence kept inside a wall is still offered Check again, as before.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaimCheckAttributes, ClaimCheckFailure } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const SENTENCE = "Underlying EBITDA was £96 million, against £118 million a year earlier.";
const REPORT = "Northwind Retail · Q3 2026 results";

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
  reason: "outside-scope",
  detail: REPORT,
  providerId: null,
  modelId: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-11-14T00:00:00.000Z",
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

async function card(language: string, reason: ClaimCheckFailure, detail: string) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
  const check: ClaimCheckAttributes = { ...CHECK, reason, detail };
  const content: JSONContent[] = [
    { type: "paragraph", content: [{ type: "text", text: SENTENCE }] },
  ];
  editor = new Editor({
    element: globalThis.document.createElement("div"),
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  const claim = {
    check,
    reads: check,
    from: 0,
    to: SENTENCE.length,
    sentence: { from: 0, to: SENTENCE.length, text: SENTENCE },
    shown: { state: "not-checked" as const, reason },
  };
  const noop = () => undefined;
  const onCheckAgain = vi.fn();
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
        onCheckAgain,
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
  return { onCheckAgain };
}

const shownIn = () => ({
  reason: container.querySelector('[data-testid="claim-reason"]')?.textContent ?? null,
  searchAll: container.querySelector<HTMLButtonElement>('[data-testid="claim-search-all"]'),
  checkAgain: container.querySelector<HTMLButtonElement>('[data-testid="claim-check-again"]'),
});

describe.each([
  {
    language: "en",
    reason: "“Northwind Retail · Q3 2026 results” is outside this note’s Search scope.",
    searchAll: "Search all Documents",
    checkAgain: "Check again",
    kept: "Kept inside Client A",
  },
  {
    language: "zh-CN",
    reason: "“Northwind Retail · Q3 2026 results”不在这篇笔记的搜索范围内。",
    searchAll: "搜索全部文档",
    checkAgain: "重新核对",
    kept: "仅在“Client A”内使用",
  },
])("a card whose cited Document is outside the Search scope ($language)", (example) => {
  // protects=the reason names the cited Document the Search scope left out, and the card's action searches all Documents (#3083); fails_when=the card offers only Check again, which gives the same answer in the same scope, or names no Document; no_claim=what the check finds once widened.
  test("names the Document and offers Search all Documents, not Check again", async () => {
    const { onCheckAgain } = await card(example.language, "outside-scope", REPORT);
    const shown = shownIn();
    expect(shown.reason).toBe(example.reason);
    expect(shown.searchAll?.textContent).toBe(example.searchAll);
    expect(shown.checkAgain).toBeNull();
    await act(() => shown.searchAll?.click());
    expect(onCheckAgain).toHaveBeenCalledWith(true);
  });

  // protects=a sentence kept inside another wall keeps its own reason and its Check again, beside the scope's rule (#1934, #3083); fails_when=a wall's card offers to search all Documents, which can't reach behind the wall; no_claim=the wall's check itself.
  test("a wall's card keeps Kept inside and Check again", async () => {
    await card(example.language, "kept-inside", "Client A");
    const shown = shownIn();
    expect(shown.reason).toBe(example.kept);
    expect(shown.searchAll).toBeNull();
    expect(shown.checkAgain?.textContent).toBe(example.checkAgain);
  });
});
