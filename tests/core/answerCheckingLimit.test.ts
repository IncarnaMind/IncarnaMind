/**
 * Judging an Answer's sentences has a limit (#2311): its batches count toward the Answer's own
 * checking limit, $0.25, and the monthly cap, on the meter that holds a whole read to its budget
 * (#1554). The batch that would pass a limit sends nothing, and neither does any after it, so the
 * Citations it leaves are the Answer's last, Not checked with the limit named. Check the rest says
 * what the rest costs, sending nothing, and then judges it.
 */
import { describe, expect, test } from "vitest";
import type { MarkedCitation } from "../../src/core";
import { answerEnded, answerJudged, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import {
  type GenerateCall,
  type ReportedUsage,
  scriptedModel,
  unscripted,
} from "../helpers/models";

/** What one batch's reply reports it used: less than the meter reserves for it, as a real one is. */
const BATCH_USAGE: ReportedUsage = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1_500, text: 1_500, reasoning: undefined },
};

const lineOf = (n: number) => `Kiln ${n} is due in 2027`;

/** An Answer of `count` sentences, each citing its own line of the schedule. */
async function answered(
  count: number,
  {
    failing = false,
    // Priced high enough for 200 sentences' batches to pass the Answer's $0.25.
    modelId = "claude-opus-5-5",
    kind = "anthropic",
    usage = BATCH_USAGE,
    writes,
  }: {
    failing?: boolean;
    modelId?: string;
    kind?: "anthropic" | "openai";
    usage?: ReportedUsage;
    /** The tokens a batch's reply takes, its thinking and records: at its room, it is cut off there. */
    writes?: (sentences: number) => number;
  } = {},
) {
  const lines = Array.from({ length: count }, (_, index) => lineOf(index + 1));
  const batches: GenerateCall[] = [];
  const judging = { failing };
  const model = scriptedModel(
    (call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return {
          calls: [{ tool: "search_documents", input: { query: "kiln installed February" } }],
        };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passages = searches.flatMap((search) => shownPassages(search.text));
        const citations = lines.map((quote, index) => ({
          marker: index + 1,
          passage: passages.find((each) => each.text.includes(quote))?.id,
          quote,
        }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      // A sentence a paragraph, as a long Answer's list of points reads.
      return { text: lines.map((line, index) => `${line}[^${index + 1}].`).join("\n\n") };
    },
    {
      generate: (call) => {
        if (call.question === "claimed-changes") return { text: '{"claims":[]}' };
        if (call.question !== "sentence-batch") return unscripted(call.question, call.system);
        if (judging.failing) return { error: { status: 500, message: "The provider failed." } };
        batches.push(call);
        const count = [...call.prompt.matchAll(/<sentence number="\d+">/g)].length;
        const sentences = Array.from({ length: count }, (_, index) => ({
          number: index + 1,
          kind: "fact",
          verdict: "supported",
          roles: "same",
          time: "same",
          quoted: "states",
          says: "The schedule says so.",
        }));
        if (!writes) return { text: JSON.stringify({ sentences }), usage };
        const wrote = writes(count);
        const room = call.options.maxOutputTokens ?? Number.POSITIVE_INFINITY;
        return {
          text: JSON.stringify({ sentences }),
          cutOff: wrote >= room,
          usage: {
            ...usage,
            outputTokens: { total: Math.min(wrote, room), text: 70 * count, reasoning: undefined },
          },
        };
      },
    },
  );
  const core = startCore(await createTempDataFolder(), { createChatModel: () => model });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind,
    apiKey: kind === "anthropic" ? "sk-ant-test" : "sk-test",
    modelId,
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Kiln schedule.md",
      `# Kiln schedule\n\n${lines.map((line) => `${line}.`).join("\n\n")}\n`,
    ),
  ]);
  const asked = await core.askInConversation({ text: "When are the kilns installed?" });
  if (!asked.asked) throw new Error("Not asked.");
  expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
  const answer = await answerJudged(core, asked.conversation.id, asked.answerId);
  return { core, answer, batches, judging };
}

