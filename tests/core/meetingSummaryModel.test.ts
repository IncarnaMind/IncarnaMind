import { MockLanguageModelV4 } from "ai/test";
import { expect, test, vi } from "vitest";
import { meetingSummaryPrompt, summarizeWithChat } from "../../src/core/meetings/summaryModel";

const choice = { providerId: "chosen-provider", modelId: "chosen-model" };
const input = {
  previous: "Release on Friday. Priya will send the update.",
  utterances: [{ text: "Hold the release. Priya will send a correction.", speaker: "Speaker 2" }],
} as const;

test("the shared prompt sends only the meeting summary and confirmed speech", () => {
  const utterance = { ...input.utterances[0], documentId: "private", path: "private" };
  const payload = { ...input, utterances: [utterance], meetingId: "private" };
  expect(JSON.parse(meetingSummaryPrompt(payload).prompt)).toEqual({
    ...input,
    language: "English",
  });
});

test("the language of the meeting is used for a short bilingual update", () => {
  const prompt = meetingSummaryPrompt({
    previous: "团队决定周五上线，王敏负责发公告。预算为 12.5 万元，备份方案还没有选定。",
    utterances: [{ text: "Yes, we need to wait." }],
  });
  expect(JSON.parse(prompt.prompt)).toHaveProperty("language", "Chinese");
});

test("the summary calls only the prepared chat model and never asks for consent", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "  - Release on hold. Priya will send a correction.  " }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    },
  });
  const prepareModel = vi.fn(async () => ({ model }));
  await expect(
    summarizeWithChat({ prepareModel }, choice, input, new AbortController().signal),
  ).resolves.toBe("- Release on hold. Priya will send a correction.");
  expect(prepareModel).toHaveBeenCalledExactlyOnceWith(choice, "chat", "off", { background: true });
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(model.doGenerateCalls[0]?.prompt.at(-1)?.content).toEqual([
    { type: "text", text: meetingSummaryPrompt(input).prompt },
  ]);
});

test("a route rejected during preparation is surfaced with no fallback", async () => {
  const unavailable = new Error("Selected provider unavailable");
  const prepareModel = vi.fn().mockRejectedValue(unavailable);
  const signal = new AbortController().signal;
  await expect(summarizeWithChat({ prepareModel }, choice, input, signal)).rejects.toBe(
    unavailable,
  );
  expect(prepareModel).toHaveBeenCalledTimes(1);
});

test("cancellation during preparation prevents the model request", async () => {
  const model = new MockLanguageModelV4();
  const stop = new AbortController();
  const prepareModel = async () => {
    stop.abort();
    return { model };
  };
  await expect(summarizeWithChat({ prepareModel }, choice, input, stop.signal)).rejects.toBe(
    stop.signal.reason,
  );
  expect(model.doGenerateCalls).toHaveLength(0);
});
