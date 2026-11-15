/**
 * A check card's rows where a quote is missing or doesn't back its part, or the check is to be read
 * again (#2869): a ✓ card opens every part it holds back with its count, whichever part has the
 * quote; a part whose quote doesn't back it says the Documents say something different, never that
 * nothing was found; and a card to be checked again folds its supported parts as supported before
 * the change, with no ✓.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { CitationAttributes, ClaimCheckAttributes, ClaimCheckPart } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { checkWithParts } from "../../src/shared/claimParts";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { writeOpinionSentences } from "../../src/shared/opinions";

// The opinion card sits in a native popover in the top layer, placed by layout: this document has
// neither, so the card is drawn in a plain dialog with its name.
vi.mock("../../src/renderer/src/editor/Popover", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  const { createElement: element } = await import("react");
  return {
    ...original,
    Popover: ({
      children,
      "aria-label": label,
      "data-testid": testId,
    }: {
      children: ReactNode;
      "aria-label"?: string;
      "data-testid"?: string;
    }) => element("div", { role: "dialog", "aria-label": label, "data-testid": testId }, children),
  };
});

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

async function card(
  language: Language,
  check: ClaimCheckAttributes,
  shown: Record<string, unknown> = { state: check.state },
) {
  const editor = await noteWith(language);
  const claim = {
    check,
    reads: check,
    from: 0,
    to: SENTENCE.length,
    sentence: { from: 0, to: SENTENCE.length, text: SENTENCE },
    shown,
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
  test("says the Documents differ above its quote, and not found where it has none", async () => {
    const unsupported = { reason: null, covered: null, uncovered: null };
    await card(
      language,
      checkOf([
        part(FIRST, {
          verdict: "unsupported",
          unsupported: { ...unsupported, found: true },
          evidence: [passage("Spring tides come once a month, at the new moon.")],
        }),
        part(SECOND, { verdict: "unsupported", unsupported }),
      ]),
    );
    const parts = [...container.querySelectorAll('[data-testid="claim-part"]')];
    expect(parts).toHaveLength(2);
    expect(
      parts.map((row) => row.querySelector('[data-testid="claim-part-reason"]')?.textContent),
    ).toEqual([
      t("claim.unsupported.differs"),
      t("claim.unsupported.notFound", { scope: t("composer.scope.all") }),
    ]);
    expect(parts[0]?.querySelector('[data-testid="claim-part-citation"]')?.textContent).toBe(
      "Spring tides come once a month, at the new moon.",
    );
    expect(parts[1]?.querySelector('[data-testid="claim-part-citation"]')).toBeNull();
  });

  // protects=an unsupported part whose check judged a Passage about it with nothing kept to quote, and gave no reason, says so rather than that nothing was found (#2869); fails_when=such a part says it wasn't found in the scope; no_claim=the wording of a part with a reason.
  test("says the check gave no reason where it found a Passage but kept no quote", async () => {
    const unsupported = { reason: null, covered: null, uncovered: null };
    await card(
      language,
      checkOf([
        part(FIRST, { verdict: "unsupported", unsupported: { ...unsupported, found: true } }),
        part(SECOND, { verdict: "unsupported", unsupported }),
      ]),
    );
    const parts = [...container.querySelectorAll('[data-testid="claim-part"]')];
    expect(
      parts.map((row) => row.querySelector('[data-testid="claim-part-reason"]')?.textContent),
    ).toEqual([
      t("claim.unsupported.noReason"),
      t("claim.unsupported.notFound", { scope: t("composer.scope.all") }),
    ]);
  });

  // protects=a one-part card whose check judged a Passage about it with nothing kept to quote, and gave no reason, says the check gave no reason, as such a part does, and one that found nothing says so (#2869); fails_when=such a card has no reason line or says it wasn't found; no_claim=the wording of a card with a reason.
  test.each([
    { found: true, says: "claim-why" },
    { found: false, says: "claim-nothing" },
  ])("a one-part card with nothing to quote (found: $found)", async ({ found, says }) => {
    const unsupported = {
      reason: null,
      covered: null,
      uncovered: null,
      ...(found ? { found: true as const } : {}),
    };
    await card(language, { ...checkOf([]), state: "unsupported", unsupported });
    expect(container.querySelectorAll('[data-testid="claim-part"]')).toHaveLength(0);
    const line = container.querySelector(`[data-testid="${says}"]`);
    expect(line?.textContent).toBe(
      found
        ? t("claim.unsupported.noReason")
        : t("claim.unsupported.notFound", { scope: t("composer.scope.all") }),
    );
    expect(line?.className).toBe("claim-card-says");
  });
});

describe.each([
  {
    language: "en" as const,
    edited: "1 other part was supported before your edit · Show",
    changed: "1 other part was supported when last checked · Show",
    now: "1 other part is supported · Show",
  },
  {
    language: "zh-CN" as const,
    edited: "修改前另外 1 处有依据 · 查看",
    changed: "上次核对时另外 1 处有依据 · 查看",
    now: "另外 1 处有依据 · 查看",
  },
])("a card to be checked again ($language)", (example) => {
  const unsupported = {
    reason: "Nothing says how often neaps fall.",
    covered: null,
    uncovered: null,
  };
  const check = () =>
    checkOf([
      part(FIRST, { evidence: [passage(FIRST)] }),
      part(SECOND, { verdict: "unsupported", unsupported }),
    ]);
  const folded = () => container.querySelector('[data-testid="claim-parts-folded"]');
  // protects=a card whose check is to be read again folds its supported parts as supported before the change, with no ✓, after an edit or another change (#2869); fails_when=the fold line shows a ✓ or says the parts are supported now; no_claim=the rows' own tone once opened.
  test.each([
    { why: "edited", line: example.edited },
    { why: "new-version", line: example.changed },
  ])("says what was supported before it changed ($why)", async ({ why, line }) => {
    await card(example.language, check(), { state: "needs-recheck", why });
    expect(folded()?.textContent).toBe(line);
    expect(folded()?.querySelector(".claim-fold-icon")).toBeNull();
  });

  // protects=the same card checked and supported now folds with its ✓ and says the parts are supported (#2869); fails_when=the line of a settled card loses its ✓; no_claim=its colour.
  test("a settled card still says its parts are supported, with its ✓", async () => {
    await card(example.language, check());
    expect(folded()?.textContent).toBe(example.now);
    expect(folded()?.querySelector(".claim-fold-icon")).not.toBeNull();
  });
});

describe.each(["en", "zh-CN"] as const)("an opinion card's parts (%s)", (language) => {
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  // protects=an opinion card, which has no list of its parts for a screen reader of its own, lets one hear each part's words and reason, and tells its Check anyway buttons apart by their part (#2869); fails_when=a part's reason is hidden from a screen reader, or two Check anyway buttons say nothing of which part each is for; no_claim=what the check card reads, which lists its parts apart.
  test("each part's words and reason are read, and each Check anyway says which part it checks", async () => {
    const { useAppStore } = await import("../../src/renderer/src/store");
    useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
    const { useChecks } = await import("../../src/renderer/src/checks");
    useChecks.setState({ openClaim: { mind: "opinion" } });
    const opinion = (words: string) => part(words, { kind: "opinion", verdict: null });
    const doc = new Y.Doc();
    writeOpinionSentences(doc, [
      {
        id: "opinion",
        blockId: "p",
        text: SENTENCE,
        occurrence: 0,
        parts: [opinion(FIRST), opinion(SECOND)],
      },
    ]);
    editor = new Editor({
      element: globalThis.document.createElement("div"),
      extensions: noteExtensions(),
      content: {
        type: "doc",
        content: [
          { type: "paragraph", attrs: { id: "p" }, content: [{ type: "text", text: SENTENCE }] },
        ],
      },
    });
    const cardPath = "../../src/renderer/src/editor/OpinionCard.tsx";
    const { OpinionCard }: { OpinionCard: ComponentType<Record<string, unknown>> } = await import(
      cardPath
    );
    await act(() => root?.render(createElement(OpinionCard, { editor, mindId: "mind", doc })));
    const page = globalThis.document;
    const dialog = page.querySelector('[role="dialog"]');
    const anyway = [...(dialog?.querySelectorAll("button") ?? [])].filter(
      (button) => button.textContent === t("claim.checkAnyway"),
    );
    expect(anyway).toHaveLength(2);
    const describedBy = (button: Element) =>
      (button.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => page.getElementById(id));
    const description = (button: Element) =>
      describedBy(button)
        .map((element) => element?.textContent ?? "")
        .join(" ");
    expect(anyway.map(description)).toEqual(
      [FIRST, SECOND].map(
        (words) => `${t("claim.sentence", { sentence: words })} ${t("claim.opinion")}`,
      ),
    );
    for (const element of anyway.flatMap(describedBy)) {
      expect(element).not.toBeNull();
      expect(element?.closest('[aria-hidden="true"]')).toBeNull();
    }
  });
});
