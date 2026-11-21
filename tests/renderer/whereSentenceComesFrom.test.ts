/**
 * A check card says where its sentence comes from (#3322): the writer's own view is named as one,
 * with what the Documents hold on it and every quote of it, and no fault to fix; a verdict the
 * check worked out from what the Documents state says so, and shows its one line of working before
 * every quote it used. A verdict the User's own AI reported on several quotes shows every one of
 * them (#3587).
 */
import { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CitationAttributes, ClaimCheckAttributes, ClaimCheckPart } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { claimWash } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { checkWithParts } from "../../src/shared/claimParts";
import { type MessageKey, translate } from "../../src/shared/i18n";

// What the card's quote opens: the Document at the quote the verdict rests on (#3587).
const opened = vi.hoisted(() => [] as { quote: string | null }[]);
vi.mock("../../src/renderer/src/openCited", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/renderer/src/openCited")>()),
  openCited: async (citation: { quote: string | null }) => {
    opened.push({ quote: citation.quote });
  },
}));

const passage = (quote: string): CitationAttributes => ({
  passageId: `passage-${quote}`,
  documentId: "review",
  documentName: "Service centre review",
  contentHash: "v1",
  pageFrom: 2,
  pageTo: 2,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

const EXAMPLES = {
  en: {
    view: "We should add two agents by May.",
    viewReason:
      "The review forecasts more tickets and two retirements, but says nothing of hiring.",
    viewQuotes: [
      "Ticket volume is forecast to grow 15% in 2027.",
      "Two agents retire in 2027.",
      "The lead says the team can’t keep its reply times if volume grows.",
    ],
    worked: "So next year’s tickets will pass ten thousand.",
    working: "9,200 × 1.15 = 10,580 > 10,000",
    workedQuotes: [
      "The centre handled 9,200 tickets in 2026.",
      "Ticket volume is forecast to grow 15% in 2027.",
    ],
    wrong: "Next year’s tickets will stay under ten thousand.",
    wrongSays: "Worked out from the review, next year’s tickets come to 10,580.",
    season: "Busy season runs from July to the October holiday.",
    seasonSays: "The review gives July in one place and August in another.",
    seasonQuotes: [
      "Half the week is spent at the counter, half on site visits.",
      "The busy season starts in August and runs to the October holiday.",
      "From July the queue grows, right up to the October holiday.",
    ],
  },
  "zh-CN": {
    view: "我的建议是增加 2 名客服，5 月到岗。",
    viewReason: "文档预计工单量增长，且有两名客服退休，但没有说要增加几人、何时到岗。",
    viewQuotes: [
      "预计 2027 年工单量增长 15%。",
      "有两名客服将在 2027 年退休。",
      "客服负责人表示，如果工单量继续增长，团队无法保持现在的回复时间。",
    ],
    worked: "所以明年的工单量会超过一万张。",
    working: "9,200 × (1 + 15%) = 10,580 > 10,000",
    workedQuotes: ["客服中心 2026 年共处理工单 9,200 张。", "预计 2027 年工单量增长 15%。"],
    wrong: "明年的工单量不会超过一万张。",
    wrongSays: "按文档推算，明年的工单量约为 10,580 张。",
    season: "旺季从七月持续到国庆假期。",
    seasonSays: "文档一处说七月，另一处说八月。",
    seasonQuotes: [
      "平时一半时间在柜台，一半时间上门走访。",
      "旺季一般从八月开始，一直到国庆假期。",
      "七月起排队的人就多了，一直到国庆。",
    ],
  },
} as const;

const wholePart = (sentence: string, more: Partial<ClaimCheckPart>): ClaimCheckPart => ({
  span: { start: 0, end: sentence.length },
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
});

const checkOf = (sentence: string, part: ClaimCheckPart): ClaimCheckAttributes =>
  checkWithParts(
    {
      id: "check",
      request: "request",
      action: "check-against-documents",
      state: "checking",
      text: sentence,
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
      versions: [{ documentId: "review", contentHash: "v1" }],
      excluded: [],
      checkedAt: "2026-11-18T09:00:00.000Z",
    },
    [part],
  );

const ownView = (sentence: string, reason: string | null, quotes: readonly string[]) => {
  const [first, ...rest] = quotes;
  return checkOf(
    sentence,
    wholePart(sentence, {
      verdict: "unsupported",
      evidence: rest.map(passage),
      unsupported: {
        word: "own-view",
        reason,
        covered: null,
        uncovered: null,
        ...(first !== undefined && { found: true as const, quoted: passage(first) }),
      },
    }),
  );
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

/** The card as the margin's mark opens it, headed as the mark names its state. */
async function card(
  language: Language,
  sentence: string,
  check: ClaimCheckAttributes,
  shown: { state: string },
  decision: unknown = { kind: "none" },
) {
  const { useAppStore } = await import("../../src/renderer/src/store");
  useAppStore.setState({ settings: { language, user: { personId: "person" } } } as never);
  editor = new Editor({
    element: globalThis.document.createElement("div"),
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: sentence }] }],
    },
  });
  const claim = {
    check,
    reads: check,
    from: 0,
    to: sentence.length,
    sentence: { from: 0, to: sentence.length, text: sentence },
    shown,
  };
  const { checkStateKey } = await import("../../src/renderer/src/unsupportedFixes");
  const heading = translate(language, checkStateKey(editor, claim as never));
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
        heading,
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

