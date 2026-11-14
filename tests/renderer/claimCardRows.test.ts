/**
 * A check card's rows where a quote is missing or doesn't back its part (#2869): a ✓ card opens
 * every part it holds back with its count, whichever part has the quote; a part whose quote doesn't
 * back it says the Documents say something different, never that nothing was found; and a member of
 * a quantified part still to be cited stays open, its Citation still to add.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, ClaimCheckAttributes, ClaimCheckPart } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { checkWithParts } from "../../src/shared/claimParts";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const FIRST = "Spring tides come twice a month";
const SECOND = "neaps fall between them";
const SENTENCE = `${FIRST}, and ${SECOND}.`;

const passage = (quote: string): CitationAttributes => ({
  passageId: `passage-${quote}`,
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

const part = (words: string, more: Partial<ClaimCheckPart>): ClaimCheckPart => {
  const start = SENTENCE.indexOf(words);
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

const checkOf = (parts: ClaimCheckPart[]): ClaimCheckAttributes =>
  checkWithParts(
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
      checkedAt: "2026-11-14T09:00:00.000Z",
    },
    parts,
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

async function noteWith(language: Language) {
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
  return editor;
}

async function card(language: Language, check: ClaimCheckAttributes) {
  const editor = await noteWith(language);
  const claim = {
    check,
    reads: check,
    from: 0,
    to: SENTENCE.length,
    sentence: { from: 0, to: SENTENCE.length, text: SENTENCE },
    shown: { state: check.state },
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
}

const rows = () => container.querySelectorAll('[data-testid="claim-part"]').length;
const more = () => container.querySelector<HTMLButtonElement>('[data-testid="claim-part-more"]');

describe.each([
  { language: "en" as const, one: "1 more", hide: "Hide" },
  { language: "zh-CN" as const, one: "另外 1 处", hide: "收起" },
])("a ✓ card's count ($language)", (example) => {
  // An absence that holds has no quote: the Documents read whole back it.
  const readWhole = {
    readDocuments: [
      { documentId: "tides", documentName: "Tides", contentHash: "v1", locations: [] },
    ],
  };
  // protects=a ✓ card of two supported parts, one backed by Documents read whole and so without a quote, opens the other part with its count, whether the quote is the first part's or the second's (#2869); fails_when=the part without a quote, or the one after it, can't be opened; no_claim=the count's place on the line.
  test.each([
    {
      quoted: "first",
      parts: [part(FIRST, { evidence: [passage(FIRST)] }), part(SECOND, readWhole)],
    },
    {
      quoted: "second",
      parts: [part(FIRST, readWhole), part(SECOND, { evidence: [passage(SECOND)] })],
    },
  ])("opens the part held back when the $quoted part has the quote", async ({ parts }) => {
    await card(example.language, checkOf(parts));
    expect(rows()).toBe(1);
    expect(more()?.textContent).toBe(example.one);
    await act(() => more()?.click());
    expect(rows()).toBe(2);
    expect(more()?.textContent).toBe(example.hide);
  });
});

describe.each(["en", "zh-CN"] as const)("a part's reason (%s)", (language) => {
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  // protects=an unsupported part whose quote is a Passage that doesn't back it says the Documents say something different, as a one-part card does, and one with no quote says it wasn't found (#2869); fails_when=a part says nothing was found above the Passage it quotes; no_claim=the wording of other verdicts.
  test("says the Documents differ beside a quote, and not found without one", async () => {
    const editor = await noteWith(language);
    const rowsPath = "../../src/renderer/src/editor/ClaimPartRows.tsx";
    const {
      cardParts,
      partReason,
    }: {
      cardParts(input: Record<string, unknown>): unknown[];
      partReason(
        translate: typeof t,
        language: Language,
        row: unknown,
        options: { stale: boolean; lookedIn: string },
      ): string | null;
    } = await import(rowsPath);
    const unsupported = { reason: null, covered: null, uncovered: null };
    const [quoted, bare] = cardParts({
      state: editor.state,
      text: SENTENCE,
      sentence: SENTENCE,
      parts: [
        part(FIRST, {
          verdict: "unsupported",
          unsupported: { ...unsupported, found: true },
          evidence: [passage(FIRST)],
        }),
        part(SECOND, { verdict: "unsupported", unsupported }),
      ],
      stale: false,
      checking: false,
    });
    const options = { stale: false, lookedIn: "Tides" };
    expect(partReason(t, language, quoted, options)).toBe(t("claim.unsupported.differs"));
    expect(partReason(t, language, bare, options)).toBe(
      t("claim.unsupported.notFound", { scope: "Tides" }),
    );
  });
});

describe("a quantified part still to be cited", () => {
  // protects=the members of a quantified part Supported, not yet cited stay open, where its Citation is added, and fold as supported once it is cited (#2869); fails_when=a member of a part still to be cited folds behind Show; no_claim=the members' wording.
  test("keeps its members open", async () => {
    const editor = await noteWith("en");
    const rowsPath = "../../src/renderer/src/editor/ClaimPartRows.tsx";
    const { cardParts }: { cardParts(input: Record<string, unknown>): { fold: string | null }[] } =
      await import(rowsPath);
    const quantified = part(FIRST, {
      verdict: "not-checked",
      reason: "found-elsewhere",
      coverage: {
        quantifier: "all",
        complete: true,
        unit: "months",
        domainEvidence: [passage("Spring tides: every month of the year.")],
        members: ["May", "June"].map((label) => ({
          label,
          verdict: "supported" as const,
          evidence: [passage(`${label}: spring tides twice.`)],
        })),
      },
    });
    const rowsOf = (waiting: ReadonlySet<ClaimCheckPart>) =>
      cardParts({
        state: editor.state,
        text: SENTENCE,
        sentence: SENTENCE,
        parts: [quantified],
        stale: false,
        checking: false,
        waiting,
      }).map((row) => row.fold);
    expect(rowsOf(new Set([quantified]))).toEqual([null, null]);
    expect(rowsOf(new Set())).toEqual(["supported", "supported"]);
  });
});
