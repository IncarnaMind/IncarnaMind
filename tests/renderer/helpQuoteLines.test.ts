/**
 * What the call help panel draws under each line of a reply (#2847), as a User sees it: each
 * Citation's quote word for word with its number, a ✓ only beside a quote the app found or a plain
 * moment's words found in the cited place, the Citation card's words where it can't say that, and
 * a room kept from the moment a number shows, in English and Chinese.
 */
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationAnswer, MeetingHelp, MeetingHelpKind } from "../../src/core/api";
import { cellsText, fittedQuote, momentFound } from "../../src/shared/helpQuotes";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const fake = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));

vi.mock("../../src/renderer/src/core", () => ({
  core: { on: () => () => undefined, getConversation: () => new Promise(() => undefined) },
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey, params?: MessageParams) => translate(fake.language, key, params),
  translateNow: (key: MessageKey, params?: MessageParams) => translate(fake.language, key, params),
  useLanguage: () => fake.language,
}));
vi.mock("../../src/renderer/src/answers", async () => {
  const { create } = await import("zustand");
  return { useAnswers: create(() => ({ models: null, loadModels: () => undefined })) };
});
vi.mock("../../src/renderer/src/modelNames", () => ({
  useModelNames: () => () => ({ name: "" }),
  useServiceName: () => "",
}));
vi.mock("../../src/renderer/src/callStarts", () => ({ useCallStarts: () => new Map() }));

type Cited = Record<string, unknown> & { marker: number; quote: string };

/** A line of the price sheet, its quote found there unless `more` says otherwise. */
const sheet = (marker: number, quote: string, more: Record<string, unknown> = {}): Cited => ({
  marker,
  passageId: `pricing-${marker}`,
  documentId: "pricing",
  documentName: fake.language === "en" ? "Pricing 2026" : "2026 价格表",
  quote,
  location: null,
  check: "found",
  checkReason: null,
  ...more,
});

/** Words said in the call at `fromMs`, found in its Transcript unless `more` says otherwise. */
const heard = (
  marker: number,
  quote: string,
  fromMs: number,
  more: Record<string, unknown> = {},
): Cited => ({
  marker,
  passageId: `call-${fromMs}`,
  documentId: "transcript",
  documentName: fake.language === "en" ? "Transcript · Pricing call" : "转写稿 · 价格沟通",
  quote,
  location: { kind: "time", from: fromMs, to: fromMs + 1500, speaker: "Them" },
  check: "found",
  checkReason: null,
  ...more,
});

const answerOf = (
  text: string,
  citations: readonly Cited[],
  status: ConversationAnswer["status"] = "done",
  figures: readonly unknown[] = [],
): ConversationAnswer =>
  ({
    kind: "answer",
    id: "answer-1",
    conversationId: "help-chat",
    questionId: "question-1",
    text,
    citations,
    figures,
    analyses: [],
    model: null,
    status,
    errorKind: null,
    errorMessage: null,
  }) as unknown as ConversationAnswer;