const texts = (testId: string) =>
  [...container.querySelectorAll(`[data-testid="${testId}"]`)].map(
    (each) => each.textContent?.trim() ?? "",
  );
const order = (testIds: readonly string[]) =>
  [...container.querySelectorAll("[data-testid]")]
    .map((each) => each.getAttribute("data-testid") ?? "")
    .filter((testId) => testIds.includes(testId))
    .filter((testId, at, all) => all.indexOf(testId) === at);
const buttons = () =>
  [...container.querySelectorAll(".citation-card-actions button")].map((each) =>
    each.getAttribute("data-testid"),
  );

describe.each(["en", "zh-CN"] as const)("the writer's own view (%s)", (language) => {
  const example = EXAMPLES[language];
  const t = (key: MessageKey) => translate(language, key);

  // protects=a sentence the check found to be its writer's own view has a card of its own: headed so in the quiet ink, with the check's sentence on what the Documents hold and every quote of it, and only Check again, never a fault's fix (#3322); fails_when=the card says Needs a look, warns, folds a quote behind a count, or offers Cut, Find sources, Keep as my view or Search all Documents; no_claim=the words the model writes.
  test("is named, says what the Documents hold on it, shows every quote, and offers no fix", async () => {
    await card(
      language,
      example.view,
      ownView(example.view, example.viewReason, example.viewQuotes),
      {
        state: "own-view",
      },
    );
    expect(texts("claim-badge")).toEqual([t("claim.state.own-view")]);
    expect(container.querySelector('[data-testid="claim-badge"]')?.getAttribute("data-check")).toBe(
      "own-view",
    );
    expect(container.firstElementChild?.className).toContain("citation-card--own-view");
    expect(container.textContent).not.toContain(t("figures.filter.look"));
    expect(texts("claim-part-reason")).toEqual([example.viewReason]);
    expect(texts("claim-part-citation")).toEqual(example.viewQuotes);
    expect(container.querySelector('[data-testid="claim-part-more"]')).toBeNull();
    expect(buttons()).toEqual(["claim-check-again"]);
  });

  // protects=an own view the Documents hold nothing on says so in one line, with no quote (#3322); fails_when=the card is empty under the sentence, or says Not found; no_claim=none beyond protects.
  test("the Documents hold nothing on: one line says so", async () => {
    await card(language, example.view, ownView(example.view, null, []), { state: "own-view" });
    expect(texts("claim-part-reason")).toEqual([t("claim.ownView.nothing")]);
    expect(texts("claim-part-citation")).toEqual([]);
    expect(container.textContent).not.toContain(t("claim.state.notFound"));
  });
});

