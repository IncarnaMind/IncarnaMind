/**
 * The card of a Mark that rests on its Passage (#3118): the decision model confirmed the Passage
 * and isn't sure its stored line settles the sentence alone, so the card shows no quote. It names
 * the Document and the place, which opens; nothing writes the line into a Citation; and a Citation
 * the sentence already has on that place is still named.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, ClaimCheckAttributes, ClaimCheckPart } from "../../src/core/api";

const FIRST = "Spring tides come twice a month";
const SECOND = "neaps fall between them";
const LINE = "Spring tides occur twice each lunar month, near the new and the full moon.";
const OTHER = "Neap tides fall between the spring tides.";

const passage = (quote: string): CitationAttributes => ({
  id: `receipt-${quote.length}`,
  passageId: `passage-${quote.length}`,
  documentId: "tides",
  documentName: "Tides",
  contentHash: "v1",
  pageFrom: 2,
  pageTo: 2,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

const part = (sentence: string, words: string, more: Partial<ClaimCheckPart>): ClaimCheckPart => {
  const start = sentence.indexOf(words);
  return {
    span: { start, end: start + words.length },
    kind: "fact",
    verdict: "supported",
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
  };
};

const checkOf = (sentence: string, parts: ClaimCheckPart[]): ClaimCheckAttributes => ({
  id: "check",
  request: "request",
  action: "check-against-documents",
  state: "supported",
  text: sentence,
  evidence: parts[0]?.evidence[0] ?? null,
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  providerId: "openrouter",
  modelId: "decider",
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-11-15T00:00:00.000Z",
  parts,
});

const OPEN = { en: "Open the page", "zh-CN": "打开该页" } as const;
const ADD = { en: "Add as Citation", "zh-CN": "添加为引用" } as const;

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
  vi.resetModules();
});

const openCited = vi.fn(() => Promise.resolve());
vi.mock("../../src/renderer/src/openCited", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  openCited,
}));

async function card(
  language: "en" | "zh-CN",
  sentence: string,
  parts: ClaimCheckPart[],
  decision: Record<string, unknown>,
) {
  openCited.mockClear();
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
  const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
  const content: JSONContent[] = [
    { type: "paragraph", content: [{ type: "text", text: sentence }] },
  ];
  editor = new Editor({
    element: globalThis.document.createElement("div"),
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  const check = checkOf(sentence, parts);
  const claim = {
    check,
    reads: check,
    from: 1,
    to: 1 + sentence.length,
    sentence: { from: 1, to: 1 + sentence.length, text: sentence },
    shown: { state: "supported" as const },
  };
  const noop = () => undefined;
  const onOpen = vi.fn();
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
        decision,
        added: 0,
        onAdd: noop,
        onWiden: noop,
        onReplace: noop,
        partCitations: { claim, onAdd: noop, onWiden: noop, onReplace: noop },
        onCheckAgain: noop,
        onCheckPart: noop,
        onUseWording: noop,
        onOpen,
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
  const one = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
  const all = (testId: string) => [...container.querySelectorAll(`[data-testid="${testId}"]`)];
  return { one, all, onOpen, text: container.textContent ?? "" };
}

describe.each(["en", "zh-CN"] as const)("the card of a Mark on its Passage (%s)", (language) => {
  const sentence = `${FIRST}.`;

  // protects=the control: a Mark whose line the model is sure of alone still shows it as a quote that can be cited; fails_when=the rule below hides every decision-model quote.
  test("shows its line as a quote, with Add as Citation, when the line settles it alone", async () => {
    const shown = await card(
      language,
      sentence,
      [part(sentence, FIRST, { evidence: [passage(LINE)] })],
      { kind: "add" },
    );
    expect(shown.one("claim-quote")?.textContent).toContain(LINE);
    expect(shown.one("claim-add-citation")?.textContent).toBe(ADD[language]);
    expect(shown.one("claim-open-place")).toBeNull();
  });

  // protects=a line the decision model isn't sure of alone is never shown as the quote behind a ✓ (blind readers rejected such lines): the card names the Document and the place and opens it (#3118); fails_when=the stored line shows anywhere on the card, the place line or its Open goes, or the flag is read from an empty quote.
  test("shows no quote when it rests on its Passage: the place is named and opens", async () => {
    const shown = await card(
      language,
      sentence,
      [part(sentence, FIRST, { evidence: [passage(LINE)], restsOnPassage: true })],
      { kind: "none" },
    );
    expect(shown.one("claim-quote")).toBeNull();
    expect(shown.one("claim-open-quote")).toBeNull();
    expect(shown.text).not.toContain(LINE);
    expect(shown.one("claim-source")?.textContent).toContain("Tides");
    expect(shown.one("claim-add-citation")).toBeNull();
    const open = shown.one("claim-open-place");
    expect(open?.textContent).toBe(OPEN[language]);
    await act(() => open?.dispatchEvent(new Event("click", { bubbles: true })));
    expect(openCited).toHaveBeenCalledTimes(1);
    expect(openCited.mock.calls[0]).toMatchObject([
      { documentId: "tides", pageFrom: 2, quote: LINE },
      { withQuote: true },
    ]);
    expect(shown.onOpen).toHaveBeenCalledTimes(1);
  });

  // protects=what the sentence already cites is still named on a Mark that rests on its Passage, without that Citation's quote standing in as the Mark's (#3118); fails_when=the chip goes, or the Citation's own quote shows under the ✓.
  test("still names the Citation the sentence has there, without a quote", async () => {
    const cited = passage("twice each lunar month");
    const shown = await card(
      language,
      sentence,
      [part(sentence, FIRST, { evidence: [passage(LINE)], restsOnPassage: true })],
      {
        kind: "already",
        citation: { pos: 1, number: 3, key: "block:0", attributes: cited, footnote: true },
      },
    );
    expect(shown.one("claim-already-chip")?.textContent).toBe("3");
    expect(shown.one("claim-quote")).toBeNull();
    expect(shown.text).not.toContain("twice each lunar month");
    expect(shown.one("claim-open-place")?.textContent).toBe(OPEN[language]);
  });

  // protects=a part's row follows the same rule as the one-part card, part by part (#3118); fails_when=a resting part's line shows in its row or can be added, or a sure part beside it loses its quote.
  test("a part's row hides the line of the part that rests on its Passage only", async () => {
    const both = `${FIRST}, and ${SECOND}.`;
    const shown = await card(
      language,
      both,
      [
        part(both, FIRST, { evidence: [passage(LINE)], restsOnPassage: true }),
        part(both, SECOND, { evidence: [passage(OTHER)] }),
      ],
      { kind: "none" },
    );
    // A ✓ card shows its first part's place and holds the rest behind a count.
    expect(shown.all("claim-part-receipt")).toHaveLength(1);
    await act(() =>
      shown.one("claim-part-more")?.dispatchEvent(new Event("click", { bubbles: true })),
    );
    const rows = shown.all("claim-part-receipt");
    expect(rows).toHaveLength(2);
    const [resting, sure] = rows;
    expect(resting?.querySelector('[data-testid="claim-part-citation"]')).toBeNull();
    expect(resting?.textContent).not.toContain(LINE);
    expect(resting?.textContent).toContain("Tides");
    expect(resting?.querySelector('[data-testid="claim-part-add-citation"]')).toBeNull();
    expect(resting?.querySelector('[data-testid="claim-part-open-place"]')?.textContent).toBe(
      OPEN[language],
    );
    expect(sure?.querySelector('[data-testid="claim-part-citation"]')?.textContent).toContain(
      OTHER,
    );
    expect(sure?.querySelector('[data-testid="claim-part-open-place"]')).toBeNull();
    expect(sure?.querySelector('[data-testid="claim-part-add-citation"]')?.textContent).toBe(
      ADD[language],
    );
  });
});