/** Each Citation's check, in the Answer's order. */
const checksOf = (citations: readonly MarkedCitation[]) =>
  [...citations].sort((a, b) => a.marker - b.marker).map((citation) => citation.check);

describe("judging an Answer's sentences stops at a limit, at the end", { timeout: 120_000 }, () => {
  test("200 sentences on a model that costs little: one request for each batch of eight, every one judged", async () => {
    const { answer, batches } = await answered(200, { modelId: "claude-haiku-5-5" });

    expect(checksOf(answer.citations)).toEqual(Array(200).fill("found"));
    expect(batches).toHaveLength(25);
  });

  test("200 sentences: the Answer's own limit stops it at a batch, the rest Not checked with the limit named, never ✓", async () => {
    const { answer, batches } = await answered(200);
    const checks = checksOf(answer.citations);
    const firstUnchecked = checks.indexOf("not-checked");

    expect(answer.citations).toHaveLength(200);
    expect(checks[0]).toBe("found");
    expect(firstUnchecked).toBeGreaterThan(0);
    // The cut falls at the end: nothing after the first Not checked was judged.
    expect(checks.slice(firstUnchecked).every((check) => check === "not-checked")).toBe(true);
    expect(
      answer.citations
        .filter((citation) => citation.check === "not-checked")
        .every((citation) => citation.checkReason === "answer-limit"),
    ).toBe(true);
    // One request for each batch of sentences it judged, eight at most to a batch.
    expect(batches.length).toBeLessThan(25);
    expect(batches.length * 8).toBeGreaterThanOrEqual(firstUnchecked);
  });

  test("the monthly limit the User set stops it the same way, and names itself", async () => {
    // An Answer reserves more than judging a batch does: the cap is set once it is written.
    const { core, answer, judging } = await answered(40, { failing: true });
    await core.updateSettings({ user: { monthlyCap: { amount: 0.1, currency: "USD" } } });
    judging.failing = false;

    await core.checkAnswerAgain({ conversationId: answer.conversationId, answerId: answer.id });
    const again = await answerJudged(core, answer.conversationId, answer.id);
    const checks = checksOf(again.citations);
    const firstUnchecked = checks.indexOf("not-checked");

    expect(checks[0]).toBe("found");
    expect(firstUnchecked).toBeGreaterThan(0);
    expect(checks.slice(firstUnchecked).every((check) => check === "not-checked")).toBe(true);
    expect(
      again.citations
        .filter((citation) => citation.check === "not-checked")
        .every((citation) => citation.checkReason === "monthly-limit"),
    ).toBe(true);
  });

  test.each([
    { modelId: "claude-sonnet-5-5", count: 8, sent: 1 },
    { modelId: "claude-haiku-5-5", count: 8, sent: 1 },
    // Three batches: the "up to" rounded to the cent no longer covers a most counted low.
    { modelId: "claude-sonnet-5-5", count: 24, sent: 3 },
  ])(
    "Check the rest of $count sentences on $modelId judges all of them within the most it said",
    async ({ modelId, count, sent }) => {
      const { core, answer, judging, batches } = await answered(count, { failing: true, modelId });
      judging.failing = false;
      const ids = { conversationId: answer.conversationId, answerId: answer.id };

      const estimate = await core.estimateAnswerCheck(ids);
      if (estimate?.billing !== "per-token" || !estimate.upTo?.cost) {
        throw new Error(`No estimate: ${JSON.stringify(estimate)}`);
      }
      await core.checkAnswerAgain({ ...ids, limit: estimate.upTo.cost });
      const again = await answerJudged(core, answer.conversationId, answer.id);

      expect(checksOf(answer.citations)).toEqual(Array(count).fill("not-checked"));
      expect(checksOf(again.citations)).toEqual(Array(count).fill("found"));
      expect(batches).toHaveLength(sent);
    },
  );

  test("200 sentences on Sonnet stop only once what they spent is close to the Answer's $0.25", async () => {
    // What a batch of eight used on Sonnet in the eval: about $0.014 a batch.
    const usage: ReportedUsage = {
      inputTokens: { total: 4_500, noCache: 4_500, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 500, text: 500, reasoning: undefined },
    };
    const { core, answer } = await answered(200, { modelId: "claude-sonnet-5-5", usage });
    const checks = checksOf(answer.citations);
    const judged = checks.indexOf("not-checked");
    const spent = (await core.getCostSummary()).spent
      .filter((each) => each.currency === "USD")
      .reduce((total, each) => total + each.amount, 0);

    expect(judged).toBeGreaterThan(0);
    expect(checks.slice(judged).every((check) => check === "not-checked")).toBe(true);
    // Within one batch of the limit: what the open batches reserved no longer stops it early.
    expect(spent).toBeGreaterThan(0.25 - 0.03);
    expect(spent).toBeLessThanOrEqual(0.25);
  });

  test("Check the rest says what the rest costs, sending nothing, then judges it within that", async () => {
    const { core, answer, batches } = await answered(200);
    const sent = batches.length;
    const ids = { conversationId: answer.conversationId, answerId: answer.id };

    const estimate = await core.estimateAnswerCheck(ids);

    expect(batches).toHaveLength(sent);
    if (estimate?.billing !== "per-token" || !estimate.cost || !estimate.upTo?.cost) {
      throw new Error(`No estimate: ${JSON.stringify(estimate)}`);
    }
    expect(estimate.cost.amount).toBeGreaterThan(0);
    expect(estimate.upTo.cost.amount).toBeGreaterThan(estimate.cost.amount);

    await core.checkAnswerAgain({ ...ids, limit: estimate.upTo.cost });
    const again = await answerJudged(core, answer.conversationId, answer.id);

    expect(checksOf(again.citations).every((check) => check === "found")).toBe(true);
    expect(batches.length).toBeGreaterThan(sent);
  });
});