describe.each(["en", "zh-CN"] as const)("a verdict worked out (%s)", (language) => {
  const example = EXAMPLES[language];
  const t = (key: MessageKey) => translate(language, key);

  // protects=a Supported verdict the check worked out from what Passages state is headed as worked out, and shows its one line of working before every quote it used, none behind a count (#3322); fails_when=the heading is plain Supported, the working is missing or after the quotes, or a quote is folded behind "1 more"; no_claim=how the working is worded.
  test("is headed so, and shows its working before every quote it used", async () => {
    const check = checkOf(
      example.worked,
      wholePart(example.worked, {
        evidence: example.workedQuotes.map(passage),
        workedOut: example.working,
      }),
    );
    await card(language, example.worked, check, { state: "supported" });
    expect(texts("claim-badge")).toEqual([t("claim.state.workedOut")]);
    expect(texts("claim-worked-out")).toEqual([example.working]);
    expect(texts("claim-part-citation")).toEqual(example.workedQuotes);
    expect(container.querySelector('[data-testid="claim-part-more"]')).toBeNull();
    expect(order(["claim-worked-out", "claim-part-citation"])).toEqual([
      "claim-worked-out",
      "claim-part-citation",
    ]);
  });

  // protects=a Contradicted verdict worked out keeps its heading and shows its working between what the Documents say and the quote (#3322); fails_when=the heading changes, or the working comes before the explanation or after the quote; no_claim=the correction it offers.
  test("a contradiction keeps its heading, the working between its explanation and quote", async () => {
    const [quote] = example.workedQuotes;
    const check = checkOf(
      example.wrong,
      wholePart(example.wrong, {
        verdict: "contradicted",
        evidence: [passage(quote)],
        says: example.wrongSays,
        workedOut: example.working,
      }),
    );
    await card(language, example.wrong, check, { state: "contradicted" });
    expect(texts("claim-badge")).toEqual([t("claim.state.contradicted")]);
    expect(texts("claim-worked-out")).toEqual([example.working]);
    expect(order(["claim-says", "claim-worked-out", "claim-quote"])).toEqual([
      "claim-says",
      "claim-worked-out",
      "claim-quote",
    ]);
  });
});

describe.each(["en", "zh-CN"] as const)("a verdict the User's own AI reported (%s)", (language) => {
  const example = EXAMPLES[language];
  const t = (key: MessageKey) => translate(language, key);
  const reported = (verdict: "contradicted" | "supported", quotes: readonly string[]) =>
    checkOf(
      example.season,
      wholePart(example.season, {
        verdict,
        evidence: quotes.map(passage),
        says: example.seasonSays,
        restsOnEveryQuote: true,
      }),
    );

  // protects=a mark the User's own AI reported on three quotes shows all three on its card, in the order the AI gave them, each opening its Document, so where two places disagree both are there; never only the first, which in the walk was about something else (#3587); fails_when=the card shows one quote, folds the others behind a count, or reorders them; no_claim=which quote decides
  test("Contradicted on three quotes: every one shows, in the order given", async () => {
    await card(language, example.season, reported("contradicted", example.seasonQuotes), {
      state: "contradicted",
    });
    expect(texts("claim-badge")).toEqual([t("claim.state.contradicted")]);
    expect(texts("claim-part-reason")).toEqual([example.seasonSays]);
    expect(texts("claim-part-citation")).toEqual(example.seasonQuotes);
    expect(container.querySelector('[data-testid="claim-part-more"]')).toBeNull();
  });

  // protects=an overstated verdict the AI rested on one quote shows its explanation and that quote, which its card used to leave out; fails_when=the card shows the explanation alone, or says Not found; no_claim=none beyond protects.
  test("Overstated on one quote: its explanation and its quote show", async () => {
    const [, quote] = example.seasonQuotes;
    const check = checkOf(
      example.season,
      wholePart(example.season, {
        verdict: "unsupported",
        evidence: [passage(quote)],
        unsupported: {
          word: "overstated",
          reason: example.seasonSays,
          covered: null,
          uncovered: null,
          found: true,
          quoted: passage(quote),
        },
        restsOnEveryQuote: true,
      }),
    );
    await card(language, example.season, check, { state: "unsupported" });
    expect(texts("claim-part-reason")).toEqual([example.seasonSays]);
    expect(texts("claim-part-citation")).toEqual([quote]);
    expect(container.textContent).not.toContain(t("claim.state.notFound"));
  });

  // protects=a Supported verdict the AI rested on two quotes shows both, though a ✓ card shows one quote of the Note's own check; fails_when=the second is behind "1 more"; no_claim=none beyond protects.
  test("Supported on two quotes: both show", async () => {
    const two = example.seasonQuotes.slice(1);
    await card(language, example.season, reported("supported", two), { state: "supported" });
    expect(texts("claim-part-citation")).toEqual(two);
    expect(container.querySelector('[data-testid="claim-part-more"]')).toBeNull();
  });
});

