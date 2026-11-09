/**
 * A contradiction the check couldn't confirm keeps a card that says something (#2184): the line
 * that a Passage may say otherwise, the check's own explanation, then the quote it rested on. With
 * no explanation to show, the line and the quote alone; never a bare Unsupported.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, ClaimCheckAttributes } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const SOURCE: CitationAttributes = {
  passageId: "passage-1",
  documentId: "tenancy",
  documentName: "Allotment Tenancy",
  contentHash: "v1",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "lines", from: 4, to: 4 },
  quote: "The Tenant pays the Council a rent of 85 per year",
  check: "found",
  checkReason: null,
};

const CASES = [
  {
    language: "en",
    sentence: "The Council pays the Tenant a rent of 85 per year.",
    line: "A Passage may say otherwise, but the check couldn’t confirm it.",
    reason: "The tenancy says the Tenant pays the Council, not the other way round.",
  },
  {
    language: "zh-CN",
    sentence: "甲方每年向乙方支付租金人民币八百五十元。",
    line: "有段落的说法可能与此不同，但检查未能确认。",
    reason: "协议写的是乙方向甲方支付租金，付款方向与句子相反。",
  },
] as const;

function checkOf(sentence: string, reason: string | null): ClaimCheckAttributes {
  return {
    id: "check",
    request: "request",
    action: "check-against-documents",
    state: "unsupported",
    text: sentence,
    evidence: null,
    says: null,
    unsupported: {
      reason,
      covered: null,
      uncovered: null,
      found: true,
      unconfirmed: true,
      quoted: SOURCE,
    },
    calculation: null,
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-09T00:00:00.000Z",
  };
}

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

async function card(language: string, sentence: string, reason: string | null) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
  const content: JSONContent[] = [
    { type: "paragraph", content: [{ type: "text", text: sentence }] },
  ];
  editor = new Editor({
    element: globalThis.document.createElement("div"),
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  const check = checkOf(sentence, reason);
  const claim = {
    check,
    from: 0,
    to: sentence.length,
    sentence: { from: 0, to: sentence.length, text: sentence },
    shown: { state: "unsupported" as const },
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
        heading: "Unsupported",
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
  const text = (id: string) =>
    container.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null;
  return {
    line: text("claim-not-confirmed"),
    why: text("claim-why"),
    quote: text("claim-quote"),
    bare: container.querySelector('[data-testid="claim-no-reason"]') !== null,
    order: [...container.querySelectorAll("[data-testid]")]
      .map((each) => each.getAttribute("data-testid"))
      .filter((id) => id === "claim-not-confirmed" || id === "claim-why" || id === "claim-quote"),
  };
}

describe.each(CASES)("a contradiction the check couldn't confirm ($language)", (example) => {
  // protects=an Unsupported card from a contradiction its confirmation didn't uphold says that a Passage may say otherwise, then the check's explanation, then its quote, in the interface language (#2184); fails_when=the card is bare, or the line, the explanation or the quote is missing or out of order; no_claim=what the model says.
  test("says so, then what the check found, then its quote", async () => {
    const shown = await card(example.language, example.sentence, example.reason);
    expect(shown).toEqual({
      line: example.line,
      why: example.reason,
      quote: expect.stringContaining(SOURCE.quote ?? ""),
      bare: false,
      order: ["claim-not-confirmed", "claim-why", "claim-quote"],
    });
  });

  // protects=with no explanation to show, the card keeps the line and the quote, never a bare Unsupported (#2184); fails_when=the card shows no line or no quote; no_claim=how often a check gives no explanation.
  test("with no explanation, the line and the quote alone", async () => {
    const shown = await card(example.language, example.sentence, null);
    expect(shown).toEqual({
      line: example.line,
      why: null,
      quote: expect.stringContaining(SOURCE.quote ?? ""),
      bare: false,
      order: ["claim-not-confirmed", "claim-quote"],
    });
  });
});
