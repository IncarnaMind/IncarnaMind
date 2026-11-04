/**
 * The clause that says which dollar a bare "$" is shows on the sentence's card (#2226): a
 * one-part sentence takes the single card rather than the parts rows, and the line is on its one
 * part, so the single card reads it there.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, ClaimCheckAttributes, ClaimCheckPart } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const SOURCE: CitationAttributes = {
  passageId: "passage-1",
  documentId: "defined-lease",
  documentName: "Defined lease",
  contentHash: "v1",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "lines", from: 3, to: 3 },
  quote: "The rent is $64,000 a year",
  check: "found",
  checkReason: null,
};

const CASES = [
  {
    language: "en",
    sentence: "The rent is A$64,000 a year.",
    clause:
      "The Document states the currency (Defined lease · line 2): “$” means Australian dollars.",
  },
  {
    language: "zh-CN",
    sentence: "The rent is A$64,000 a year.",
    clause: "文档注明了币种（Defined lease · 第 2 行）：“$” means Australian dollars.",
  },
] as const;

function partOf(sentence: string, clause: string): ClaimCheckPart {
  return {
    span: { start: 0, end: sentence.length },
    kind: "fact",
    verdict: "supported",
    evidence: [SOURCE],
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    versions: [],
    excluded: [],
    citedCaseUnchecked: false,
    citedCaseFound: false,
    currencyClause: clause,
  };
}

function checkOf(sentence: string, clause: string): ClaimCheckAttributes {
  return {
    id: "check",
    request: "request",
    action: "check-against-documents",
    state: "supported",
    text: sentence,
    evidence: SOURCE,
    says: null,
    unsupported: null,
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
    checkedAt: "2026-10-31T00:00:00.000Z",
    parts: [partOf(sentence, clause)],
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

async function card(language: string, sentence: string, clause: string) {
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
  const check = checkOf(sentence, clause);
  const claim = {
    check,
    from: 0,
    to: sentence.length,
    sentence: { from: 0, to: sentence.length, text: sentence },
    shown: { state: "supported" as const },
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
        heading: "Supported",
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
  return {
    clause: container.querySelector('[data-testid="claim-currency-clause"]')?.textContent ?? null,
    rows: container.querySelectorAll('[data-testid="claim-part"]').length,
  };
}

describe.each(CASES)("a one-part sentence's card ($language)", (example) => {
  // protects=a one-part Supported sentence shows the Document line that says which dollar it is on its single card, in the interface language (#2226); fails_when=the line is missing because only the parts rows read it; no_claim=where the card sits.
  test("shows the clause on the single card", async () => {
    const shown = await card(example.language, example.sentence, example.clause);
    expect(shown.rows).toBe(0);
    expect(shown.clause).toBe(example.clause);
  });
});
