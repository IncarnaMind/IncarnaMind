/**
 * Fitting an Answer's requests into a local model's window (see
 * src/core/answers/window.ts): the Question context is cut by the same rules
 * as when it is built (src/core/answers/context.ts), and search results keep
 * whole Passages.
 */
import { describe, expect, test } from "vitest";
import { estimateTokens, fitQuestionContext } from "../../src/core/answers/context";
import { type AnswerMessage, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import {
  createWindowBudget,
  ESTIMATE_FACTOR,
  NO_ROOM_FOR_PASSAGES,
} from "../../src/core/answers/window";
import { scriptedModel } from "../helpers/models";

/** About `tokens` tokens of text, labelled. */
const block = (label: string, tokens: number) => `${label}: ${"word ".repeat(tokens * 0.8)}`;

const passage = (id: string, tokens: number) =>
  `<passage id="${id}" document="Tides">\n${"tide ".repeat(tokens * 0.8)}\n</passage>`;

describe("Cutting the Question context to a window", () => {
  const question = "What do my Notes say?";
  const messages: AnswerMessage[] = [
    { role: "user", content: block("Oldest", 500) },
    { role: "assistant", content: block("Answer", 500) },
    { role: "user", content: `${block("Newest", 500)}\n\n${question}` },
  ];

  test("keeps the Question and the newest content, leaving the oldest out first", () => {
    const fitted = fitQuestionContext(messages, question, 1_200);
    expect(fitted?.at(-1)?.content.endsWith(question)).toBe(true);
    const text = fitted?.map((message) => message.content).join("\n") ?? "";
    expect(text).toContain("Newest:");
    expect(text).toContain("Answer:");
    expect(text).not.toContain("Oldest:");
    // Within the budget, give or take the rounding of each part.
    expect(estimateTokens(text)).toBeLessThanOrEqual(1_200 + 4);
  });

  test("the newest part that doesn't fit whole keeps its end, marked as cut", () => {
    const fitted = fitQuestionContext(messages, question, 300) ?? [];
    expect(fitted).toHaveLength(1);
    const [only] = fitted;
    // The Newest Note lost its start; the Answer before it, and the oldest Note, are gone.
    expect(only?.content.startsWith("…")).toBe(true);
    expect(only?.content.endsWith(question)).toBe(true);
    expect(only?.content).not.toContain("Newest:");
  });

  test("a Document's whole text given with the Question goes whole or not at all, never cut (#1036)", () => {
    const whole = `<document-text>\nThe whole text of "Tides", as Passages.\n\n${passage("P1", 400)}\n</document-text>`;
    const asked: AnswerMessage[] = [{ role: "user", content: `${whole}\n\n${question}` }];
    expect(fitQuestionContext(asked, question, 600)).toEqual(asked);
    expect(fitQuestionContext(asked, question, 300)).toEqual([{ role: "user", content: question }]);
  });

  test("a conversation still starts with the User", () => {
    const fitted = fitQuestionContext(messages, question, 1_050) ?? [];
    expect(fitted[0]?.role).toBe("user");
  });

  test("with room for nothing but the Question, the Question alone; with less, none", () => {
    expect(fitQuestionContext(messages, question, estimateTokens(question))).toEqual([
      { role: "user", content: question },
    ]);
    expect(fitQuestionContext(messages, question, 2)).toBeNull();
  });
});

describe("A window's budget", () => {
  const window = { tokens: 8_192, outputTokens: 2_048 };

  test("fits a request, keeping room for a search and for the output", () => {
    const budget = createWindowBudget(window);
    const messages: AnswerMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: block(`Block ${index}`, 400),
    }));
    messages.push({ role: "user", content: "Why?" });
    const fit = budget.fit({
      instructions: "Answer well.",
      messages,
      question: "Why?",
      reserve: 4_500,
    });
    if (!fit.ok) throw new Error(fit.error.message);
    expect(fit.estimated + 4_500 + window.outputTokens).toBeLessThanOrEqual(window.tokens);
    expect(fit.messages.at(-1)?.content).toBe("Why?");
  });

  // protects=a request that held Documents' whole text says when the window left it out, and says nothing when it kept it; fails_when=the text is dropped unreported, or reported while it is still in the request; no_claim=none beyond protects.
  test("reports the Documents' whole text a window left out", () => {
    const whole = `<document-text>\nThe whole text of "Tides", as Passages.\n\n${passage("P1", 1_500)}\n</document-text>`;
    const asked = (question: string): AnswerMessage[] => [
      { role: "user", content: `${whole}\n\n${question}` },
    ];
    const kept = createWindowBudget(window).fit({
      instructions: "Answer well.",
      messages: asked("Why?"),
      question: "Why?",
    });
    expect(kept).toMatchObject({ ok: true });
    expect(kept).not.toHaveProperty("documentsDropped");
    const question = block("Long", 3_000);
    const dropped = createWindowBudget(window).fit({
      instructions: "Answer well.",
      messages: asked(question),
      question,
      reserve: 2_000,
    });
    expect(dropped).toMatchObject({ ok: true, documentsDropped: true });
  });

  test("a request whose Question alone doesn't fit fails as too long", () => {
    const fit = createWindowBudget(window).fit({
      instructions: "Answer well.",
      messages: [{ role: "user", content: block("Huge", 9_000) }],
      question: block("Huge", 9_000),
    });
    expect(fit).toMatchObject({ ok: false, error: { kind: "too-long" } });
  });

  test("a search's Passages are kept whole, in order, while they fit", () => {
    const budget = createWindowBudget(window);
    const passages = [passage("P1", 1_500), passage("P2", 1_500), passage("P3", 1_500)].join(
      "\n\n",
    );
    const loop = budget.loop(3_800);
    const first = loop.passages(passages, 3);
    expect(first.passageCount).toBe(1);
    expect(first.text).toContain('id="P1"');
    expect(first.text).not.toContain('id="P2"');
    // The window is full now: the next search gives none, and the model is told to answer.
    expect(loop.passages(passages, 3)).toEqual({ text: NO_ROOM_FOR_PASSAGES, passageCount: 0 });
    expect(loop.canCallTools()).toBe(false);
  });

  test("Passages that don't all fit keep the most relevant, by the search's ranks, in the order given", () => {
    const budget = createWindowBudget(window);
    const passages = [passage("P1", 2_000), passage("P2", 2_000), passage("P3", 2_000)].join(
      "\n\n",
    );
    const ids = (text: string) => [...text.matchAll(/id="(P\d)"/g)].map((match) => match[1]);

    // Room for two: P1 is the least relevant, though it comes first in reading order.
    expect(ids(budget.fitPassages(passages, "Answer well.", "Why?", [2, 0, 1]))).toEqual([
      "P2",
      "P3",
    ]);
    expect(ids(budget.loop(100).passages(passages, 3, [2, 0, 1]).text)).toEqual(["P2", "P3"]);
    // Without ranks, their order is their relevance.
    expect(ids(budget.fitPassages(passages, "Answer well.", "Why?"))).toEqual(["P1", "P2"]);
  });

  test("a search the first request carries counts once, in that request (#1633)", () => {
    const budget = createWindowBudget(window);
    const loop = budget.loop(1_000);
    const carried = loop.carried(passage("P1", 3_000), 1, undefined, (text) => [
      '{"query":"tides"}',
      `${text}\n\nSearch again with other words if these don't answer.`,
    ]);
    expect(carried.passageCount).toBe(1);
    const first = loop.firstRequest();
    expect(first).toBeGreaterThan(4_000);

    // Counted as Ollama counts it: the factor barely moves, and the room left is the real one.
    loop.stepFinished({ inputTokens: first, outputTokens: 100 });
    expect(budget.factor).toBeLessThan(ESTIMATE_FACTOR * 1.1);
    expect(loop.canCallTools()).toBe(true);
  });

  test("Ollama's own count of the first request replaces the estimate", () => {
    const budget = createWindowBudget(window);
    const loop = budget.loop(1_000);
    // The model counted twice what was estimated: the rest of the Answer counts larger.
    loop.stepFinished({ inputTokens: 2_000, outputTokens: 20 });
    expect(budget.factor).toBeGreaterThan(2);
    // And the room left is counted from the real size.
    const result = loop.passages(passage("P1", 1_000), 1);
    expect(result.passageCount).toBe(1);
  });
});