describe("a batch's room holds a model's thinking before its records (#2951)", {
  timeout: 120_000,
}, () => {
  /** Each batch's room, largest first: batches are sent a few at once. */
  const roomsOf = (batches: readonly GenerateCall[]) =>
    batches.map((batch) => batch.options.maxOutputTokens ?? 0).sort((a, b) => b - a);

  test.each([
    { count: 1, rooms: [5_300] },
    { count: 2, rooms: [5_600] },
    { count: 8, rooms: [7_400] },
    { count: 9, rooms: [7_400, 5_300] },
  ])(
    "$count sentences: each batch has 5,000 tokens for thinking and 300 a sentence",
    async ({ count, rooms }) => {
      const { answer, batches } = await answered(count, { modelId: "claude-haiku-5-5" });

      expect(roomsOf(batches)).toEqual(rooms);
      expect(checksOf(answer.citations)).toEqual(Array(count).fill("found"));
    },
  );

  test.each([
    // The longest whole replies measured, their thinking and records together.
    { model: "Claude Haiku 5.5", sentences: 1, wrote: 728 },
    { model: "DeepSeek V4.1 Flash", sentences: 3, wrote: 4_608 },
    { model: "DeepSeek V4.1 Flash", sentences: 6, wrote: 6_626 },
  ])(
    "a reply of $wrote tokens for $sentences sentences, as $model wrote one, is read: Supported",
    async ({ sentences, wrote }) => {
      const { answer } = await answered(sentences, {
        modelId: "claude-haiku-5-5",
        writes: () => wrote,
      });

      expect(checksOf(answer.citations)).toEqual(Array(sentences).fill("found"));
    },
  );

  test("a reply that still reaches its room grants nothing: its sentences stay Not checked, and the next batch is still sent", async () => {
    const { answer, batches } = await answered(9, {
      modelId: "claude-haiku-5-5",
      writes: (sentences) => (sentences === 8 ? 9_000 : 300),
    });

    expect(roomsOf(batches)).toEqual([7_400, 5_300]);
    expect(checksOf(answer.citations)).toEqual([...Array(8).fill("not-checked"), "found"]);
    expect(answer.citations.every((citation) => citation.checkReason == null)).toBe(true);
  });

  test("on a model whose room for thinking would pass the Answer's $0.25, every batch still goes, with the room for its records alone", async () => {
    // Claude Fable 5 at $10 in and $50 out a million tokens: 7,400 tokens out is $0.37 alone.
    const { answer, batches } = await answered(9, { modelId: "claude-fable-5" });

    expect(roomsOf(batches)).toEqual([2_400, 300]);
    expect(checksOf(answer.citations)).toEqual(Array(9).fill("found"));
  });

  test("a model whose own most is under the room, as GPT-4 Turbo's 4,096 tokens, gets the room for its records alone", async () => {
    const { answer, batches } = await answered(9, { kind: "openai", modelId: "gpt-4-turbo" });

    expect(roomsOf(batches)).toEqual([2_400, 300]);
    expect(checksOf(answer.citations)).toEqual(Array(9).fill("found"));
  });

  test("a batch that waits for the others to settle takes the room for thinking once the limit has it", async () => {
    // Claude Opus 5.5 at $4 in and $20 out: 7,400 tokens out sets aside $0.148, 2,400 sets aside
    // $0.048. The second batch fits only with the records' room beside the first; the third waits
    // for both, and then the larger room fits.
    const { answer, batches } = await answered(24, { modelId: "claude-opus-5-5" });

    expect(roomsOf(batches)).toEqual([7_400, 7_400, 2_400]);
    expect(checksOf(answer.citations)).toEqual(Array(24).fill("found"));
  });

  test("near the monthly cap, a batch the room for thinking would take past it goes with the room for its records, as before", async () => {
    const { core, answer, judging, batches } = await answered(1, {
      failing: true,
      modelId: "claude-sonnet-5-5",
    });
    const spent = (await core.getCostSummary()).spent
      .filter((each) => each.currency === "USD")
      .reduce((total, each) => total + each.amount, 0);
    // $0.02 left: 5,300 tokens out on Sonnet ($10 a million) is $0.053, 300 is $0.003.
    await core.updateSettings({
      user: { monthlyCap: { amount: spent + 0.02, currency: "USD" } },
    });
    judging.failing = false;

    await core.checkAnswerAgain({ conversationId: answer.conversationId, answerId: answer.id });
    const again = await answerJudged(core, answer.conversationId, answer.id);

    expect(roomsOf(batches)).toEqual([300]);
    expect(checksOf(again.citations)).toEqual(["found"]);
  });
});

