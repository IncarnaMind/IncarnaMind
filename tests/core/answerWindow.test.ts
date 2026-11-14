/**
 * Fitting an Answer's requests into a local model's window (see
 * src/core/answers/window.ts): the Question context is cut by the same rules
 * as when it is built (src/core/answers/context.ts), and search results keep
 * whole Passages.
 */
import { describe, expect, test } from "vitest";
import {
  estimateTokens,
  fitQuestionContext,
  type RequestMind,
} from "../../src/core/answers/context";
import { type AnswerMessage, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import {
  createWindowBudget,
  ESTIMATE_FACTOR,
  NO_ROOM_FOR_PASSAGES,
  OUTPUT_FLOOR_TOKENS,
  SEARCH_RESERVE_TOKENS,
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
    const ids = (text: string | null) =>
      [...(text ?? "").matchAll(/id="(P\d)"/g)].map((match) => match[1]);

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

describe("A small window's output cap and its problems (#3045)", () => {
  // As the budget counts: the message around the instructions, a Passage of 500 at 1.25, a step's 128.
  const MESSAGE = 8;
  const ONE_PASSAGE = 625 + 128;
  const MARGIN = 128;
  /** What `instructions` take in a budget, with the message around them. */
  const fixedOf = (instructions: string) =>
    createWindowBudget({ tokens: 100_000, outputTokens: 4_096 }).tokens(instructions) + MESSAGE;
  const reading = (instructions: string, question: string) => ({
    instructions,
    messages: [{ role: "user" as const, content: question }],
    question,
    reserve: SEARCH_RESERVE_TOKENS,
    reads: true as const,
  });

  // protects=which problem a request that can't be sent gets is decided by one test, so its advice is true: where an empty Question would leave room for one Passage beside the instructions at the floor, a Question that doesn't leave it is too long ("shorten it"); one token less of window, and no Question could, so the window is too small; fails_when=either side of the boundary gets the other's problem; no_claim=the lines' words.
  test("the boundary between a Question too long and a window too small", () => {
    const instructions = block("Instructions", 4_000);
    const edge = fixedOf(instructions) + OUTPUT_FLOOR_TOKENS + MARGIN + MESSAGE + ONE_PASSAGE;
    const fitAt = (tokens: number, question: string) =>
      createWindowBudget({ tokens, outputTokens: 4_096 }).fit(reading(instructions, question));

    expect(fitAt(edge, "")).toMatchObject({ ok: true });
    expect(fitAt(edge, "Why?")).toMatchObject({ ok: false, error: { kind: "too-long" } });
    expect(fitAt(edge - 1, "")).toMatchObject({ ok: false, error: { kind: "window-too-small" } });
    expect(fitAt(edge - 1, "Why?")).toMatchObject({
      ok: false,
      error: { kind: "window-too-small" },
    });
  });

  // protects=where it reads, the line naming the Documents on screen goes with the Question: a window that holds the Question beside a Passage at the floor, but not with that line too, gives today's too-long, never a request without the line; one that holds both sends it in its place before the Question; fails_when=the Question is sent without the line, or the problem says the selection is too long; no_claim=the line's wording.
  test("the Documents on screen go with the Question, or the Question is too long", () => {
    const instructions = block("Instructions", 4_000);
    const question = "Summarise this document.";
    const shown = 'On screen now: "Harbour handbook"';
    const budgetAt = (tokens: number) => createWindowBudget({ tokens, outputTokens: 4_096 });
    const withShown = {
      ...reading(instructions, question),
      messages: [{ role: "user" as const, content: `${shown}\n\n${question}` }],
      onScreen: shown,
    };
    // The least window that holds the Question alone beside a Passage at the floor.
    const edge =
      fixedOf(instructions) +
      OUTPUT_FLOOR_TOKENS +
      MARGIN +
      ONE_PASSAGE +
      budgetAt(100_000).tokens(question) +
      MESSAGE;

    expect(budgetAt(edge).fit(reading(instructions, question))).toMatchObject({ ok: true });
    const tooLong = budgetAt(edge).fit(withShown);
    expect(tooLong).toMatchObject({ ok: false, error: { kind: "too-long" } });
    expect(tooLong.ok === false && tooLong.error.tooLong).toBeUndefined();
    const sent = budgetAt(edge + 100).fit(withShown);
    expect(sent.ok && sent.messages.at(-1)?.content).toBe(`${shown}\n\n${question}`);
  });

  // protects=where it reads, a selection is sent whole or not asked at every window, a token at a time across the point where it stops fitting beside three Passages at the floor, where the cap gives way for it and where it fits at the whole cap: on a first Question with the Mind's text in the message and without it, and on a follow-up whose turn is too long to keep, with and without it; the Mind's cut is never asked to keep the selection, which goes with the Question; fails_when=at any window the selection is cut, left out or refused as anything else, or the Mind's cut is asked to keep it; no_claim=the Mind's own cut, which the Mind's tests cover; the band it found on adc164c4c, where the Mind's cut shortened it at the whole cap, is why it walks every token.
  test.each([
    ["a first Question, the Mind's text in the message", true, false],
    ["a first Question, no Mind text in the message", false, false],
    ["a follow-up whose turn is too long to keep, the Mind's text in the message", true, true],
    ["a follow-up whose turn is too long to keep, no Mind text in the message", false, true],
  ] as const)(
    "a selection goes whole or not at all at every window: %s",
    (_, withText, followUp) => {
      const instructions = block("Instructions", 1_000);
      const question = "Make this shorter.";
      const words = "berth ".repeat(240).trim();
      const selection = `<selection>\n${words}\n</selection>`;
      const mindText = `<mind name="Notes">\n${"note ".repeat(160).trim()}\n</mind>`;
      const keptBy: string[] = [];
      const mind: RequestMind = {
        text: mindText,
        selection,
        // As the Mind's own cut would at its tightest: it shortens a selection it is asked to keep.
        cut: (tokens, withSelection = true) => {
          if (withSelection) keptBy.push(`cut(${tokens}, true)`);
          return {
            text: `<mind name="Notes">\n[…]\n</mind>`,
            selection: withSelection
              ? `<selection>\n${words.slice(0, Math.max(0, tokens * 2))}…\n</selection>`
              : "",
            share: 0,
          };
        },
      };
      const asked = `${selection}\n\nSearch scope: All Documents (1)\n\n${question}`;
      const opening = (text: string) => (withText ? `${mindText}\n\n${text}` : text);
      const messages: AnswerMessage[] = followUp
        ? [
            { role: "user", content: opening("When are spring tides?") },
            { role: "assistant", content: "At new moon and at full moon." },
            { role: "user", content: "And neap tides?" },
            { role: "assistant", content: `At the quarter moons. ${"pilot ".repeat(3_200)}` },
            { role: "user", content: asked },
          ]
        : [{ role: "user", content: opening(asked) }];
      const asking = { ...reading(instructions, question), messages, mind };
      const caps = new Set<number>();
      let refused = 0;
      for (let tokens = 4_500; tokens <= 11_500; tokens++) {
        const budget = createWindowBudget({ tokens, outputTokens: 4_096 });
        const fitted = budget.fit(asking);
        expect(keptBy, `window ${tokens}`).toEqual([]);
        if (fitted.ok) {
          const sent = fitted.messages.map((message) => message.content).join("\n\n");
          expect(sent.includes(selection), `window ${tokens}`).toBe(true);
          expect(sent.includes("…\n</selection>"), `window ${tokens}`).toBe(false);
          caps.add(budget.window.outputTokens);
        } else {
          expect(fitted.error, `window ${tokens}`).toMatchObject({
            kind: "too-long",
            tooLong: "selection",
          });
          refused++;
        }
      }
      // The walk crossed the refusal, the cap giving way for the selection, and the whole cap.
      expect(refused).toBeGreaterThan(0);
      expect(Math.min(...caps)).toBe(OUTPUT_FLOOR_TOKENS);
      expect(caps.has(4_096)).toBe(true);
    },
  );

  // protects=the output cap gives way only as far as the first search's room needs, never below the floor, and not at all where it fits: the cap sent is the one the budget counted with; fails_when=it drops straight to the floor, moves where it fits, or goes below the floor; no_claim=what a model writes at the cap.
  test("the cap gives way as far as the first search's room needs, never below the floor", () => {
    const capOf = (tokens: number, instructionTokens: number) => {
      const budget = createWindowBudget({ tokens, outputTokens: 4_096 });
      const fit = budget.fit(reading(block("Instructions", instructionTokens), "Why?"));
      if (!fit.ok) throw new Error(fit.error.message);
      return { cap: budget.window.outputTokens, lowered: budget.lowered };
    };
    // At 16k, the assistant's instructions and Tools (about 12,150) leave the cap at its floor.
    expect(capOf(16_384, 9_700)).toEqual({ cap: OUTPUT_FLOOR_TOKENS, lowered: true });
    // At 18k, part of the way.
    const partly = capOf(18_432, 9_700);
    expect(partly.cap).toBeGreaterThan(OUTPUT_FLOOR_TOKENS);
    expect(partly.cap).toBeLessThan(4_096);
    expect(partly.lowered).toBe(true);
    // Where it fits, not at all.
    expect(capOf(32_768, 9_700)).toEqual({ cap: 4_096, lowered: false });
  });

  // protects=the floor a window sets is kept (an evaluation compares floors through the model's settings), and a model that can only think keeps its whole cap, so at 16k the assistant's request is a window too small, never one whose thinking fills a lowered cap; fails_when=the cap goes below the window's floor; no_claim=which floor is right, which the real-model runs measure.
  test("a window's own floor, and a model that can only think", () => {
    const instructions = block("Instructions", 9_700);
    const budget = createWindowBudget({ tokens: 16_384, outputTokens: 4_096, outputFloor: 2_048 });
    expect(budget.fit(reading(instructions, "Why?"))).toMatchObject({ ok: true });
    expect(budget.window.outputTokens).toBe(2_048);

    const thinking = createWindowBudget({
      tokens: 16_384,
      outputTokens: 8_192,
      outputFloor: 8_192,
    });
    expect(thinking.fit(reading(instructions, "Why?"))).toMatchObject({
      ok: false,
      error: { kind: "window-too-small" },
    });
    expect(thinking.window.outputTokens).toBe(8_192);
  });

  // protects=in one pass, where the search found Passages and none fits beside the instructions, the Answer doesn't go on as if it had read them: there is no fitted text, and the problem is the window's; fails_when=the model is sent the no-room line and answers; no_claim=Passages that fit, which keep their order by rank.
  test("one pass: Passages found that don't fit leave nothing to answer from", () => {
    const budget = createWindowBudget({ tokens: 4_096, outputTokens: 1_024 });
    const found = [passage("P1", 4_000), passage("P2", 4_000)].join("\n\n");
    expect(budget.fitPassages(found, "Answer well.", "Why?")).toBeNull();
    expect(budget.cannotRead("Answer well.", "Why?")).toMatchObject({ kind: "window-too-small" });
    expect(budget.fitPassages(passage("P1", 500), "Answer well.", "Why?")).toContain('id="P1"');
  });
});
