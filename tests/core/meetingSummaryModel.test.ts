import { MockLanguageModelV4 } from "ai/test";
import { expect, test, vi } from "vitest";
import { meetingSummaryPrompt, summarizeWithChat } from "../../src/core/meetings/summaryModel";
import { resolveCapabilities } from "../../src/core/providers/capabilities";

const describeModel = () => undefined;
const choice = { providerId: "chosen-provider", modelId: "chosen-model" };
const input = {
  previous: "Release on Friday. Priya will send the update.",
  utterances: [{ text: "Hold the release. Priya will send a correction.", speaker: "Speaker 2" }],
} as const;

test("the shared prompt sends only the meeting summary and confirmed speech", () => {
  const utterance = { ...input.utterances[0], documentId: "private", path: "private" };
  const item = { id: 1, kind: "action", status: "active", text: "Send corrections." } as const;
  const payload = {
    ...input,
    items: [{ ...item, filePath: "private", quote: "private" }],
    utterances: [utterance],
    meetingId: "private",
  };
  expect(JSON.parse(meetingSummaryPrompt(payload).prompt)).toEqual({
    previous: input.previous,
    items: [item],
    utterances: [{ line: 1, text: input.utterances[0].text, speaker: "Speaker 2" }],
    language: "English",
  });
});

test("the language of the meeting is used for a short bilingual update and stated once", () => {
  const prompt = meetingSummaryPrompt({
    previous: "团队决定周五上线，王敏负责发公告。预算为 12.5 万元，备份方案还没有选定。",
    utterances: [{ text: "Yes, we need to wait." }],
  });
  expect(JSON.parse(prompt.prompt)).toHaveProperty("language", "Chinese");
  expect(prompt.instructions.match(/in Chinese/g)).toHaveLength(1);
  expect(prompt.instructions).toContain(
    "Write summary and any newly added items in Chinese (keep unchanged existing items in their current language; never emit changes solely to translate them), regardless of the language of these instructions or examples.",
  );
});

