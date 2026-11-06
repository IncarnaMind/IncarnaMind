import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { thisAnswersRecord, unbackedClaims } from "../../src/core/answers/claimedChanges";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { appliedFact, changeFact } from "../../src/renderer/src/changeFacts";
import { waitsForUser } from "../../src/shared/askedChanges";
import { translate } from "../../src/shared/i18n";
import { askAssistant, changesIn, lastResult } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/*
 * "Delete one sentence from the Parking paragraph", as DeepSeek V4.1 Flash 1017 (deepseek-flash)
 * did it on #2356's earlier heads: the edits it wrote, each as a scripted rewrite, on the Note it
 * wrote them on. What the change did is said from the change itself, never from the reply; an
 * edit asked only to take text out that rewrites what it keeps waits for the User.
 */

const LEASE = {
  en: {
    name: "Lease terms",
    lines: [
      "Rent: from 1 March 2026 the monthly rent is 98,000, paid by the 5th of each month. It is reviewed every two years.",
      "Parking: the tenant may use six underground spaces. Each costs 800 a month. Spaces are allocated by the landlord.",
      "Deposit: three months' rent, held by the landlord.",
      "Signing: the supplement was signed on 20 January 2026.",
    ],
    part: "Parking: the tenant may",
    asked: "Delete one sentence from the Parking paragraph.",
  },
  zh: {
    name: "租赁条款",
    lines: [
      "租金：自 2026 年 3 月 1 日起，月租金为九万八千元，每月 5 日前支付。租金每两年调整一次。",
      "停车位：承租方可使用地下停车位 6 个。每个车位每月 800 元。车位由出租方分配。",
      "押金：三个月租金，由出租方保管。",
      "签署：补充协议于 2026 年 1 月 20 日签署。",
    ],
    part: "停车位：承租方可使用",
    asked: "从停车位那一段删掉一句话。",
  },
} as const;

const APPLIES = "It applies in the Note at once";

function removing(language: "en" | "zh", parking: string, reply: string, removesOnly?: boolean) {
  const lease = LEASE[language];
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (/<passage>\n/.test(call.prompt)) return { text: `¶1 ${parking}\n<why>Done.</why>` };
    return call.results.length === 0
      ? {
          calls: [
            {
              tool: "edit_mind",
              input: {
                instruction: lease.asked,
                part: lease.part,
                ...(removesOnly !== undefined && { removes_only: removesOnly }),
              },
            },
          ],
        }
      : { text: reply };
  });
}

async function setUp(language: "en" | "zh", model: MockLanguageModelV4) {
  const lease = LEASE[language];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: lease.name });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(1, lease.name), ...lease.lines.map((line) => note(line))]);
  await client.settled();
  const answer = await askAssistant(core, { text: lease.asked, mindId: mind.id });
  await client.settled();
  return { core, mind, client, answer };
}

