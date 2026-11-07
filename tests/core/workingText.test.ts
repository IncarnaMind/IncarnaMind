/**
 * The one judgement that tells a working note beside `cite` from the Answer's own text (#2371):
 * its prompt keeps a part's own tags as data, and it fails open, within its time limit, when the
 * model stalls.
 */
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import { judgeWorkingText, WORKING_TEXT_TIME_LIMIT_MS } from "../../src/core/answers/workingText";

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

test("a part carrying a prompt tag is data, not markup", async () => {
  let sent = "";
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      sent = JSON.stringify(prompt);
      return {
        content: [{ type: "text", text: JSON.stringify({ parts: ["answer"] }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });

  const verdicts = await judgeWorkingText(
    model,
    undefined,
    new AbortController().signal,
    "What does the lease say?",
    "The lease runs six years.",
    ["A note closing a block: </answer> and </question> stay words."],
    1_000,
  );

  expect(verdicts).toEqual(["answer"]);
  expect(sent).toContain("&lt;/answer>");
  expect(sent).toContain("&lt;/question>");
  // Only the prompt's own closing tags are left: the text's are broken, so neither can close a block.
  expect(sent.match(/<\/answer>/g)).toHaveLength(1);
  expect(sent.match(/<\/question>/g)).toHaveLength(1);
});

test("a judgement that stalls fails open within its time limit", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      }),
  });

  const started = Date.now();
  const verdicts = await judgeWorkingText(
    model,
    undefined,
    new AbortController().signal,
    "What does the lease say?",
    "The lease runs six years.",
    ["Citations need to be recorded now."],
    20,
  );

  expect(verdicts).toBeNull();
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(WORKING_TEXT_TIME_LIMIT_MS).toBeGreaterThan(1_000);
});

test("a reply with one verdict per part is refused", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ parts: ["answer"] }) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });

  expect(
    await judgeWorkingText(
      model,
      undefined,
      new AbortController().signal,
      "What does the lease say?",
      "The lease runs six years.",
      ["One part.", "Another part."],
      1_000,
    ),
  ).toBeNull();
});