describe("The Passages a request said it read", () => {
  // A whole read counts the pages it read from these (#1554): a refused request read none.
  test("a request refused as too long counts only the smaller one sent again", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const found = {
      text: ids.map((id) => passage(`P-${id}`, 500)).join("\n\n"),
      passageCount: ids.length,
      passageIds: ids,
    };
    let sent = 0;
    const model = scriptedModel(() =>
      ++sent === 1
        ? {
            error: {
              status: 400,
              message: "request (12000 tokens) exceeds the available context size (8192 tokens)",
            },
          }
        : { text: "The tides turn twice a day." },
    );
    const reported: string[][] = [];
    for await (const _event of createAiSdkAnswerEngine().generate({
      instructions: (_mode, options) => `Answer from these.\n\n${options?.passages ?? ""}`,
      messages: [{ role: "user", content: "When do the tides turn?" }],
      question: "When do the tides turn?",
      model,
      documents: {
        documentCount: 1,
        searchDocuments: async () => found,
        cite: () => "Recorded.",
      },
      tools: [],
      support: "none",
      window: { tokens: 8192, outputTokens: 1024 },
      fitted: (passageIds) => reported.push([...passageIds]),
      signal: new AbortController().signal,
    })) {
      // Only what was reported read matters here.
    }

    expect(sent).toBe(2);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.length).toBeGreaterThan(0);
    expect(reported[0]?.length).toBeLessThan(ids.length);
  });
});