describe("An edit asked only to take text out that rewrites what it keeps waits (#2356)", {
  timeout: 30_000,
}, () => {
  // protects=each edit a real model wrote for "delete one sentence" that joined or reworded the sentences it kept, asked as only taking text out, waits for the User, and the model is told which of the User's sentences it would rewrite besides the one it takes out, in English and Chinese; fails_when=it applies at once, or the result doesn't name the sentences it rewrites; no_claim=what a real model writes or replies.
  test.each([
    {
      case: "English 3",
      language: "en",
      parking: "Parking: the tenant may use six underground spaces, each 800 a month.",
      told: "It does more than take out “Spaces are allocated by the landlord.”: it also rewrites the User's “Parking: the tenant may use six underground spaces.”, “Each costs 800 a month.” as 1 sentence, so it waits in “Lease terms” for them to apply or discard; nothing of their text has changed yet.",
    },
    ...["English 5", "English 6", "English 7"].map((name) => ({
      case: name,
      language: "en" as const,
      parking: "Parking: the tenant may use six underground spaces, each costing 800 a month.",
      told: "It does more than take out “Spaces are allocated by the landlord.”: it also rewrites the User's “Parking: the tenant may use six underground spaces.”, “Each costs 800 a month.” as 1 sentence, so it waits in “Lease terms” for them to apply or discard; nothing of their text has changed yet.",
    })),
    {
      case: "English 9",
      language: "en",
      parking:
        "Parking: each of six underground spaces costs 800 a month, allocated by the landlord.",
      told: "It takes none of the User's sentences out: it rewrites the User's “Parking: the tenant may use six underground spaces.”, “Each costs 800 a month.”, “Spaces are allocated by the landlord.” as 1 sentence, so it waits in “Lease terms” for them to apply or discard; nothing of their text has changed yet.",
    },
    {
      case: "Chinese 11",
      language: "zh",
      parking: "地下停车位 6 个，每车位月租 800 元，由出租方分配。",
      told: "It takes none of the User's sentences out: it rewrites the User's “停车位：承租方可使用地下停车位 6 个。”, “每个车位每月 800 元。”, “车位由出租方分配。” as 1 sentence, so it waits in “租赁条款” for them to apply or discard; nothing of their text has changed yet.",
    },
    ...["Chinese 12", "Chinese 15", "Chinese 17"].map((name) => ({
      case: name,
      language: "zh" as const,
      parking: "停车位：承租方可使用地下停车位 6 个，每个车位每月 800 元。",
      told: "It does more than take out “车位由出租方分配。”: it also rewrites the User's “停车位：承租方可使用地下停车位 6 个。”, “每个车位每月 800 元。” as 1 sentence, so it waits in “租赁条款” for them to apply or discard; nothing of their text has changed yet.",
    })),
    {
      case: "Chinese 18",
      language: "zh",
      parking: "停车位：承租方可使用地下停车位6个，每个车位每月800元。",
      told: "It does more than take out “车位由出租方分配。”: it also rewrites the User's “停车位：承租方可使用地下停车位 6 个。”, “每个车位每月 800 元。” as 1 sentence, so it waits in “租赁条款” for them to apply or discard; nothing of their text has changed yet.",
    },
  ] as const)("held out: $case", async (each) => {
    const model = removing(each.language, each.parking, "Done.", true);
    const { client, answer } = await setUp(each.language, model);

    const told = lastResult(model);
    expect(told).toContain(each.told);
    expect(told).not.toContain(APPLIES);
    const [change] = changesIn(answer);
    if (!change) throw new Error("The Answer changed no Note.");
    expect(waitsForUser(client.doc, new Set([change.request]))).toBe(true);
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)[2]).toBe(each.parking);
  });

  // protects=an edit asked only to take text out that takes out one sentence and leaves the rest word for word applies at once, and the model is told what it took out and that the rest stayed, in English and Chinese, from the middle or the end of a paragraph; fails_when=it waits, or the result doesn't say which sentence went; no_claim=what a real model writes.
  test.each([
    {
      case: "en, the middle sentence",
      language: "en",
      parking:
        "Parking: the tenant may use six underground spaces. Spaces are allocated by the landlord.",
      told: "What it does to the User's sentences there: 1 taken out whole (“Each costs 800 a month.”); 2 kept word for word.",
    },
    {
      case: "zh, the middle sentence",
      language: "zh",
      parking: "停车位：承租方可使用地下停车位 6 个。车位由出租方分配。",
      told: "What it does to the User's sentences there: 1 taken out whole (“每个车位每月 800 元。”); 2 kept word for word.",
    },
    {
      case: "en, the last sentence",
      language: "en",
      parking: "Parking: the tenant may use six underground spaces. Each costs 800 a month.",
      told: "What it does to the User's sentences there: 1 taken out whole (“Spaces are allocated by the landlord.”); 2 kept word for word.",
    },
  ] as const)("decoy, applies: $case", async (each) => {
    const model = removing(each.language, each.parking, "Done.", true);
    const { client, answer } = await setUp(each.language, model);

    const told = lastResult(model);
    expect(told).toContain(each.told);
    expect(told).toContain(APPLIES);
    const [change] = changesIn(answer);
    if (!change) throw new Error("The Answer changed no Note.");
    expect(waitsForUser(client.doc, new Set([change.request]))).toBe(false);
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)[2]).toBe(each.parking);
  });
});