interface SuggestionProps {
  help: Pick<MeetingHelp, "kind" | "heard">;
  answer: ConversationAnswer;
  onRetry(): void;
}

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  for (const [name, value] of Object.entries({
    document,
    window,
    navigator: { platform: "MacIntel" },
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  fake.language = "en";
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function show(kind: MeetingHelpKind, answer: ConversationAnswer) {
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const path = "../../src/renderer/src/components/meetings/HelpSuggestion";
  const { HelpSuggestion }: { HelpSuggestion: ComponentType<SuggestionProps> } = await import(path);
  await act(async () =>
    root?.render(
      createElement(HelpSuggestion, { help: { kind, heard: null }, answer, onRetry() {} }),
    ),
  );
}

const all = (testId: string, scope: ParentNode = container) =>
  Array.from(scope.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));

/** The quote lines and moments under one option, reading or short line, in order. */
const rowsOf = (scope: ParentNode) =>
  Array.from(
    scope.querySelectorAll<HTMLElement>('[data-testid="help-quote"], [data-testid="help-moment"]'),
  );

const read = (row: HTMLElement) => ({
  as: row.getAttribute("data-testid") === "help-moment" ? "moment" : "quote",
  state: row.getAttribute("data-state"),
  words: (row.querySelector(".help-quote-words, .help-quote-said")?.textContent ?? "").trim(),
  numbers: all("help-quote-number", row).map((each) => each.textContent),
  found: all("help-quote-found", row).length > 0,
});

/** What each option, reading or short line draws under it. */
const drawn = () => all("help-option").map((option) => rowsOf(option).map(read));

/** The same elements, the same nodes in the same order: nothing among them was replaced. */
function expectSameNodes(
  actual: readonly (Element | null | undefined)[],
  expected: readonly (Element | null | undefined)[],
) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((node, index) => {
    expect(node === expected[index]).toBe(true);
  });
}

const MOMENT = /^\d{1,2}:\d{2}(?::\d{2})?\s*/;
const unquoted = (words: string) => words.replace(MOMENT, "").replace(/^“|”$/gu, "");

/**
 * Every ✓ shown stands beside words the app found word for word: a Citation's quote it drew, or a
 * plain moment's words found in the cited place, and never inside a line the model wrote.
 */
function expectEveryMarkOnFoundWords(answer: ConversationAnswer) {
  for (const mark of all("help-quote-found")) {
    let row: HTMLElement | null = mark.parentElement;
    while (row && !["help-quote", "help-moment"].includes(row.getAttribute("data-testid") ?? "")) {
      expect([
        "help-option-say",
        "help-option-note",
        "help-option-effect",
        "help-citation",
      ]).not.toContain(row.getAttribute("data-testid"));
      row = row.parentElement;
    }
    expect(row).not.toBeNull();
    const words = unquoted((row?.querySelector(".help-quote-words")?.textContent ?? "").trim());
    const drawnWords = (row?.querySelector(".help-quote-words")?.textContent ?? "")
      .trim()
      .replace(MOMENT, "");
    expect(
      answer.citations.some(
        (citation) =>
          fittedQuote(citation.quote).text === words ||
          momentFound(words, citation) ||
          (citation.cells !== undefined && cellsText(citation.cells) === drawnWords),
      ),
    ).toBe(true);
  }
}

describe("Under each line of call help, the app draws its Citations' quotes (#2847)", () => {
  // protects=an option's line keeps the model's words with plain numbers, and under it each Citation's quote shows word for word in quotation marks with its number and a ✓ the app's find earned, in English and Chinese; fails_when=a ✓ sits in the model's line or beside words no Citation gave, or a quote shows other words than its Citation's; no_claim=whether the model's sentence says what its quote does.
  test.each([
    {
      language: "en" as const,
      reply:
        "★ Yes, Enterprise includes single sign-on, at $45 per seat a month [^1]\n→ answers both questions at once\n\nIt's billed annually, and from 50 seats you get 10% off [^2] [^3]\n→ opens the volume talk",
      quotes: [
        "Enterprise plan: $45 per seat a month, with single sign-on and audit logs.",
        "Enterprise contracts are billed annually.",
        "Volume discount: 10% off from 50 seats.",
      ],
    },
    {
      language: "zh-CN" as const,
      reply:
        "★ 包含，企业版带单点登录，每个席位每月 45 美元 [^1]\n→ 两个问题一次答完\n\n企业版按年付费，50 个席位起可以优惠 10% [^2] [^3]\n→ 引出批量采购",
      quotes: [
        "企业版：每个席位每月 45 美元，含单点登录和审计日志。",
        "企业版合同按年付费。",
        "批量折扣：50 个席位起优惠 10%。",
      ],
    },
  ])("an option with two quotes ($language)", async ({ language, reply, quotes }) => {
    fake.language = language;
    const answer = answerOf(
      reply,
      quotes.map((quote, index) => sheet(index + 1, quote)),
    );
    await show("answer", answer);
    const line = (index: number, number: string) => ({
      as: "quote",
      state: "found",
      words: `“${quotes[index]}”`,
      numbers: [number],
      found: true,
    });
    expect(drawn()).toEqual([[line(0, "1")], [line(1, "2"), line(2, "3")]]);
    expect(all("help-citation").map((chip) => chip.textContent)).toEqual(["1", "2", "3"]);
    expectEveryMarkOnFoundWords(answer);
  });

  // protects=a found quote that is cells of a table is drawn cell by cell, each value whole after its column's name where the table gave one, in English and Chinese; one kept before cells were read draws as quoted (#2847); fails_when=a cell's value or name differs from what the cite found, a cell takes a name it had none of, or a reply without cells draws otherwise than its quote; no_claim=how the cells were read.
  test.each([
    {
      language: "en" as const,
      quote: "Enterprise\t$45 per seat a month\tYes",
      cells: [
        { name: "Plan", value: "Enterprise" },
        { name: "Price", value: "$45 per seat a month" },
        { name: null, value: "Yes" },
      ],
      drawn: "Plan “Enterprise” · Price “$45 per seat a month” · “Yes”",
    },
    {
      language: "zh-CN" as const,
      quote: "企业版\t每个席位每月 45 美元\t是",
      cells: [
        { name: "方案", value: "企业版" },
        { name: "价格", value: "每个席位每月 45 美元" },
        { name: null, value: "是" },
      ],
      drawn: "方案“企业版” · 价格“每个席位每月 45 美元” · “是”",
    },
  ])(
    "a table's row is drawn cell by cell under its column's names ($language)",
    async ({ language, quote, cells, drawn: words }) => {
      fake.language = language;
      const reply = "★ Enterprise is $45 a seat, with sign-on [^1]\n→ answers at once";
      const answer = answerOf(reply, [sheet(1, quote, { cells })]);
      await show("answer", answer);
      expect(drawn()).toEqual([
        [{ as: "quote", state: "found", words, numbers: ["1"], found: true }],
      ]);
      expectEveryMarkOnFoundWords(answer);
      // Kept before cells were read: its quote as given.
      await show("answer", answerOf(reply, [sheet(1, quote)]));
      expect(drawn()[0]?.[0]?.words).toBe(`“${quote}”`);
    },
  );

  test("a third and later Citation keep their numbers at the end of the second line", async () => {
    await show(
      "answer",
      answerOf(
        "★ Team is $25, Enterprise $45, and annual billing [^1] [^2] [^3]\n→ the whole list",
        [
          sheet(1, "Team plan: $25 per seat a month."),
          sheet(2, "Enterprise plan: $45 per seat a month, with single sign-on and audit logs."),
          sheet(3, "Enterprise contracts are billed annually."),
        ],
      ),
    );
    expect(drawn()[0]?.map((row) => row.numbers)).toEqual([["1"], ["2", "3"]]);
  });

  test("a quote wholly inside another found quote of the same place joins its line", async () => {
    const whole = sheet(
      1,
      "Enterprise plan: $45 per seat a month, with single sign-on and audit logs.",
    );
    await show(
      "answer",
      answerOf("★ Enterprise has single sign-on and audit logs [^1] [^2]\n→ answers at once", [
        whole,
        { ...sheet(2, "with single sign-on and audit logs"), passageId: whole.passageId },
      ]),
    );
    expect(drawn()).toEqual([
      [
        {
          as: "quote",
          state: "found",
          words: `“${whole.quote}”`,
          numbers: ["1", "2"],
          found: true,
        },
      ],
    ]);
  });

  // protects=a quote not found, or one that can't be checked, shows the Citation card's own words in its kept line with no ✓, and its number in the model's line says why on hover, in English and Chinese (#2847); fails_when=such a line shows the quote, a ✓, "Quote not found" in words the card doesn't use, or is left empty; no_claim=how the place's name is cut at the panel's width.
  test.each([
    {
      language: "en" as const,
      notFound: "Quote not found in Pricing 2026",
      transcript: "Quote not found in the transcript at 0:02",
      cantCheck: "Can’t check",
      why: "The quote isn’t in the text of the place it cites.",
    },
    {
      language: "zh-CN" as const,
      notFound: "未在“2026 价格表”中找到引文",
      transcript: "未在转写稿 0:02 处找到引文",
      cantCheck: "无法核对",
      why: "所引位置的文字中没有这段引文。",
    },
  ])(
    "a quote not found, or that can't be checked, says so in the card's words ($language)",
    async ({ language, notFound, transcript, cantCheck, why }) => {
      fake.language = language;
      const missing = { check: "not-found", checkReason: "quote-not-on-pages" };
      const answer = answerOf(
        "★ Enterprise is $40 a seat [^1] [^2]\n→ answers at once\n\nAsk about the term [^3]\n→ buys time",
        [
          sheet(1, "Enterprise is $40 a seat.", missing),
          heard(2, "forty a seat", 2000, missing),
          sheet(3, "Enterprise contracts are billed annually.", {
            check: "cant-check",
            checkReason: "document-removed",
          }),
        ],
      );
      await show("answer", answer);
      expect(
        drawn().map((rows) => rows.map(({ state, words, found }) => ({ state, words, found }))),
      ).toEqual([
        [
          { state: "not-found", words: notFound, found: false },
          { state: "not-found", words: transcript, found: false },
        ],
        [{ state: "cant-check", words: cantCheck, found: false }],
      ]);
      const [chip] = all("help-citation");
      expect(chip?.getAttribute("data-check")).toBe("not-found");
      expect(chip?.getAttribute("title")).toContain(why);
    },
  );

  test("a line with no Citation has no quote line, and a number no Citation came for goes at the end", async () => {
    await show(
      "answer",
      answerOf(
        "★ Let me check with the team\n→ buys time\n\nIt's billed annually [^4]\n→ sets the term",
        [],
      ),
    );
    expect(drawn()).toEqual([[], []]);
    expect(all("help-citation")).toHaveLength(0);
    expect(all("help-sources")).toHaveLength(0);
  });

  // protects=from the moment a number shows, its quote line's place is kept; the quote and its ✓ come into that same place when the cite lands, and the line to say above it never changes (#2847); fails_when=the room is a new element when its quote lands, the line to say changes, or a room is left once the reply ends; no_claim=pixel heights, which the stills show.
  test("while written, a number's room is kept, its quote comes into it, and the line to say stays", async () => {
    const reply = "★ Yes, Enterprise includes single sign-on, at $45 per seat a month [^1]";
    await show("answer", answerOf(reply, [], "streaming"));
    const [say] = all("help-option-say");
    const [room] = rowsOf(container);
    expect(room && read(room)).toEqual({
      as: "quote",
      state: "waiting",
      words: "",
      numbers: ["1"],
      found: false,
    });
    expect(room?.querySelector(".help-quote-room")).not.toBeNull();

    const cited = sheet(
      1,
      "Enterprise plan: $45 per seat a month, with single sign-on and audit logs.",
    );
    await show("answer", answerOf(reply, [cited], "streaming"));
    expectSameNodes(rowsOf(container), [room]);
    expectSameNodes(all("help-option-say"), [say]);
    expect(say?.textContent).toBe(
      "Yes, Enterprise includes single sign-on, at $45 per seat a month 1",
    );
    expect(room && read(room)).toMatchObject({
      state: "found",
      words: `“${cited.quote}”`,
      found: true,
    });

    await show("answer", answerOf(`${reply}\n→ answers both at once`, [cited], "done"));
    expectSameNodes(rowsOf(container), [room]);
    expectSameNodes(all("help-option-say"), [say]);
    // Its "→" line makes it an option to say, in the panel's quotation marks, as before.
    expect(say?.textContent?.replace(/[“”]/gu, "")).toBe(
      "Yes, Enterprise includes single sign-on, at $45 per seat a month1",
    );
  });

  describe("a number that joins another's line once its quote lands", () => {
    const WHOLE = "Enterprise plan: $45 per seat a month, with single sign-on and audit logs.";
    const whole = sheet(1, WHOLE);
    const inner = { ...sheet(2, "with single sign-on and audit logs"), passageId: whole.passageId };
    const billed = sheet(3, "Enterprise contracts are billed annually.");
    const FIRST = "★ Enterprise has single sign-on and audit logs [^1] [^2]";
    const SECOND = "\n→ answers at once\n\nIt's billed annually [^3]\n→ sets the term";

    /** What is on screen, in order: the heading, then each option's line and its quote lines. */
    const screen = () => [
      all("help-heading"),
      ...all("help-option").map((option) => [
        option.querySelector<HTMLElement>('[data-testid="help-option-say"]'),
        ...rowsOf(option),
      ]),
    ];

    // protects=the one place a line goes while a reply is written: a number's spare room closes when its quote lands inside another found quote of the same place and no third quote takes the room, by one line an option, below that option's line, never once the reply has ended (#2847); fails_when=the option's line or its first quote line is replaced, more than one line goes, a line goes after the end, or a line above moves; no_claim=pixels, which the stills show.
    test("its spare room closes: one line, below the option's own line, only while written", async () => {
      await show("answer", answerOf(`${FIRST}${SECOND}`, [whole, billed], "streaming"));
      const before = screen();
      expect(drawn().map((rows) => rows.map((row) => row.state))).toEqual([
        ["found", "waiting"],
        ["found"],
      ]);

      await show("answer", answerOf(`${FIRST}${SECOND}`, [whole, inner, billed], "streaming"));
      const joined = screen();
      // Above the option and the option's own line and first quote line: the same, in place.
      expectSameNodes(joined[0] ?? [], before[0] ?? []);
      expectSameNodes(joined[1] ?? [], before[1]?.slice(0, 2) ?? []);
      // One line went, the option's last, so only what is below it moves, and upward.
      expect(before[1]).toHaveLength(3);
      expect(joined[1]).toHaveLength(2);
      expectSameNodes(joined[2] ?? [], before[2] ?? []);
      expect(drawn()[0]?.map((row) => row.numbers)).toEqual([["1", "2"]]);

      await show("answer", answerOf(`${FIRST}${SECOND}`, [whole, inner, billed], "done"));
      screen().forEach((nodes, index) => {
        expectSameNodes(nodes, joined[index] ?? []);
      });
    });

    test("a third quote with other words takes the room, so no line goes", async () => {
      const reply = `${FIRST.replace("[^2]", "[^2] [^3]")}\n→ answers at once`;
      const other = { ...billed, marker: 3 };
      await show("answer", answerOf(reply, [whole], "streaming"));
      const before = screen()[1] ?? [];
      expect(drawn()[0]?.map((row) => [row.state, row.numbers])).toEqual([
        ["found", ["1"]],
        ["waiting", ["2", "3"]],
      ]);
      await show("answer", answerOf(reply, [whole, inner, other], "streaming"));
      const after = screen()[1] ?? [];
      expect(after).toHaveLength(before.length);
      expectSameNodes(after.slice(0, 2), before.slice(0, 2));
      expect(drawn()[0]?.map((row) => [row.state, row.numbers])).toEqual([
        ["found", ["1", "2"]],
        ["found", ["3"]],
      ]);
    });

    test("a quote that lands before its number shows never opens a room", async () => {
      const shown: (string | null)[][] = [];
      for (const text of [FIRST.replace(" [^2]", ""), FIRST, `${FIRST}${SECOND}`]) {
        await show("answer", answerOf(text, [whole, inner, billed], "streaming"));
        shown.push(
          rowsOf(all("help-option")[0] ?? container).map((row) => row.getAttribute("data-state")),
        );
      }
      expect(shown).toEqual([["found"], ["found"], ["found"]]);
    });
  });

  test("Stop closes a room whose quote never came; nothing else closes one", async () => {
    const reply = "★ Yes, Enterprise includes single sign-on [^1]";
    await show("answer", answerOf(reply, [], "streaming"));
    expect(drawn()[0]?.map((row) => row.state)).toEqual(["waiting"]);
    await show("answer", answerOf(reply, [], "stopped"));
    expect(drawn()[0]).toEqual([]);
  });

  test.each([
    [
      "en" as const,
      "★ Revenue was about [=1] last year [^1]\n→ answers at once",
      "about 1.2 billion",
      "about about",
    ],
    ["zh-CN" as const, "★ 去年营收约 [=1] [^1]\n→ 直接回答", "约 12 亿元", "约约"],
  ])(
    "a figure's own words are read in before the line, so a word before it isn't doubled (%s)",
    async (language, reply, figure, doubled) => {
      fake.language = language;
      await show(
        "answer",
        answerOf(reply, [sheet(1, "Revenue: 1.2 billion.")], "done", [
          {
            marker: 1,
            value: 1.2e9,
            shown: figure,
            show: { language, as: null, decimals: null, scale: null },
          },
        ]),
      );
      const said = all("help-option-say")[0]?.textContent ?? "";
      expect(said).toContain(figure);
      expect(said).not.toContain(doubled);
    },
  );

  test.each([
    ["en" as const, "Quote found in Pricing 2026"],
    ["zh-CN" as const, "已在“2026 价格表”中找到引文"],
  ])("a ✓ says what it means to the keyboard and a screen reader (%s)", async (language, words) => {
    fake.language = language;
    await show(
      "answer",
      answerOf("★ Enterprise is $45 a seat [^1]\n→ answers at once", [
        sheet(1, "Enterprise plan: $45 per seat a month, with single sign-on and audit logs."),
      ]),
    );
    const [mark] = all("help-quote-found");
    expect(mark?.getAttribute("role")).toBe("img");
    expect(mark?.getAttribute("aria-label")).toBe(words);
    expect(mark?.getAttribute("tabindex")).toBe("0");
  });

  // protects=a reply stored before quote lines shows each Citation's quote from what is stored, with ✓ for a quote found (whatever the sentence check said of its sentence), and none for one not found (#2847); fails_when=an older reply's found quote shows no ✓, or its sentence's verdict shows as ! or ≠; no_claim=Check again, which the core tests cover.
  test("an older reply's Citations draw from what is stored", async () => {
    const answer = answerOf(
      "★ Enterprise is $45 a seat [^1] [^2]\n→ answers at once\n\nIt's billed annually [^3] [^4]\n→ sets the term",
      [
        sheet(1, "Enterprise plan: $45 per seat a month.", {
          check: "unsupported",
          judgedAt: "2026-11-01T10:00:00.000Z",
        }),
        sheet(2, "Team plan: $25 per seat a month.", {
          check: "not-checked",
          checkReason: "answer-limit",
        }),
        sheet(3, "Enterprise contracts are billed annually.", { check: "checking" }),
        sheet(4, "Billed monthly.", { check: "not-found", checkReason: "quote-not-on-pages" }),
      ],
    );
    await show("answer", answer);
    expect(drawn().map((rows) => rows.map(({ state, found }) => [state, found]))).toEqual([
      [
        ["found", true],
        ["found", true],
      ],
      [
        ["found", true],
        ["not-found", false],
      ],
    ]);
    expect(container.textContent).not.toMatch(/[!≠]/u);
    expectEveryMarkOnFoundWords(answer);
  });
});

describe("A reading's moment of the call (#2847)", () => {
  const BUDGET = {
    en: {
      reading: "★ They want to stay near $35 a seat",
      move: "→ show the Team plan's price first",
      said: "Honestly, our budget is about thirty-five a seat, maybe less.",
      words: "our budget is about thirty-five a seat",
      wrong: "our budget is thirty-five a seat, tops",
    },
    "zh-CN": {
      reading: "★ 对方希望每个席位控制在 35 美元左右",
      move: "→ 先报团队版的价格",
      said: "说实话，我们的预算大概每个席位三十五美元，可能更少。",
      words: "我们的预算大概每个席位三十五美元",
      wrong: "我们的预算最多每个席位三十五美元",
    },
  };

  const reading = (language: "en" | "zh-CN", moment: string) =>
    `${BUDGET[language].reading}\n${moment}\n${BUDGET[language].move}`;

  // protects=a plain moment keeps the model's words, its time becomes the cited place's own once its Citation lands, and its ✓ joins in its kept room only where the app found those words there, a run inside a longer quote included, in English and Chinese (#2847); fails_when=the words change when the ✓ joins, a ✓ shows beside words not found, or the model's time stays beside a ✓; no_claim=how the model picks its moment.
  test.each(["en", "zh-CN"] as const)(
    "a plain moment found keeps its words and takes ✓ (%s)",
    async (language) => {
      fake.language = language;
      const { said, words } = BUDGET[language];
      const text = reading(language, `0:02 “${words}” [^1]`);
      await show("want", answerOf(text, [heard(1, said, 3000)], "streaming"));
      const [moment] = rowsOf(container);
      expect(moment && read(moment)).toEqual({
        as: "moment",
        state: "written",
        words: `0:03 “${words}”`,
        numbers: ["1"],
        found: false,
      });
      expect(moment?.querySelector(".help-quote-found--room")).not.toBeNull();

      const answer = answerOf(text, [heard(1, said, 3000, { quotedWordsFound: [words] })], "done");
      await show("want", answer);
      expectSameNodes(rowsOf(container), [moment]);
      expect(moment && read(moment)).toEqual({
        as: "moment",
        state: "found",
        words: `0:03 “${words}”`,
        numbers: ["1"],
        found: true,
      });
      expectEveryMarkOnFoundWords(answer);
    },
  );

  // protects=a plain moment whose quoted words the cited place doesn't hold shows the Citation's own quote and time instead, with its ✓ and no amber, while written and once stored, in English and Chinese (#2847); fails_when=the model's misquote stays on screen, or the line shows as not found; no_claim=why the model misquoted.
  test.each(["en", "zh-CN"] as const)(
    "a plain moment's words not in the cited place give way to its Citation's quote (%s)",
    async (language) => {
      fake.language = language;
      const { said, wrong } = BUDGET[language];
      const text = reading(language, `0:02 “${wrong}” [^1]`);
      const misquoted = heard(1, said, 3000, {
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
      });
      for (const status of ["streaming", "done"] as const) {
        const answer = answerOf(text, [misquoted], status);
        await show("want", answer);
        expect(drawn()).toEqual([
          [{ as: "moment", state: "found", words: `0:03 “${said}”`, numbers: ["1"], found: true }],
        ]);
        expect(container.textContent).not.toContain(wrong);
        expectEveryMarkOnFoundWords(answer);
      }
    },
  );

  const SECURITY = {
    en: {
      reading: "★ They need sign-on and audit logs for compliance",
      first: "We need single sign-on.",
      second: "And audit logs for compliance.",
      move: "→ lead with Enterprise's security",
    },
    "zh-CN": {
      reading: "★ 对方要单点登录和审计日志来满足合规",
      first: "我们需要单点登录。",
      second: "合规上还要审计日志。",
      move: "→ 先讲企业版的安全功能",
    },
  };

  test.each(["en", "zh-CN"] as const)(
    "one quotation with two numbers is drawn by the app, each quote at its own time (%s)",
    async (language) => {
      fake.language = language;
      const { reading: lead, first, second, move } = SECURITY[language];
      const answer = answerOf(
        `${lead}\n0:04 “${first.slice(0, -1)}[^1]${first.slice(-1)} ${second}” [^2]\n${move}`,
        [heard(1, first, 4000), heard(2, second, 6000)],
      );
      await show("want", answer);
      expect(drawn()).toEqual([
        [
          { as: "moment", state: "found", words: `0:04 “${first}”`, numbers: ["1"], found: true },
          { as: "moment", state: "found", words: `0:06 “${second}”`, numbers: ["2"], found: true },
        ],
      ]);
      expectEveryMarkOnFoundWords(answer);
    },
  );

  const PRICE = {
    en: {
      reading: "★ They push back on price",
      high: "That's too high for us.",
      lower: "Can you do thirty?",
      beside: "Dana, their CFO: “That's too high for us” [^1]",
      general: "They said the price was too high, twice [^1] [^2]",
      two: "0:02 “That's too high for us” [^1] / 0:09 “Can you do thirty?” [^2]",
      move: "→ hold the price and offer the annual term",
    },
    "zh-CN": {
      reading: "★ 对方在压价",
      high: "这个价格对我们来说太高了。",
      lower: "能不能三十？",
      beside: "对方财务 Dana：“这个价格对我们来说太高了” [^1]",
      general: "对方两次说价格太高 [^1] [^2]",
      two: "0:02 “这个价格对我们来说太高了” [^1]；0:09 “能不能三十？” [^2]",
      move: "→ 守住价格，提出按年付费",
    },
  };

  // protects=a moment line that isn't plain or one quotation keeps the model's words as written, with each Citation's quote drawn under it by the general rule: words beside the quotation, two Citations, and two moments on one line (the one kind that can show words twice), in English and Chinese (#2847); fails_when=such a line is replaced, loses its words, or a ✓ shows in it; no_claim=how often a model writes these.
  test.each([
    { language: "en", kind: "beside", shape: "words beside its quotation" },
    { language: "zh-CN", kind: "beside", shape: "words beside its quotation" },
    { language: "en", kind: "general", shape: "two Citations" },
    { language: "zh-CN", kind: "general", shape: "two Citations" },
    { language: "en", kind: "two", shape: "two moments" },
    { language: "zh-CN", kind: "two", shape: "two moments" },
  ] as const)(
    "a line with $shape takes the general rule ($language)",
    async ({ language, kind }) => {
      fake.language = language;
      const words = PRICE[language];
      const answer = answerOf(`${words.reading}\n${words[kind]}\n${words.move}`, [
        heard(1, words.high, 2000),
        heard(2, words.lower, 9000),
      ]);
      await show("want", answer);
      const [note] = all("help-option-note");
      expect(note?.textContent).toBe(words[kind].replace(/\[\^(\d)\]/gu, "$1"));
      const quotes = kind === "beside" ? [words.high] : [words.high, words.lower];
      expect(drawn()).toEqual([
        quotes.map((quote, index) => ({
          as: "quote",
          state: "found",
          words: `“${quote}”`,
          numbers: [String(index + 1)],
          found: true,
        })),
      ]);
      expect(all("help-quote-found", note)).toHaveLength(0);
      expectEveryMarkOnFoundWords(answer);
    },
  );

  // protects=while a moment line is still written its place is a room, so no words shown there are later replaced; once the line ends it shows as its kind, the ✓ joining without the words changing (#2847); fails_when=the model's half-written moment shows and is then replaced by other words, or the words change when the ✓ joins; no_claim=timing.
  test("while a moment line is still written, its place is a room until the line ends", async () => {
    const { said, words } = BUDGET.en;
    const steps = [
      `${BUDGET.en.reading}\n0:0`,
      `${BUDGET.en.reading}\n0:02 “${words}`,
      `${BUDGET.en.reading}\n0:02 “${words}” [^1]`,
    ];
    for (const text of steps) {
      await show("want", answerOf(text, [heard(1, said, 3000)], "streaming"));
      expect(drawn()).toEqual([
        [{ as: "moment", state: "waiting", words: "", numbers: [], found: false }],
      ]);
      expect(container.textContent).not.toContain(words);
    }
    await show("want", answerOf(`${steps[2]}\n`, [heard(1, said, 3000)], "streaming"));
    const [moment] = rowsOf(container);
    expect(moment && read(moment)).toMatchObject({
      state: "written",
      words: `0:03 “${words}”`,
      found: false,
    });
    await show(
      "want",
      answerOf(
        `${steps[2]}\n${BUDGET.en.move}`,
        [heard(1, said, 3000, { quotedWordsFound: [words] })],
        "done",
      ),
    );
    expectSameNodes(rowsOf(container), [moment]);
    expect(moment && read(moment)).toMatchObject({
      state: "found",
      words: `0:03 “${words}”`,
      found: true,
    });
  });
});
