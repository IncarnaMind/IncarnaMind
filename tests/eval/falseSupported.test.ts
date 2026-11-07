/**
 * False Supported in a paired run's Answers and cells (eval/speed/unstated.ts): a judge reads each
 * sentence with a found Citation against its quotes; one they don't state counts, a Citation that
 * wasn't found never does, and the Questions and cells sets read it through that measure. A
 * scripted judge flags a sentence holding a number its quotes don't.
 */
import { getSchema } from "@tiptap/core";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { measuredAnswer, measuredCell } from "../../eval/speed/paired";
import { type CitedSentence, falseSupportedIn } from "../../eval/speed/unstated";
import { COMPARISON_CELL_NODE } from "../../src/core";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

/**
 * A judge that lists each sentence holding a number none of its quotes holds; `reply` replaces
 * what it says: prose, or the list it gives.
 */
function judging(reply?: (unstated: number[]) => string) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const text = prompt
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((part) => ("text" in part ? [part.text] : [])),
        )
        .join("\n");
      prompts.push(text);
      const sentences = text.split(/\n(?=\[\d+\] Sentence: )/).flatMap((block) => {
        const head = /^\[(\d+)\] Sentence: (.*)/.exec(block);
        if (!head) return [];
        const quotes = [...block.matchAll(/Quote: “(.*)”/g)].map((each) => each[1] ?? "");
        return [{ n: Number(head[1]), sentence: head[2] ?? "", quotes: quotes.join(" ") }];
      });
      const unstated = sentences
        .filter(({ sentence, quotes }) =>
          (sentence.match(/\d+/g) ?? []).some((number) => !quotes.includes(number)),
        )
        .map(({ n }) => n);
      return {
        content: [{ type: "text", text: reply ? reply(unstated) : JSON.stringify({ unstated }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

const UNSTATED: CitedSentence = {
  at: 0,
  sentence: "120 days",
  quote: "Termination notice",
  found: true,
};
const STATED: CitedSentence = {
  at: 1,
  sentence: "90 days",
  quote: "Termination notice: 90 days.",
  found: true,
};

describe("False Supported in an Answer or a cell", () => {
  test("a cell whose found quote doesn't state its value counts one; one whose quote states it counts none", async () => {
    expect(await falseSupportedIn(judging().model, [UNSTATED])).toBe(1);
    expect(await falseSupportedIn(judging().model, [STATED])).toBe(0);
    expect(
      await falseSupportedIn(judging().model, [
        STATED,
        UNSTATED,
        { at: 2, sentence: "45 days for cause", quote: "Termination notice", found: true },
      ]),
    ).toBe(2);
  });

  test("a Citation that wasn't found is never read, so it can't count", async () => {
    const { model, prompts } = judging();

    expect(await falseSupportedIn(model, [{ ...UNSTATED, found: false }, STATED])).toBe(0);
    expect(prompts[0]).not.toContain("120 days");
    expect(await falseSupportedIn(judging().model, [{ ...UNSTATED, found: false }])).toBe(0);
  });

  test("a judge whose reply can't be read twice gives no count, not none", async () => {
    const { model, prompts } = judging(() => "The first one looks off.");

    expect(await falseSupportedIn(model, [UNSTATED])).toBeNull();
    expect(prompts).toHaveLength(2);
  });

  test("a sentence with two Citations is judged once against both quotes, and counts once", async () => {
    const twice = { at: 0, sentence: "Notice is 90 days, or 30 days for cause", found: true };
    const { model, prompts } = judging();

    expect(
      await falseSupportedIn(model, [
        { ...twice, quote: "Termination notice: 90 days." },
        { ...twice, quote: "For cause: 30 days." },
      ]),
    ).toBe(0);
    expect(prompts[0]?.match(/Sentence:/g)).toHaveLength(1);
    expect(
      await falseSupportedIn(judging().model, [
        { ...twice, sentence: "Notice is 120 days, or 45 days for cause", quote: "Notice: 90." },
        { ...twice, sentence: "Notice is 120 days, or 45 days for cause", quote: "Cause: 30." },
      ]),
    ).toBe(1);
  });

  test("two sentences that read the same are each judged on their own quotes", async () => {
    const same = "Growth was 45% in the year.";
    const { model, prompts } = judging();

    expect(
      await falseSupportedIn(model, [
        { at: 0, sentence: same, quote: "Growth: 45% in the year.", found: true },
        { at: 3, sentence: same, quote: "Margins rose in the year.", found: true },
      ]),
    ).toBe(1);
    expect(prompts[0]?.match(/Sentence:/g)).toHaveLength(2);
  });

  test("numbers written as strings are read; anything else in the list is an unread reply", async () => {
    const asStrings = judging((unstated) => JSON.stringify({ unstated: unstated.map(String) }));
    expect(await falseSupportedIn(asStrings.model, [STATED, UNSTATED])).toBe(1);

    const named = judging(() => JSON.stringify({ unstated: ["the second"] }));
    expect(await falseSupportedIn(named.model, [STATED, UNSTATED])).toBeNull();
  });
});

const grade = async (): Promise<"right"> => "right";

describe("The Questions and cells sets read false Supported through the measure", () => {
  test("a Question's Answer whose found quote doesn't state its sentence counts one", async () => {
    const citation = (sentence: string, quote: string, sentenceIndex = 0) => ({
      sentence,
      sentenceIndex,
      quote,
      documentName: "Corvane Agreement",
      pageFrom: 1,
      pageTo: 1,
      check: "found" as const,
      checkReason: null,
      outcome: "found" as const,
      passagePages: [1, 1] as [number, number],
      quoteOn: [1, 1] as [number, number],
    });
    const answer = {
      status: "done" as const,
      error: null,
      searches: ["notice"],
      text: "The notice is 120 days[^1].",
      expected: null,
      timing: null,
      citations: [citation("The notice is 120 days.", "Termination notice")],
    };
    const expected = { question: "What is the notice?", quotes: ["Termination notice"] };

    expect((await measuredAnswer(answer, expected, grade, judging().model)).falseSupported).toBe(1);
    const stated = {
      ...answer,
      citations: [citation("The notice is 90 days.", "Notice: 90 days.")],
    };
    expect((await measuredAnswer(stated, expected, grade, judging().model)).falseSupported).toBe(0);
  });

  test("a cell whose found quote doesn't state its value counts one", async () => {
    const schema = getSchema(noteExtensions());
    const cell = (value: string, quote: string) =>
      schema.nodeFromJSON({
        type: COMPARISON_CELL_NODE,
        attrs: { questionId: "q1", status: "done" },
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: `${value} ` },
              {
                type: "citation",
                attrs: {
                  passageId: "p1",
                  documentId: "d1",
                  documentName: "Corvane Agreement",
                  contentHash: null,
                  pageFrom: 1,
                  pageTo: 1,
                  location: null,
                  quote,
                  check: "found",
                  checkReason: null,
                },
              },
            ],
          },
        ],
      });
    const needed = [{ document: "corvane", pages: [1, 1] as [number, number], quote: "Notice" }];

    const unstated = await measuredCell(
      cell("120 days", "Termination notice"),
      "Corvane Agreement",
      "Termination notice",
      needed,
      grade,
      judging().model,
    );
    expect(unstated.falseSupported).toBe(1);
    expect(unstated.found).toBe(1);
    const stated = await measuredCell(
      cell("90 days", "Termination notice: 90 days."),
      "Corvane Agreement",
      "Termination notice",
      needed,
      grade,
      judging().model,
    );
    expect(stated.falseSupported).toBe(0);
  });
});