describe("What an edit did to the User's sentences is said from the change, not the reply (#2356)", {
  timeout: 30_000,
}, () => {
  // protects=an edit called without removes_only applies as before, and what it did is said from the change itself wherever it is read: the model's result, the record a reply is checked against and the line it is asked again from, the Answer's card and the line over the Note say it changed the paragraph, never that a sentence went, though the reply says one was deleted; English and Chinese; fails_when=the result or record says a sentence was taken out, the card or line says removed or deleted, or the change waits; no_claim=how a real model words its reply, or how the check judges it.
  test.each([
    {
      case: "English 7, its reply saying the others stayed",
      language: "en",
      parking: "Parking: the tenant may use six underground spaces, each costing 800 a month.",
      reply:
        'Deleted "Spaces are allocated by the landlord." from the Parking paragraph in "Lease terms", leaving the other two sentences in place.',
      said: "What it does to the User's sentences there: 1 taken out whole (“Spaces are allocated by the landlord.”); 2 joined and rewritten as 1 (“Parking: the tenant may use six underground spaces.”, “Each costs 800 a month.”).",
      counts: { takenOut: 1, rewritten: 2, written: 1, kept: 0 },
      card: "Changed 1 paragraph in “Lease terms”",
      line: "Changed 1 paragraph",
    },
    {
      case: "Chinese 11, its reply saying a sentence was deleted",
      language: "zh",
      parking: "地下停车位 6 个，每车位月租 800 元，由出租方分配。",
      reply:
        "已在「租赁条款」的停车位一段删去关于车位数量的一句话；其余两句（车位费用、车位由出租方分配）保留。",
      said: "What it does to the User's sentences there: none taken out whole; 3 joined and rewritten as 1 (“停车位：承租方可使用地下停车位 6 个。”, “每个车位每月 800 元。”, “车位由出租方分配。”). None of them went.",
      counts: { takenOut: 0, rewritten: 3, written: 1, kept: 0 },
      card: "已修改“租赁条款”中的 1 段",
      line: "修改了 1 个段落",
    },
  ] as const)("$case", async (each) => {
    const model = removing(each.language, each.parking, each.reply);
    const { mind, client, answer } = await setUp(each.language, model);

    const told = lastResult(model);
    expect(told).toContain(each.said);
    expect(told).toContain(APPLIES);
    const names = (id: string) => (id === mind.id ? LEASE[each.language].name : null);
    expect(thisAnswersRecord(answer.toolCalls, names)).toContain(each.said);
    const judged: string[] = [];
    const judge = new MockLanguageModelV4({
      doGenerate: async (options) => {
        judged.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text", text: '{"claims":[]}' }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    await unbackedClaims(
      each.reply,
      answer.toolCalls,
      [{ id: mind.id, name: LEASE[each.language].name }],
      mind.id,
      { model: judge, names, signal: new AbortController().signal },
    );
    for (const [key, count] of Object.entries(each.counts)) {
      expect(judged.join("")).toContain(`\\"${key}\\": ${count}`);
    }
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(each.language === "zh" ? "zh-CN" : "en", key, params);
    const [row] = changedMinds(answer);
    if (!row) throw new Error("The Answer changed no Note.");
    expect(appliedFact(t, row, LEASE[each.language].name)).toBe(each.card);
    expect(changeFact(t, row, null)).toBe(each.line);
    const [change] = changesIn(answer);
    if (!change) throw new Error("The Answer changed no Note.");
    expect(waitsForUser(client.doc, new Set([change.request]))).toBe(false);
  });
});
