/**
 * A decision model's reading on a sentence's card (#3118).
 *
 * A Mark that rests on its Passage: the model confirmed the Passage and isn't sure its stored line
 * settles the sentence alone, so the card shows no quote. It names the Document and the place,
 * which opens; nothing writes the line into a Citation; and a Citation the sentence already has on
 * that place is still named.
 *
 * A first reading: what the model leans to while the AI model still checks the sentence, or after
 * that check ended with no verdict. It is named as a reading and by its model, never as a verdict.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  CitationAttributes,
  ClaimCheckAttributes,
  ClaimCheckFailure,
  ClaimCheckPart,
} from "../../src/core/api";
import { modelName } from "../../src/shared/modelName";

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

/** How the sentence's check stands: a verdict, still running, or ended with no verdict and why. */
type Standing =
  | { state: "supported" | "checking" }
  | { state: "not-checked"; reason: ClaimCheckFailure; detail: string | null };

const checkOf = (
  sentence: string,
  parts: ClaimCheckPart[],
  standing: Standing,
): ClaimCheckAttributes => ({
  id: "check",
  request: "request",
  action: "check-against-documents",
  state: standing.state,
  text: sentence,
  evidence: parts[0]?.evidence[0] ?? null,
  says: null,
  unsupported: null,
  calculation: null,
  reason: standing.state === "not-checked" ? standing.reason : null,
  detail: standing.state === "not-checked" ? standing.detail : null,
  providerId: "anthropic",
  modelId: "claude-haiku-5-5",
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
  standing: Standing = { state: "supported" },
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
  const check = checkOf(sentence, parts, standing);
  const claim = {
    check,
    reads: check,
    from: 1,
    to: 1 + sentence.length,
    sentence: { from: 1, to: 1 + sentence.length, text: sentence },
    shown: standing,
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
  const { checkStateKey } = await import("../../src/renderer/src/unsupportedFixes");
  const { translate } = await import("../../src/shared/i18n");
  const heading = translate(language, checkStateKey(editor, claim as never));
  return { one, all, onOpen, heading, text: container.textContent ?? "" };
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

const READING = {
  providerId: "openrouter",
  modelId: "perplexity/pplx-decider-v1.2",
} as const;
const AI_MODEL = modelName("claude-haiku-5-5", { kind: "anthropic" });
const WORDS = {
  en: {
    supported: "Likely supported",
    contradicted: "Likely contradicted",
    checking: `A first reading by Decider v1.2. ${AI_MODEL} is checking it.`,
    unconfirmed:
      "A first reading by Decider v1.2, not confirmed. The model didn’t reply within 60 seconds.",
    timedOut: "The model didn’t reply within 60 seconds.",
    checkingPlain: "Checking…",
    notChecked: "Not checked",
  },
  "zh-CN": {
    supported: "可能有依据",
    contradicted: "可能与文档矛盾",
    checking: `由 Decider v1.2 初步判断，${AI_MODEL} 正在核对。`,
    unconfirmed: "由 Decider v1.2 初步判断，未确认：模型在 60 秒内没有回复。",
    timedOut: "模型在 60 秒内没有回复。",
    checkingPlain: "正在核对…",
    notChecked: "未核对",
  },
} as const;

describe.each(["en", "zh-CN"] as const)("the card of a first reading (%s)", (language) => {
  const sentence = `${FIRST}.`;
  const words = WORDS[language];
  const read = (verdict: "supported" | "contradicted", standing: "checking" | "not-checked") =>
    part(sentence, FIRST, {
      verdict: standing,
      ...(standing === "not-checked" && { reason: "timed-out", detail: "60" }),
      firstReading: { verdict, ...READING },
    });
  const dashed = (badge: Element | null) => badge?.querySelector("circle[stroke-dasharray]");

  // protects=a first reading is never shown as the verdict it leans to: its own words, its dashed ring and the two models named, with nothing from a Passage and nothing that acts on a verdict (#3118); fails_when=the card reads Supported or Contradicted, shows a quote, an Add, a correction or a sign-off, or names the decision model by its id.
  test.each(["supported", "contradicted"] as const)(
    "while the AI model checks, says what the reading leans to (%s) and who is checking",
    async (verdict) => {
      const shown = await card(
        language,
        sentence,
        [read(verdict, "checking")],
        { kind: "none" },
        {
          state: "checking",
        },
      );
      expect(shown.heading).toBe(words[verdict]);
      const badge = shown.one("claim-badge");
      expect(badge?.getAttribute("data-leaning")).toBe(verdict);
      expect(dashed(badge)).not.toBeNull();
      expect(shown.one("claim-reason")?.textContent).toBe(words.checking);
      expect(shown.text).not.toContain(READING.modelId);
      for (const absent of [
        "claim-quote",
        "claim-source",
        "claim-add-citation",
        "claim-open-place",
        "claim-correct",
        "claim-check-again",
      ])
        expect(shown.one(absent), absent).toBeNull();
      expect(container.querySelector(".claim-sign")).toBeNull();
    },
  );

  // protects=a first reading nothing confirmed stays on the card with why the check ended, and keeps Check again; it is never a verdict (#3118); fails_when=the unconfirmed card drops the reason or Check again, or reads as Not checked with no reading.
  test("left unconfirmed, says so with why the check ended, and offers Check again", async () => {
    const shown = await card(
      language,
      sentence,
      [read("supported", "not-checked")],
      { kind: "none" },
      {
        state: "not-checked",
        reason: "timed-out",
        detail: "60",
      },
    );
    expect(shown.heading).toBe(words.supported);
    const badge = shown.one("claim-badge");
    expect(badge?.getAttribute("data-check")).toBe("not-checked");
    expect(dashed(badge)).not.toBeNull();
    expect(shown.one("claim-reason")?.textContent).toBe(words.unconfirmed);
    expect(shown.one("claim-check-again")).not.toBeNull();
    expect(shown.one("claim-quote")).toBeNull();
    expect(container.querySelector(".claim-sign")).toBeNull();
  });

  // protects=the controls: a sentence no decision model read shows as before, and a verdict keeps its first reading only as a record; fails_when=the dashed ring or the reading's words show without a first reading, or over a verdict.
  test("shows nothing of a reading where there is none, or where a verdict stands", async () => {
    const plain = part(sentence, FIRST, { verdict: "checking" });
    const ended = part(sentence, FIRST, {
      verdict: "not-checked",
      reason: "timed-out",
      detail: "60",
    });
    const checking = await card(
      language,
      sentence,
      [plain],
      { kind: "none" },
      {
        state: "checking",
      },
    );
    expect(checking.heading).toBe(words.checkingPlain);
    expect(checking.one("claim-reason")).toBeNull();
    expect(dashed(checking.one("claim-badge"))).toBeNull();
    await act(() => root?.render(null));

    const failed = await card(
      language,
      sentence,
      [ended],
      { kind: "none" },
      {
        state: "not-checked",
        reason: "timed-out",
        detail: "60",
      },
    );
    expect(failed.heading).toBe(words.notChecked);
    expect(failed.one("claim-reason")?.textContent).toBe(words.timedOut);
    expect(dashed(failed.one("claim-badge"))).toBeNull();
    await act(() => root?.render(null));

    const judged = await card(
      language,
      sentence,
      [
        part(sentence, FIRST, {
          evidence: [passage(LINE)],
          firstReading: { verdict: "contradicted", ...READING },
        }),
      ],
      { kind: "add" },
    );
    expect(judged.one("claim-badge")?.getAttribute("data-leaning")).toBeNull();
    expect(dashed(judged.one("claim-badge"))).toBeNull();
    expect(judged.one("claim-quote")?.textContent).toContain(LINE);
  });
});