test("instructions name an explicit language directly and fall back when language is absent", () => {
  const explicit = meetingSummaryPrompt({
    previous: null,
    utterances: [{ text: "123 456" }],
    language: "Japanese",
  });
  expect(explicit.instructions.match(/in Japanese/g)).toHaveLength(1);
  expect(explicit.instructions).toContain(
    "Write summary and any newly added items in Japanese (keep unchanged existing items in their current language; never emit changes solely to translate them), regardless of the language of these instructions or examples.",
  );

  const fallback =
    "Write summary and any newly added items in the meeting's main language (keep unchanged existing items in their current language; never emit changes solely to translate them), regardless of the language of these instructions or examples.";
  const absent = meetingSummaryPrompt({ previous: null, utterances: [{ text: "123 456" }] });
  expect(absent.instructions).toContain(fallback);
  expect(absent.instructions.match(/meeting's main language/g)).toHaveLength(1);

  const blank = meetingSummaryPrompt({
    previous: null,
    utterances: [{ text: "123 456" }],
    language: "   ",
  });
  expect(blank.instructions).toContain(fallback);
  expect(JSON.parse(blank.prompt)).not.toHaveProperty("language");
});

test("mid-meeting language switches update the target language without forcing translation of existing items", () => {
  const enToZh = meetingSummaryPrompt({
    previous: "The warehouse stays open through 18 October. Vera will send the signed extension.",
    items: [
      {
        id: 1,
        kind: "decision",
        status: "active",
        text: "Keep the warehouse open through 18 October.",
      },
    ],
    utterances: [
      { text: "接下来我们改用中文讨论。大家决定周三开复盘会。" },
      { text: "由陈琳负责发会议邀请。" },
    ],
  });
  expect(JSON.parse(enToZh.prompt)).toEqual({
    previous: "The warehouse stays open through 18 October. Vera will send the signed extension.",
    items: [
      {
        id: 1,
        kind: "decision",
        status: "active",
        text: "Keep the warehouse open through 18 October.",
      },
    ],
    utterances: [
      { line: 1, text: "接下来我们改用中文讨论。大家决定周三开复盘会。" },
      { line: 2, text: "由陈琳负责发会议邀请。" },
    ],
    language: "Chinese",
  });
  expect(enToZh.instructions.match(/in Chinese/g)).toHaveLength(1);
  expect(enToZh.instructions).toContain("never emit changes solely to translate them");

  const zhToEn = meetingSummaryPrompt({
    previous: "仓库开放至10月18日，王敏负责发延期协议。",
    items: [{ id: 1, kind: "decision", status: "active", text: "仓库开放至10月18日。" }],
    utterances: [
      { text: "Let us switch to English now. We agreed to move the review to Thursday." },
      { text: "Maya will send the updated agenda to the team." },
    ],
  });
  expect(JSON.parse(zhToEn.prompt)).toHaveProperty("language", "English");
  expect(zhToEn.instructions.match(/in English/g)).toHaveLength(1);
  expect(zhToEn.instructions).toContain("never emit changes solely to translate them");
});

test.each([
  {
    name: "English",
    utterances: [
      { speaker: "Me", text: "I will send the updated contract by Friday." },
      { speaker: "Them", text: "I will confirm the invoice on Monday." },
    ],
    expectedLanguage: "English",
  },
  {
    name: "Chinese",
    utterances: [
      { speaker: "Me", text: "我周五前把更新后的合同发过去。" },
      { speaker: "Them", text: "我周一确认发票金额。" },
    ],
    expectedLanguage: "Chinese",
  },
])(
  "call-style Me and Them speaker labels are preserved in the $name prompt and instructions",
  ({ utterances, expectedLanguage }) => {
    const prompt = meetingSummaryPrompt({ previous: null, utterances });
    expect(JSON.parse(prompt.prompt)).toEqual({
      previous: null,
      utterances: utterances.map((line, index) => ({ line: index + 1, ...line })),
      language: expectedLanguage,
    });
    expect(prompt.instructions).toContain("Never use generic or numbered speaker labels");
    expect(prompt.instructions).toContain(
      "In call transcripts labelled Me and Them, preserve who owns a commitment (Me vs. Them) in the output language.",
    );
  },
);

test("reconciliation instructions and unchanged accounting turn on whenever active items exist", () => {
  const active = { id: 1, kind: "action", status: "active", text: "Send the agenda." } as const;
  const cancelled = { id: 2, kind: "action", status: "cancelled", text: "Book the room." } as const;
  const withActive = meetingSummaryPrompt({ ...input, items: [active, cancelled] });
  expect(withActive.instructions).toContain("three keys");
  expect(withActive.instructions).toContain("unchanged");
  expect(withActive.instructions).toContain("When a deliverable is explicitly withdrawn");
  expect(withActive.instructions).toContain('"quotes":[{"quote":"…","source":1}]');
  expect(withActive.instructions).toContain("Never use generic or numbered speaker labels");
  expect(withActive.instructions).not.toContain("final confirmed segment");
  for (const withoutActive of [
    meetingSummaryPrompt(input),
    meetingSummaryPrompt({ ...input, items: [] }),
    meetingSummaryPrompt({ ...input, items: [cancelled] }),
  ]) {
    expect(withoutActive.instructions).toContain("two keys");
    expect(withoutActive.instructions).toContain('"quotes":[{"quote":"…","source":1}]');
    expect(withoutActive.instructions).toContain(
      "Finish with the changes array’s closing bracket and the object’s closing brace.",
    );
    expect(withoutActive.instructions).not.toContain("unchanged (an array of numeric IDs)");
  }
});

function reply(finishReason: "stop" | "length" = "stop") {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "  - Release on hold. Priya will send a correction.  " }],
      finishReason: { unified: finishReason, raw: undefined },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    },
  });
}

