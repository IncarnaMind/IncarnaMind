/**
 * False Supported in a paired run's Answers and cells (eval/speed/unstated.ts): a judge reads each
 * found Citation's sentence against its quote; one whose quote doesn't state it counts, one that
 * wasn't found never does. A scripted judge flags a sentence whose number its quote doesn't hold.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { type CitedSentence, falseSupportedIn } from "../../eval/speed/unstated";

/** A judge that lists each pair whose sentence has a number its quote doesn't; `prose`: it never gives JSON. */
function judging(prose = false) {
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
      const pairs = [...text.matchAll(/\[(\d+)\] Sentence: (.*)\n\s+Quote: “(.*)”/g)];
      const unstated = pairs
        .filter(([, , sentence = "", quote = ""]) =>
          (sentence.match(/\d+/g) ?? []).some((number) => !quote.includes(number)),
        )
        .map(([, n]) => Number(n));
      return {
        content: [
          { type: "text", text: prose ? "The first one looks off." : JSON.stringify({ unstated }) },
        ],
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

const UNSTATED: CitedSentence = { sentence: "120 days", quote: "Termination notice", found: true };
const STATED: CitedSentence = {
  sentence: "90 days",
  quote: "Termination notice: 90 days.",
  found: true,
};

describe("False Supported in an Answer or a cell", () => {
  test("a cell whose found quote doesn't state its value counts one; one whose quote states it counts none", async () => {
    expect(await falseSupportedIn(judging().model, [UNSTATED])).toBe(1);
    expect(await falseSupportedIn(judging().model, [STATED])).toBe(0);
    expect(await falseSupportedIn(judging().model, [STATED, UNSTATED, UNSTATED])).toBe(2);
  });

  test("a Citation that wasn't found is never read, so it can't count", async () => {
    const { model, prompts } = judging();

    expect(await falseSupportedIn(model, [{ ...UNSTATED, found: false }, STATED])).toBe(0);
    expect(prompts[0]).not.toContain("120 days");
    expect(await falseSupportedIn(judging().model, [{ ...UNSTATED, found: false }])).toBe(0);
  });

  test("a judge whose reply can't be read twice gives no count, not none", async () => {
    const { model, prompts } = judging(true);

    expect(await falseSupportedIn(model, [UNSTATED])).toBeNull();
    expect(prompts).toHaveLength(2);
  });
});
