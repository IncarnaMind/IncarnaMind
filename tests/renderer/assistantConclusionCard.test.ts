/**
 * The card of a sentence the assistant wrote whose cited fact is supported and whose conclusion was
 * left out as an opinion (#3019): Not checked, with its own line, the fact's row Supported and the
 * conclusion's row left out with Check anyway. Checked again it would only be left out again, so
 * the card offers no Check again.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaimCheckAttributes, ClaimCheckPart } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { checkWithParts, partsWrittenBy } from "../../src/shared/claimParts";

const FACT = "Spring tides come twice a month";
const OPINION = "so the harbour should plan for them";
const SENTENCE = `${FACT}, ${OPINION}.`;
const QUOTE = "Spring tides come twice a month, at new and full moon.";

const part = (start: number, end: number, more: Partial<ClaimCheckPart>): ClaimCheckPart => ({
  span: { start, end },
  kind: "fact",
  verdict: null,
  evidence: [],
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
  ...more,
});

const CHECK: ClaimCheckAttributes = checkWithParts(
  {
    id: "check",
    request: "request",
    action: "check-against-documents",
    state: "checking",
    text: SENTENCE,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [{ documentId: "tides", contentHash: "v1" }],
    excluded: [],
    checkedAt: "2026-11-13T09:00:00.000Z",
  },
  partsWrittenBy(
    [
      part(0, FACT.length, {
        verdict: "supported",
        evidence: [
          {
            passageId: "passage-1",
            documentId: "tides",
            documentName: "Tides",
            contentHash: "v1",
            pageFrom: 2,
            pageTo: 2,
            location: null,
            quote: QUOTE,
            check: "found",
            checkReason: null,
          },
        ],
        decidingEvidence: 0,
      }),
      part(SENTENCE.indexOf(OPINION), SENTENCE.indexOf(OPINION) + OPINION.length, {
        kind: "opinion",
      }),
    ],
    true,
  ),
);

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
  useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
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
    shown: { state: "not-checked" as const, reason: "assistant-conclusion" as const },
  };
  const noop = () => undefined;
  const checkAgain = vi.fn();
  const checkPart = vi.fn();
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
        onCheckAgain: checkAgain,
        onCheckPart: checkPart,
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
  return { checkAgain, checkPart };
}

describe.each([
  {
    language: "en",
    reason:
      "The cited fact is supported. The rest is the assistant’s own conclusion and wasn’t checked.",
    opinion: "Left out as an opinion",
    anyway: "Check anyway",
  },
  {
    language: "zh-CN",
    reason: "引用的事实有依据。其余是助手自己的结论，未核对。",
    opinion: "视为观点，未纳入核对",
    anyway: "仍然核对",
  },
])("the card of the assistant's own conclusion ($language)", (example) => {
  // protects=the card says in its own line, in English and Chinese, that the cited fact is supported and the rest is the assistant's own conclusion, unchecked; it lists the fact's row and the conclusion's row left out with Check anyway, which checks that part; and it offers no Check again; fails_when=the card reads as a failed check with Check again, or loses the conclusion's Check anyway; no_claim=the card's colours.
  test("says why, keeps Check anyway, and offers no Check again", async () => {
    const { checkAgain, checkPart } = await card(example.language);
    expect(container.querySelector('[data-testid="claim-reason"]')?.textContent).toBe(
      example.reason,
    );
    const rows = [...container.querySelectorAll('[data-testid="claim-part"]')];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain(example.opinion);
    const anyway = container.querySelector<HTMLButtonElement>(
      '[data-testid="claim-part-check-anyway"]',
    );
    expect(anyway?.textContent).toBe(example.anyway);
    await act(() => anyway?.click());
    expect(checkPart).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="claim-check-again"]')).toBeNull();
    expect(checkAgain).not.toHaveBeenCalled();
  });
});
