import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import { replaySummaryRetention, summaryRetention } from "../../eval/speed/meetingSummaryCases";
import type { MeetingSummaryItem } from "../../src/core/api";
import { replyingModel } from "../helpers/models";

const initial = [
  {
    id: 1,
    kind: "decision",
    status: "active",
    text: "Keep the warehouse open through 18 October.",
  },
  { id: 2, kind: "action", status: "active", text: "Casey Park leads the 7 October handover." },
  { id: 3, kind: "action", status: "active", text: "Avery Ross sends kiosk demo invitations." },
] as const satisfies readonly MeetingSummaryItem[];
const corrected = { ...initial[1], text: "Jonah Reed leads the 14 October handover." };
const cancelled = {
  ...initial[2],
  status: "cancelled" as const,
  text: "Avery Ross's kiosk demo invitations were cancelled.",
};

const sampleReturns = {
  id: 4,
  kind: "action",
  status: "active",
  text: "The service team will bring sample returns to the next review.",
} satisfies MeetingSummaryItem;
const completed = {
  ...sampleReturns,
  status: "done" as const,
  text: "The service team has sent the sample returns.",
};

const openingChanges = [
  { ...initial[0], id: null, quote: "the warehouse stays open through 18 October" },
  { ...initial[1], id: null, quote: "Casey Park will lead the supplier handover on 7 October" },
  { ...initial[2], id: null, quote: "Avery Ross will send the invitations" },
];
const sampleReturnsChange = {
  ...sampleReturns,
  id: null,
  quote: "The service team will bring sample returns to the next review.",
};
const finalChanges = [
  {
    ...corrected,
    quote: "We are moving it from 7 October to 14 October. Jonah Reed owns it now.",
  },
  { ...cancelled, quote: "Avery Ross should not send any invitations" },
  { ...completed, quote: "The service team has already sent the sample returns" },
];

test("the retention replay carries the visible list through later topics and revises it at Stop", async () => {
  const { utterances } = summaryRetention;
  const stages = [openingChanges, [], [], [sampleReturnsChange], [], finalChanges];
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const prompt = options.prompt
        .flatMap((message) => (message.role === "user" ? message.content : []))
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      prompts.push(prompt);
      const index = prompts.length - 1;
      const raw = JSON.stringify({ summary: `summary ${index + 1}`, changes: stages[index] });
      return replyingModel(raw).doGenerate(options);
    },
  });
  const { checkpoints, warm, final } = await replaySummaryRetention({
    createChatModel: () => model,
    apiKey: "anthropic-test-key",
    modelId: "claude-haiku-5-5",
  });
  expect(prompts).toHaveLength(utterances.length);
  const retained = [...initial, sampleReturns];
  for (const [index, text] of utterances.entries()) {
    expect(JSON.parse(prompts[index] ?? "")).toMatchObject({
      previous: index > 0 ? `summary ${index}` : null,
      ...(index > 0 && { items: index <= 3 ? initial : retained }),
      utterances: [{ text }],
    });
  }
  expect(checkpoints.map((draft) => draft.items)).toEqual([
    initial,
    initial,
    initial,
    retained,
    retained,
  ]);
  expect(warm).toEqual(checkpoints.at(-1));
  expect(final.throughMs).toBeGreaterThan(warm.throughMs);
  expect(final.items).toEqual([initial[0], corrected, cancelled, completed]);
});