describe.each(["en", "zh-CN"] as const)("a sentence whose own Citation is at the verdict's place (%s)", (language) => {
  const example = EXAMPLES[language];
  const [, verdictQuote] = example.seasonQuotes;
  // The Note's writer cited a shorter span at the same place, as the walks found.
  const noteQuote = verdictQuote.slice(2);

  // protects=a card shows the quote its verdict rests on, and that quote is what it opens; the sentence's own Citation at the same place is its number beside it, never its words in place of the verdict's (#3587); fails_when=the card shows the Note's Citation's words while opening the verdict's, or drops the Citation's number
  test("shows the verdict's quote, opens it, and names the sentence's Citation beside it", async () => {
    opened.length = 0;
    const check = checkOf(
      example.season,
      wholePart(example.season, { evidence: [passage(verdictQuote)], says: example.seasonSays }),
    );
    const already = {
      kind: "already",
      citation: { pos: 1, number: 1, key: "block-1:0", attributes: passage(noteQuote) },
    };
    await card(language, example.season, check, { state: "supported" }, already);
    expect(texts("claim-quote")).toEqual([verdictQuote]);
    expect(texts("claim-already-chip")).toEqual(["1"]);
    await act(async () =>
      (container.querySelector('[data-testid="claim-open-quote"]') as HTMLElement).click(),
    );
    expect(opened).toEqual([{ quote: verdictQuote }]);
  });
});

// protects=with every result shown, a Supported verdict the check worked out carries a quiet dotted line, and by default nothing, as a Supported sentence shows nothing (#3358); a sentence the Documents state and a writer's own view carry nothing, and a contradiction keeps its wash however it was reached (#3322); fails if a worked-out sentence looks the same as a stated one with every result shown, carries a line by default, or a view looks like a kind of working
test("the Note's line says which Supported sentences were worked out, with every result shown", () => {
  const { worked, working, workedQuotes, wrong } = EXAMPLES.en;
  const stated = checkOf(worked, wholePart(worked, { evidence: workedQuotes.map(passage) }));
  const reached = checkOf(
    worked,
    wholePart(worked, { evidence: workedQuotes.map(passage), workedOut: working }),
  );
  const refuted = checkOf(
    wrong,
    wholePart(wrong, {
      verdict: "contradicted",
      evidence: workedQuotes.map(passage),
      workedOut: working,
    }),
  );
  expect(claimWash({ state: "supported" }, stated, true)).toBeNull();
  expect(claimWash({ state: "supported" }, reached, true)).toBe("worked-out");
  expect(claimWash({ state: "supported" }, reached)).toBeNull();
  expect(claimWash({ state: "contradicted" }, refuted)).toBe("contradicted");
  expect(claimWash({ state: "own-view" }, stated, true)).toBeNull();
  expect(claimWash({ state: "needs-recheck", why: "edited" }, reached, true)).toBeNull();
});