test("the summary calls only the prepared chat model and never asks for consent", async () => {
  const model = reply();
  const prepareModel = vi.fn(async () => ({ model, capabilities: resolveCapabilities({}) }));
  await expect(
    summarizeWithChat({ describeModel, prepareModel }, choice, input, new AbortController().signal),
  ).resolves.toBe("- Release on hold. Priya will send a correction.");
  expect(prepareModel).toHaveBeenCalledExactlyOnceWith(choice, "chat", "off", { background: true });
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(model.doGenerateCalls[0]?.prompt.at(-1)?.content).toEqual([
    { type: "text", text: meetingSummaryPrompt(input).prompt },
  ]);
});

test.each([
  { kind: "anthropic", modelId: "claude-haiku-5-5", status: "active", thinking: "task" },
  { kind: "anthropic", modelId: "claude-haiku-5-5", status: "done", thinking: "off" },
  { kind: "anthropic", modelId: "claude-haiku-5-5", status: null, thinking: "off" },
  { kind: "anthropic", modelId: "claude-sonnet-5-5", status: "active", thinking: "off" },
  { kind: "openai-compatible", modelId: "claude-haiku-5-5", status: "active", thinking: "off" },
] as const)(
  "$kind $modelId uses $thinking with prior status $status",
  async ({ kind, modelId, status, thinking }) => {
    const selected = { ...choice, modelId };
    const model = reply();
    const prepareModel = vi.fn(async () => ({ model, capabilities: resolveCapabilities({}) }));
    const expected = status && {
      id: 11,
      kind: "action" as const,
      status,
      text: "Send the agenda.",
    };
    await summarizeWithChat(
      { describeModel: () => ({ kind }), prepareModel },
      selected,
      { ...input, ...(expected && { items: [expected] }) },
      new AbortController().signal,
    );
    expect(prepareModel).toHaveBeenCalledExactlyOnceWith(selected, "chat", thinking, {
      background: true,
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  },
);

test.each([
  { maxOutput: 8_192, inWindow: 8_192, expected: 4_096 },
  { maxOutput: 1_536, inWindow: 8_192, expected: 1_536 },
  { maxOutput: 8_192, inWindow: 768, expected: 768 },
])(
  "a meeting summary can use $expected output tokens on the chosen model",
  async ({ maxOutput, inWindow, expected }) => {
    const model = reply();
    const prepareModel = async () => ({
      model,
      capabilities: resolveCapabilities({ server: { maxOutput } }),
      window: { tokens: 16_384, outputTokens: inWindow },
    });
    await summarizeWithChat(
      { describeModel, prepareModel },
      choice,
      input,
      new AbortController().signal,
    );
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(expected);
  },
);

test("a reply cut off mid-summary never replaces a complete draft", async () => {
  const model = reply("length");
  const prepareModel = async () => ({ model, capabilities: resolveCapabilities({}) });
  await expect(
    summarizeWithChat({ describeModel, prepareModel }, choice, input, new AbortController().signal),
  ).rejects.toMatchObject({
    wording: { key: "error.meeting.summaryIncomplete" },
  });
});

test("a route rejected during preparation is surfaced with no fallback", async () => {
  const unavailable = new Error("Selected provider unavailable");
  const prepareModel = vi.fn().mockRejectedValue(unavailable);
  const signal = new AbortController().signal;
  await expect(
    summarizeWithChat({ describeModel, prepareModel }, choice, input, signal),
  ).rejects.toBe(unavailable);
  expect(prepareModel).toHaveBeenCalledTimes(1);
});

test("cancellation during preparation prevents the model request", async () => {
  const model = new MockLanguageModelV4();
  const stop = new AbortController();
  const prepareModel = async () => {
    stop.abort();
    return { model, capabilities: resolveCapabilities({}) };
  };
  await expect(
    summarizeWithChat({ describeModel, prepareModel }, choice, input, stop.signal),
  ).rejects.toBe(stop.signal.reason);
  expect(model.doGenerateCalls).toHaveLength(0);
});
