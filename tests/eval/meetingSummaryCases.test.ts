import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import {
  replaySummaryRetention,
  summaryRetention,
  summaryRetentionHistoryProblems,
  summaryRetentionItemProblems,
  summaryRetentionOverviewProblems,
} from "../../eval/speed/meetingSummaryCases";
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

test.each(["before-stop", "in-flight-at-stop", "after-stop"] as const)(
  "the retention replay carries the visible list through later topics and the correction (%s)",
  async (timing) => {
    const { utterances } = summaryRetention;
    const stages = [openingChanges, [], [], [sampleReturnsChange], [], finalChanges];
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const user = options.prompt
          .flatMap((message) => (message.role === "user" ? message.content : []))
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        prompts.push(user);
        const index = prompts.length - 1;
        const raw = JSON.stringify({
          summary: `summary ${index + 1}`,
          changes: stages[index],
          ...(timing === "after-stop" &&
            index === stages.length - 1 && { unchanged: [initial[0].id] }),
        });
        return replyingModel(raw).doGenerate(options);
      },
    });
    const { checkpoints, warm, atStop, final } = await replaySummaryRetention({
      createChatModel: () => model,
      apiKey: "anthropic-test-key",
      modelId: "claude-haiku-5-5",
      timing,
    });
    expect(prompts).toHaveLength(utterances.length);
    const retained = [...initial, sampleReturns];
    for (const [index, text] of utterances.entries()) {
      expect(JSON.parse(prompts[index] ?? "")).toEqual({
        previous: index > 0 ? `summary ${index}` : null,
        ...(index > 0 && { items: index <= 3 ? initial : retained }),
        utterances: [{ text, speaker: "Speaker ?" }],
        language: "English",
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
    const visible = timing === "before-stop" ? final : warm;
    expect(atStop).toMatchObject({
      text: visible.text,
      throughMs: visible.throughMs,
      items: visible.items,
    });
  },
);

const warmList = [
  {
    id: 1,
    kind: "decision",
    status: "active",
    text: "Keep the warehouse open through October 18.",
  },
  { id: 2, kind: "decision", status: "active", text: "Set the operating budget at GBP 47,300." },
  {
    id: 3,
    kind: "action",
    status: "active",
    text: "Finance gets the signed extension from Vera Chen by the 8th of October.",
  },
  {
    id: 4,
    kind: "action",
    status: "active",
    text: "Casey Park leads the supplier hand-over on 7 Oct.",
  },
  {
    id: 5,
    kind: "action",
    status: "active",
    text: "Avery Ross sends the invites for the Oct. 9 kiosk demo.",
  },
  { ...sampleReturns, id: 6 },
] as const satisfies readonly MeetingSummaryItem[];

const finalList = [
  ...warmList.slice(0, 3),
  {
    ...warmList[3],
    text: "Jonah Reed leads the handover on October 14, replacing Casey Park and the original 7 October date.",
  },
  { ...cancelled, id: 5 },
  { ...completed, id: 6 },
] as const satisfies readonly MeetingSummaryItem[];

test("the fixture item checks accept split decisions, date phrasing and a historical owner and date", () => {
  expect(summaryRetentionItemProblems("warm", warmList)).toEqual([]);
  expect(summaryRetentionItemProblems("final", finalList)).toEqual([]);
});

test("the correction keeps the history of each task even when the final descriptions look right", () => {
  expect(summaryRetentionHistoryProblems(warmList, finalList)).toEqual([]);
  const recreated = [
    ...finalList.slice(0, 3),
    { ...warmList[3], status: "cancelled" as const },
    { ...corrected, id: 21 },
    { ...cancelled, id: 6 },
    { ...completed, id: 5 },
  ];
  expect(summaryRetentionItemProblems("final", recreated)).toEqual([]);
  expect(summaryRetentionHistoryProblems(warmList, recreated)).toEqual([
    "Expected the same supplier handover record. IDs before: 4. After: 4, 21.",
    "Expected the same kiosk invitations record. IDs before: 5. After: 6.",
    "Expected the same sample returns record. IDs before: 6. After: 5.",
  ]);
});

test("the fixture item checks catch the real dropped returns action on both sides of Stop", () => {
  expect(summaryRetentionItemProblems("warm", warmList.slice(0, -1))).toEqual([
    "Expected the service team's active sample-returns action for the next review.",
  ]);
  expect(summaryRetentionItemProblems("final", finalList.slice(0, -1))).toEqual([
    "Expected the service team's sample returns as completed, without a pending duplicate.",
  ]);
});

test("the fixture item checks reject stale active rows, a pending completion and conditional nomination", () => {
  expect(
    summaryRetentionItemProblems("final", [
      ...finalList.slice(0, -1),
      { ...warmList[3], id: 7 },
      { ...warmList[4], id: 8 },
      { ...sampleReturns, id: 9 },
      { id: 10, status: "active", kind: "action", text: "Zoe Bell will get insurance quotes." },
    ]),
  ).toEqual([
    "Expected one active handover for Jonah Reed on 14 October.",
    "The canceled demo or invitations still appear as active.",
    "Expected the service team's sample returns as completed, without a pending duplicate.",
    "The conditional insurance nomination appears as an item.",
  ]);
});

test("the overview review sees only speech already heard and reports the failing criterion", async () => {
  const model = replyingModel(
    JSON.stringify({
      outcome: { pass: false, reason: "No concrete decision or action." },
      accuracy: { pass: true, reason: "No unsupported claim." },
      synthesis: { pass: true, reason: "Short and readable." },
    }),
  );
  const text = "Earlier commitments remain active.";
  expect(await summaryRetentionOverviewProblems(model, "warm", text)).toEqual([
    "outcome: No concrete decision or action.",
  ]);
  expect(await summaryRetentionOverviewProblems(model, "final", text)).toEqual([
    "outcome: No concrete decision or action.",
  ]);
  const userPrompt = (index: number) =>
    model.doGenerateCalls[index]?.prompt.find((message) => message.role === "user")?.content;
  expect(userPrompt(0)).toEqual([
    {
      type: "text",
      text: expect.stringContaining(JSON.stringify(summaryRetention.utterances.slice(0, -1))),
    },
  ]);
  expect(userPrompt(1)).toEqual([
    {
      type: "text",
      text: expect.stringContaining(JSON.stringify(summaryRetention.utterances)),
    },
  ]);
});