test("a batch of eight sends the same request with either room, its limit the one difference (#2951)", {
  timeout: 120_000,
}, async () => {
  const { core, answer, judging, batches } = await answered(8, {
    failing: true,
    modelId: "claude-sonnet-5-5",
  });
  const asked = await core.askInConversation({ text: "When are the kilns installed?" });
  if (!asked.asked) throw new Error("Not asked.");
  await answerEnded(core, asked.answerId);
  const second = await answerJudged(core, asked.conversation.id, asked.answerId);
  judging.failing = false;

  await core.checkAnswerAgain({ conversationId: answer.conversationId, answerId: answer.id });
  await answerJudged(core, answer.conversationId, answer.id);
  const spent = (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);
  // $0.04 left: 7,400 tokens out on Sonnet is $0.074, 2,400 is $0.024.
  await core.updateSettings({ user: { monthlyCap: { amount: spent + 0.04, currency: "USD" } } });
  await core.checkAnswerAgain({ conversationId: second.conversationId, answerId: second.id });
  await answerJudged(core, second.conversationId, second.id);

  const [roomy, records] = batches;
  const { maxOutputTokens: roomyLimit, abortSignal: _first, ...roomyRest } = roomy?.options ?? {};
  const {
    maxOutputTokens: recordsLimit,
    abortSignal: _second,
    ...recordsRest
  } = records?.options ?? {};
  expect([roomyLimit, recordsLimit]).toEqual([7_400, 2_400]);
  expect(recordsRest).toEqual(roomyRest);
});
