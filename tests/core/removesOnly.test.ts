import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { thisAnswersRecord, unbackedClaims } from "../../src/core/answers/claimedChanges";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { appliedFact, changeFact } from "../../src/renderer/src/changeFacts";
import { waitsForUser, whyItWaits } from "../../src/shared/askedChanges";
import { translate } from "../../src/shared/i18n";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant, changesIn, lastResult } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
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
    expect(judged.join("")).toContain(each.said);
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

type Step = { tool: string; input: Record<string, unknown>; edit?: string };

/** Every Tool result the model read in its last request, in order. */
const results = (model: MockLanguageModelV4) =>
  (model.doStreamCalls.at(-1)?.prompt ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" &&
          (part.output.type === "text" || part.output.type === "error-text")
            ? [part.output.value]
            : [],
        )
      : [],
  );

/** A scripted Answer that makes `steps` one after another, each edit_mind rewrite as its `edit` says, then replies. */
function stepping(steps: readonly Step[], reply = "Done.") {
  const edits = steps.flatMap((step) => (step.edit === undefined ? [] : [step.edit]));
  let edited = 0;
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (/<passage>\n/.test(call.prompt))
      return { text: `${edits[edited++] ?? ""}\n<why>Done.</why>` };
    const next = steps[call.results.length];
    return next ? { calls: [{ tool: next.tool, input: next.input }] } : { text: reply };
  });
}

const PARKING_OUT = {
  en: `<removed>${LEASE.en.lines[1]}</removed>`,
  zh: `<removed>${LEASE.zh.lines[1]}</removed>`,
};
const RENT_START = { en: "Rent: from 1 March", zh: "租金：自 2026 年" };
const RENT_PART = { en: "Rent: from 1 March", zh: "租金：自 2026 年 3 月 1 日起" };
const removal = (
  language: "en" | "zh",
  edit: string,
  part: string | null = LEASE[language].part,
) => ({
  tool: "edit_mind",
  input: {
    instruction: LEASE[language].asked,
    ...(part !== null && { part }),
    removes_only: true,
  },
  edit,
});

describe("A removal whose sentences another change of the reply writes again waits (#2356)", {
  timeout: 30_000,
}, () => {
  // protects=a removal asked only to take a sentence out that takes out the whole paragraph while the reply's next change writes two of its sentences back (DeepSeek, English 1 and Chinese 24 of the fourth round) waits for the User, the model told which of the User's sentences are written again; fails_when=the two changes apply at once, so the User's sentences come back as the assistant's text unasked; no_claim=what a real model writes.
  test.each([
    {
      case: "English 1",
      language: "en",
      back: "Parking: the tenant may use six underground spaces. Each costs 800 a month.",
      told: "This reply's changes there do more than take text out: they write again the User's “Parking: the tenant may use six underground spaces.”, “Each costs 800 a month.”, which they take out, so they wait in “Lease terms” for them to apply or discard; nothing of their text has changed yet.",
    },
    {
      case: "Chinese 24",
      language: "zh",
      back: "停车位：承租方可使用地下停车位 6 个。每个车位每月 800 元。",
      told: "This reply's changes there do more than take text out: they write again the User's “停车位：承租方可使用地下停车位 6 个。”, “每个车位每月 800 元。”, which they take out, so they wait in “租赁条款” for them to apply or discard; nothing of their text has changed yet.",
    },
  ] as const)(
    "held out: $case, the paragraph out and two of its sentences added back",
    async (each) => {
      const model = stepping([
        removal(each.language, PARKING_OUT[each.language]),
        {
          tool: "add_to_mind",
          input: { after: RENT_START[each.language], content: each.back },
        },
      ]);
      const { core, mind, client, answer } = await setUp(each.language, model);

      expect(lastResult(model)).toContain(each.told);
      const requests = changesIn(answer).map((change) => change.request);
      expect(requests).toHaveLength(2);
      expect(whyItWaits(client.doc, new Set(requests))?.why).toBe("more-than-taken-out");
      const applied = await core.applyAskedChanges({
        answerId: answer.id,
        mindId: mind.id,
        requests,
      });
      expect(applied?.held).toBe(true);
      await client.settled();
      expect(shownWithChanges(client)).toContain(`- ${LEASE[each.language].lines[1]}`);
    },
  );

  // protects=a removal that took the whole paragraph out, then a second asked only to take text out that writes two of its sentences back after the Rent line, reworded (DeepSeek, English 5 of the fourth round, and its Chinese mirror), waits, and the model is told they are the User's sentences written again, not new ones; fails_when=the result calls them new sentences, or the changes apply; no_claim=what a real model writes.
  test.each([
    {
      case: "English 5",
      language: "en",
      rent: `¶1 ${LEASE.en.lines[0]}\n\n¶+ Parking: each costs 800 a month. Spaces are allocated by the landlord.`,
      told: "This reply's changes there do more than take text out: they write again the User's “Each costs 800 a month.”, “Spaces are allocated by the landlord.”, which they take out, so they wait in “Lease terms” for them to apply or discard; nothing of their text has changed yet.",
    },
    {
      case: "zh, as English 5",
      language: "zh",
      rent: `¶1 ${LEASE.zh.lines[0]}\n\n¶+ 停车位：每个车位每月 800 元。车位由出租方分配。`,
      told: "This reply's changes there do more than take text out: they write again the User's “每个车位每月 800 元。”, “车位由出租方分配。”, which they take out, so they wait in “租赁条款” for them to apply or discard; nothing of their text has changed yet.",
    },
  ] as const)(
    "held out: $case, the paragraph out, then its sentences written after Rent",
    async (each) => {
      const model = stepping([
        removal(each.language, PARKING_OUT[each.language]),
        removal(each.language, each.rent, RENT_PART[each.language]),
      ]);
      const { client, answer } = await setUp(each.language, model);

      expect(lastResult(model)).toContain(each.told);
      expect(
        whyItWaits(client.doc, new Set(changesIn(answer).map((change) => change.request)))?.why,
      ).toBe("more-than-taken-out");
    },
  );

  // protects=a removal that took the whole paragraph out while the reply's next change writes one of its sentences into the Rent line itself waits, the model told which sentence is written again; English and Chinese; fails_when=words written into another paragraph aren't read, so the changes apply; no_claim=what a real model writes.
  test.each([
    {
      case: "en",
      language: "en",
      rent: `¶1 ${LEASE.en.lines[0]} Each costs 800 a month.`,
      told: "they write again the User's “Each costs 800 a month.”, which they take out, so they wait in “Lease terms”",
    },
    {
      case: "zh",
      language: "zh",
      rent: `¶1 ${LEASE.zh.lines[0]}每个车位每月 800 元。`,
      told: "they write again the User's “每个车位每月 800 元。”, which they take out, so they wait in “租赁条款”",
    },
  ] as const)(
    "$case, the paragraph out, then one of its sentences written into the Rent line",
    async (each) => {
      const model = stepping([
        removal(each.language, PARKING_OUT[each.language]),
        removal(each.language, each.rent, RENT_PART[each.language]),
      ]);
      const { client, answer } = await setUp(each.language, model);

      expect(lastResult(model)).toContain(each.told);
      expect(
        whyItWaits(client.doc, new Set(changesIn(answer).map((change) => change.request)))?.why,
      ).toBe("more-than-taken-out");
    },
  );

  // protects=after a removal that took the whole paragraph out and applies at once, a second edit over the Note is refused with the earlier change said to apply with Undo, never to wait for the User's review (DeepSeek, Chinese 23 of the fourth round, whose reply then said a change waits in Review), and the paragraph's removal applies; English and Chinese; fails_when=the refusal says a change waits for the User to accept or reject, or the removal is held; no_claim=how a real model words its reply.
  test.each([
    {
      case: "Chinese 23",
      language: "zh",
      removed: "Removed 1 paragraph (3 sentences) from “租赁条款”",
      card: "从“租赁条款”中删除了“停车位”一段（3 句）",
      line: "删除了“停车位”一段（3 句）",
    },
    {
      case: "en, as Chinese 23",
      language: "en",
      removed: "Removed 1 paragraph (3 sentences) from “Lease terms”",
      card: "Removed the paragraph “Parking” (3 sentences) from “Lease terms”",
      line: "Removed the paragraph “Parking” (3 sentences)",
    },
  ] as const)("held out: $case, a second edit after the paragraph went", async (each) => {
    const model = stepping([
      removal(each.language, PARKING_OUT[each.language]),
      removal(each.language, `¶1 ${LEASE[each.language].lines[0]}`, null),
    ]);
    const { core, mind, client, answer } = await setUp(each.language, model);

    const told = lastResult(model);
    expect(results(model)[0]).toContain(`${each.removed} (`);
    expect(results(model)[0]).toContain("It applies in the Note at once, with Undo.");
    expect(told).toContain(
      "The earlier requested changes in that text apply in the Note with Undo; they are not waiting for review.",
    );
    expect(told).not.toContain("wait there for the User");
    expect(told).not.toContain("accept or reject");
    const requests = changesIn(answer).map((change) => change.request);
    expect(requests).toHaveLength(1);
    expect(whyItWaits(client.doc, new Set(requests))).toBeNull();
    const applied = await core.applyAskedChanges({
      answerId: answer.id,
      mindId: mind.id,
      requests,
    });
    expect(applied?.held).toBe(false);
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(each.language === "zh" ? "zh-CN" : "en", key, params);
    const [row] = changedMinds(answer);
    if (!row) throw new Error("The Answer changed no Note.");
    expect(appliedFact(t, row, LEASE[each.language].name)).toBe(each.card);
    expect(changeFact(t, row, null)).toBe(each.line);
    await client.settled();
    expect(shownWithChanges(client)).toEqual([
      LEASE[each.language].name,
      LEASE[each.language].lines[0],
      LEASE[each.language].lines[2],
      LEASE[each.language].lines[3],
    ]);
  });
});

describe("A held removal, once applied, reads as proposed (#2356)", { timeout: 30_000 }, () => {
  // protects=a held removal that also rewords a kept sentence stays waiting when the app applies the reply's changes, and once the User applies it the paragraph reads exactly as proposed, the struck words gone and the written ones in (DeepSeek, English 10 and Chinese 40 of the fourth round, whose text read with the struck and written words together looked like "Eacheach"); fails_when=applying it leaves the struck words, doubles a word, or changes nothing; no_claim=what a real model writes.
  test.each([
    {
      case: "English 10",
      language: "en",
      parking: "Parking: each costs 800 a month. Spaces are allocated by the landlord.",
    },
    {
      case: "Chinese 40",
      language: "zh",
      parking: "停车位：每个车位每月 800 元。车位由出租方分配。",
    },
  ] as const)("$case", async (each) => {
    const model = stepping([removal(each.language, `¶1 ${each.parking}`)]);
    const { core, mind, client, answer } = await setUp(each.language, model);

    const requests = changesIn(answer).map((change) => change.request);
    const applied = await core.applyAskedChanges({
      answerId: answer.id,
      mindId: mind.id,
      requests,
    });
    expect(applied?.held).toBe(true);
    await client.settled();
    expect(shownWithChanges(client)[2]).not.toBe(LEASE[each.language].lines[1]);
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)[2]).toBe(each.parking);
  });
});

const BACK = {
  en: "Parking: the tenant may use six underground spaces. Each costs 800 a month.",
  zh: "停车位：承租方可使用地下停车位 6 个。每个车位每月 800 元。",
};

/** Accepts or rejects the Proposals of one request, as Review does. */
async function decide(client: MindClient, request: string, outcome: "accept" | "reject") {
  const ids = new Set(
    pendingProposals(client.blocks)
      .filter((proposal) => proposal.request === request)
      .map((proposal) => proposal.id),
  );
  await resolveChanges(client, outcome, (id) => ids.has(id));
}

describe("A whole paragraph out and two of its sentences written back, decided by the User (#2356)", {
  timeout: 30_000,
}, () => {
  // protects=the two changes of the rerun's third Chinese run (DeepSeek, on 986c05f0a: the Parking paragraph removed whole, then its first two sentences added back after Rent), held together, read as the User decides them: both accepted, in either order, leave the two kept sentences once; the removal alone leaves no Parking paragraph; the write-back alone keeps the User's paragraph beside the copy, nothing lost; and Undo of each decision gives back the Note as it waited; English and Chinese; fails_when=accepting both leaves the User's paragraph or two copies, one decision loses text, or Undo doesn't restore; no_claim=how a probe reads held Proposals as text.
  test.each([
    { language: "en", order: "removal first" },
    { language: "en", order: "write-back first" },
    { language: "en", order: "removal only" },
    { language: "en", order: "write-back only" },
    { language: "zh", order: "removal first" },
    { language: "zh", order: "write-back first" },
    { language: "zh", order: "removal only" },
    { language: "zh", order: "write-back only" },
  ] as const)("$language, $order", async ({ language, order }) => {
    const model = stepping([
      removal(language, PARKING_OUT[language]),
      { tool: "add_to_mind", input: { after: RENT_START[language], content: BACK[language] } },
    ]);
    const { core, mind, client, answer } = await setUp(language, model);
    const [removing, writing] = changesIn(answer).map((change) => change.request);
    if (!removing || !writing) throw new Error("The Answer made two changes.");
    const applied = await core.applyAskedChanges({
      answerId: answer.id,
      mindId: mind.id,
      requests: [removing, writing],
    });
    expect(applied?.held).toBe(true);
    await client.settled();
    const lease = LEASE[language];
    const waiting = shownWithChanges(client);
    expect(waiting).toEqual([
      lease.name,
      lease.lines[0],
      `+ ${BACK[language]}`,
      `- ${lease.lines[1]}`,
      lease.lines[2],
      lease.lines[3],
    ]);
    const undo = new Y.UndoManager(client.blocks, {
      trackedOrigins: new Set(["editor"]),
      captureTimeout: 0,
    });

    const steps: [string, "accept" | "reject"][] =
      order === "removal first"
        ? [
            [removing, "accept"],
            [writing, "accept"],
          ]
        : order === "write-back first"
          ? [
              [writing, "accept"],
              [removing, "accept"],
            ]
          : order === "removal only"
            ? [
                [removing, "accept"],
                [writing, "reject"],
              ]
            : [
                [removing, "reject"],
                [writing, "accept"],
              ];
    for (const [request, outcome] of steps) await decide(client, request, outcome);

    const expected =
      order === "removal only"
        ? [lease.name, lease.lines[0], lease.lines[2], lease.lines[3]]
        : order === "write-back only"
          ? [
              lease.name,
              lease.lines[0],
              BACK[language],
              lease.lines[1],
              lease.lines[2],
              lease.lines[3],
            ]
          : [lease.name, lease.lines[0], BACK[language], lease.lines[2], lease.lines[3]];
    expect(shownWithChanges(client)).toEqual(expected);
    undo.undo();
    undo.undo();
    await client.settled();
    expect(shownWithChanges(client)).toEqual(waiting);
  });

  // protects=when a later change holds the reply's changes together, the model reads plainly that nothing applied and that all of them wait, the earlier one too, so it can't say the paragraph is gone while it waits (the rerun's third Chinese run said "目前 Note 里那段仍是空的"); English and Chinese; fails_when=the result doesn't say what applied and what waits; no_claim=how a real model words its reply.
  test.each([
    { language: "en", name: "Lease terms" },
    { language: "zh", name: "租赁条款" },
  ] as const)(
    "$language, the model told what applied and what waits",
    async ({ language, name }) => {
      const model = stepping([
        removal(language, PARKING_OUT[language]),
        { tool: "add_to_mind", input: { after: RENT_START[language], content: BACK[language] } },
      ]);
      await setUp(language, model);

      expect(lastResult(model)).toContain(
        `Applied now: nothing in “${name}”. Waiting for the User: all 2 of this reply's changes there, the earlier ones too.`,
      );
    },
  );

  // protects=a removal of the whole paragraph that the reply then revises in place into its two kept sentences, its own waiting text replaced, is one clean removal: it applies, the model is told so, and the Note keeps the two sentences once; English and Chinese; fails_when=the revised-away removal still holds the change, or the model is told it "writes 0 new sentences"; no_claim=what a real model writes.
  test.each([{ language: "en" }, { language: "zh" }] as const)(
    "$language, the removal revised in place into the kept sentences",
    async ({ language }) => {
      const model = stepping([
        removal(language, PARKING_OUT[language]),
        {
          tool: "edit_mind",
          input: { part: LEASE[language].part, content: BACK[language], removes_only: true },
        },
      ]);
      const { core, mind, client, answer } = await setUp(language, model);

      const told = lastResult(model);
      expect(told).toContain("It applies in the Note at once");
      expect(told).not.toContain("new sentences");
      const requests = changesIn(answer).map((change) => change.request);
      expect(whyItWaits(client.doc, new Set(requests))).toBeNull();
      const applied = await core.applyAskedChanges({
        answerId: answer.id,
        mindId: mind.id,
        requests,
      });
      expect(applied?.held).toBe(false);
      await client.settled();
      const lease = LEASE[language];
      expect(shownWithChanges(client)).toEqual([
        lease.name,
        lease.lines[0],
        BACK[language],
        lease.lines[2],
        lease.lines[3],
      ]);
    },
  );
});

const JOINED = {
  en: "Parking: the tenant may use six underground spaces, each costing 800 a month.",
  zh: "停车位：承租方可使用地下停车位 6 个，每个车位每月 800 元。",
};

describe("A held removal stays the User's to decide (#2356)", { timeout: 30_000 }, () => {
  // protects=a removal asked only to take text out that the reply then revises in place, with content, into a rewrite that joins the kept sentences waits like the same rewrite in one edit, whatever the revision's own removes_only says, while a clean revision applies (above); English and Chinese; fails_when=the revision applies at once because the removal it replaced is no longer judged; no_claim=what a real model writes.
  test.each([
    { language: "en", flag: true },
    { language: "en", flag: undefined },
    { language: "zh", flag: false },
    { language: "zh", flag: undefined },
  ] as const)(
    "$language, a removal revised into a join, its own flag $flag",
    async ({ language, flag }) => {
      const model = stepping([
        removal(language, PARKING_OUT[language]),
        {
          tool: "edit_mind",
          input: {
            part: LEASE[language].part,
            content: JOINED[language],
            ...(flag !== undefined && { removes_only: flag }),
          },
        },
      ]);
      const { core, mind, client, answer } = await setUp(language, model);

      const requests = changesIn(answer).map((change) => change.request);
      expect(whyItWaits(client.doc, new Set(requests))?.why).toBe("more-than-taken-out");
      const applied = await core.applyAskedChanges({
        answerId: answer.id,
        mindId: mind.id,
        requests,
      });
      expect(applied?.held).toBe(true);
      expect(lastResult(model)).not.toContain("It applies in the Note at once");
    },
  );

  // protects=once the User accepts or rejects one change of a held pair (the paragraph out, two of its sentences written back), applying the reply's changes again, as the window does when the Note opens, leaves the other waiting and the Note as the User left it; English and Chinese, each change, each decision; fails_when=the other change applies without the User, giving the User's paragraph beside the copy, or losing it all; no_claim=two windows deciding at once.
  test.each([
    { language: "en", decided: "removal", outcome: "reject" },
    { language: "en", decided: "write-back", outcome: "reject" },
    { language: "en", decided: "removal", outcome: "accept" },
    { language: "en", decided: "write-back", outcome: "accept" },
    { language: "zh", decided: "removal", outcome: "reject" },
    { language: "zh", decided: "write-back", outcome: "reject" },
    { language: "zh", decided: "removal", outcome: "accept" },
    { language: "zh", decided: "write-back", outcome: "accept" },
  ] as const)(
    "$language, the $decided decided ($outcome), then the changes applied again",
    async ({ language, decided, outcome }) => {
      const model = stepping([
        removal(language, PARKING_OUT[language]),
        { tool: "add_to_mind", input: { after: RENT_START[language], content: BACK[language] } },
      ]);
      const { core, mind, client, answer } = await setUp(language, model);
      const [removing, writing] = changesIn(answer).map((change) => change.request);
      if (!removing || !writing) throw new Error("The Answer made two changes.");
      const input = { answerId: answer.id, mindId: mind.id, requests: [removing, writing] };
      expect((await core.applyAskedChanges(input))?.held).toBe(true);
      await client.settled();

      await decide(client, decided === "removal" ? removing : writing, outcome);
      const left = shownWithChanges(client);
      const again = await core.applyAskedChanges(input);
      await client.settled();

      expect(again?.held).toBe(true);
      expect(shownWithChanges(client)).toEqual(left);
      const other = decided === "removal" ? writing : removing;
      expect(pendingProposals(client.blocks).some((proposal) => proposal.request === other)).toBe(
        true,
      );
    },
  );
});

describe("A cut the reply revises by instruction is held to the cut (#2356)", {
  timeout: 30_000,
}, () => {
  // protects=a removal asked only to take one sentence out, then revised by an instruction into a rewrite that joins the two kept sentences, its own removes_only false, waits as the same rewrite would from one edit; English and Chinese; fails_when=the revision applies at once because its request isn't held to the cut it revises; no_claim=what a real model writes.
  test.each([
    {
      language: "en",
      cut: "¶1 Parking: the tenant may use six underground spaces. Each costs 800 a month.",
    },
    {
      language: "zh",
      cut: "¶1 停车位：承租方可使用地下停车位 6 个。每个车位每月 800 元。",
    },
  ] as const)(
    "$language, the last sentence cut, then the paragraph rewritten into a join",
    async ({ language, cut }) => {
      const model = stepping([
        removal(language, cut),
        {
          tool: "edit_mind",
          input: {
            part: LEASE[language].part,
            instruction: LEASE[language].asked,
            removes_only: false,
          },
          edit: `¶1 ${JOINED[language]}`,
        },
      ]);
      const { core, mind, client, answer } = await setUp(language, model);

      const requests = changesIn(answer).map((change) => change.request);
      expect(requests).toHaveLength(2);
      expect(whyItWaits(client.doc, new Set(requests))?.why).toBe("more-than-taken-out");
      const applied = await core.applyAskedChanges({
        answerId: answer.id,
        mindId: mind.id,
        requests,
      });
      expect(applied?.held).toBe(true);
    },
  );
});

const PROSE = {
  en: 'The text you asked to delete ("Spaces are allocated by the landlord.") does not appear in the passage, so I can\'t remove it. There is nothing to change.',
  zh: 'The text you asked to delete ("车位由出租方分配。") does not appear in the passage, so I can\'t remove it. There is nothing to change.',
};
const CUT = {
  en: "¶1 Parking: the tenant may use six underground spaces. Each costs 800 a month.",
  zh: "¶1 停车位：承租方可使用地下停车位 6 个。每个车位每月 800 元。",
};

describe("A removal's rewrite that answers in words of its own is never written (#2356)", {
  timeout: 30_000,
}, () => {
  // protects=the closing round's Chinese 30 (DeepSeek, on 3e71eab81) and its English twin: a cut of the last sentence, then an edit asked only to take text out that revises it, whose rewrite answers in one unnamed line of its own that the sentence isn't there; the line is set aside, never written, the model told what the rewrite said, and the cut applies alone; fails_when=the line takes the paragraph's place, waiting or applied, so the Note holds the rewrite's own words; no_claim=what a real model writes.
  test.each([{ language: "zh" }, { language: "en" }] as const)(
    "$language, as Chinese 30",
    async ({ language }) => {
      const model = stepping([
        removal(language, CUT[language]),
        {
          tool: "edit_mind",
          input: {
            part: LEASE[language].part,
            instruction: LEASE[language].asked,
            removes_only: true,
          },
          edit: PROSE[language],
        },
      ]);
      const { core, mind, client, answer } = await setUp(language, model);

      expect(lastResult(model)).toContain(
        `the rewrite answered in words of its own instead of new text, and they were not written: “${PROSE[language]}”`,
      );
      const requests = changesIn(answer).map((change) => change.request);
      expect(requests).toHaveLength(1);
      expect(whyItWaits(client.doc, new Set(requests))).toBeNull();
      const applied = await core.applyAskedChanges({
        answerId: answer.id,
        mindId: mind.id,
        requests,
      });
      expect(applied?.held).toBe(false);
      await client.settled();
      const lease = LEASE[language];
      expect(shownWithChanges(client)).toEqual([
        lease.name,
        lease.lines[0],
        CUT[language].slice(3),
        lease.lines[2],
        lease.lines[3],
      ]);
    },
  );

  // protects=outside a removal, the same unnamed line still takes the paragraph's place as on main, so this change narrows nothing else (the wider case is its own issue); fails_when=a request not asked only to take text out sets the line aside; no_claim=whether that is right.
  test.each([{ language: "zh" }, { language: "en" }] as const)(
    "$language, not asked only to take text out, as on main",
    async ({ language }) => {
      const lease = LEASE[language];
      const asked = { part: lease.part, instruction: lease.asked, removes_only: false };
      const model = stepping([
        { tool: "edit_mind", input: asked, edit: CUT[language] },
        { tool: "edit_mind", input: asked, edit: PROSE[language] },
      ]);
      const { core, mind, client, answer } = await setUp(language, model);

      const requests = changesIn(answer).map((change) => change.request);
      await core.applyAskedChanges({ answerId: answer.id, mindId: mind.id, requests });
      await client.settled();
      expect(shownWithChanges(client)[2]).toBe(PROSE[language]);
    },
  );

  // protects=a rewrite in other words that isn't a removal still applies, whether the rewriting model is shown the paragraphs' names (the assistant's edit) or not (Edit with AI's Translate, Improve writing and Shorten on one paragraph): translating English to Chinese and back, improving writing that rewrites most words, shortening one paragraph; fails_when=any of them is set aside as the model's own words; no_claim=what a real model writes.
  test.each([
    {
      case: "translate en to zh",
      language: "en",
      instruction: "Translate this paragraph into Chinese.",
      action: "translate",
      target: "简体中文",
      rewrite: "停车位：承租方可使用六个地下车位。每个车位每月 800 元。车位由房东分配。",
    },
    {
      case: "translate zh to en",
      language: "zh",
      instruction: "把这一段翻译成英文。",
      action: "translate",
      target: "English",
      rewrite:
        "Parking: the tenant may use six underground spaces. Each costs 800 a month. The landlord assigns them.",
    },
    {
      case: "improve, most words rewritten",
      language: "en",
      instruction: "Improve the writing of this paragraph.",
      action: "improve",
      target: undefined,
      rewrite:
        "Parking: six underground bays are available to the tenant, at 800 each per month, assigned by the landlord.",
    },
    {
      case: "shorten one paragraph",
      language: "en",
      instruction: "Make this paragraph shorter.",
      action: "shorten",
      target: undefined,
      rewrite: "Parking: six spaces, 800 each a month.",
    },
  ] as const)("$case still applies, with names and without", async (each) => {
    const lease = LEASE[each.language];
    const named = stepping([
      {
        tool: "edit_mind",
        input: { part: lease.part, instruction: each.instruction, removes_only: false },
        edit: each.rewrite,
      },
    ]);
    const assisted = await setUp(each.language, named);
    expect(lastResult(named)).toContain("It applies in the Note at once");
    const requests = changesIn(assisted.answer).map((change) => change.request);
    await assisted.core.applyAskedChanges({
      answerId: assisted.answer.id,
      mindId: assisted.mind.id,
      requests,
    });
    await assisted.client.settled();
    expect(shownWithChanges(assisted.client)[2]).toBe(each.rewrite);

    const plainModel = scriptedModel(
      (call: ModelCall): ScriptedReply =>
        /<passage>\n/.test(call.prompt)
          ? { text: `${each.rewrite}\n<why>Done.</why>` }
          : { text: "OK." },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(plainModel).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: lease.name });
    const client = await connectToMind(core, mind.id);
    const parking = note(lease.lines[1]);
    writeMind(client, [
      heading(1, lease.name),
      note(lease.lines[0]),
      parking,
      note(lease.lines[2]),
    ]);
    await client.settled();
    const blockId = parking.attrs?.id as string;
    const edited = await core.editWithAi({
      requestId: `edit-${each.action}`,
      mindId: mind.id,
      from: { blockId, offset: 0 },
      to: { blockId, offset: lease.lines[1].length },
      text: lease.lines[1],
      action: each.action,
      ...(each.target && { instruction: each.target }),
    });
    expect(edited).toMatchObject({ kind: "proposed" });
  });
});

describe("A revision the assistant says is asked only to take text out is held to it (#2356)", {
  timeout: 30_000,
}, () => {
  // protects=a cut made without removes_only, then revised into a join by a call that says the User asked only for text to go, waits, by content or by instruction, English and Chinese: the revising call's own flag counts as the removal's would; fails_when=the revision applies at once because the cut it revises had no flag; no_claim=what a real model writes.
  test.each([
    { language: "en", by: "content" },
    { language: "en", by: "instruction" },
    { language: "zh", by: "content" },
    { language: "zh", by: "instruction" },
  ] as const)(
    "$language, an unflagged cut revised by $by with its own flag",
    async ({ language, by }) => {
      const lease = LEASE[language];
      const model = stepping([
        {
          tool: "edit_mind",
          input: { part: lease.part, instruction: lease.asked },
          edit: CUT[language],
        },
        by === "content"
          ? {
              tool: "edit_mind",
              input: { part: lease.part, content: JOINED[language], removes_only: true },
            }
          : {
              tool: "edit_mind",
              input: { part: lease.part, instruction: lease.asked, removes_only: true },
              edit: `¶1 ${JOINED[language]}`,
            },
      ]);
      const { core, mind, client, answer } = await setUp(language, model);

      const requests = changesIn(answer).map((change) => change.request);
      expect(requests).toHaveLength(2);
      expect(whyItWaits(client.doc, new Set(requests))?.why).toBe("more-than-taken-out");
      const applied = await core.applyAskedChanges({
        answerId: answer.id,
        mindId: mind.id,
        requests,
      });
      expect(applied?.held).toBe(true);
    },
  );
});

/** A Note of `lines`, the request `asked` put to the assistant answered by `model`. */
async function askOn(
  model: MockLanguageModelV4,
  name: string,
  lines: readonly string[],
  asked: string,
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: name });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(1, name), ...lines.map((line) => note(line))]);
  await client.settled();
  const answer = await askAssistant(core, { text: asked, mindId: mind.id });
  await client.settled();
  return { core, mind, client, answer };
}

const SET_ASIDE = "the rewrite answered in words of its own instead of new text";

describe("Only an edit asked only to take text out sets a reply aside, never a real cut (#2356)", {
  timeout: 30_000,
}, () => {
  // protects=a real cut, its reply unnamed and asked only to take text out, applies: the second sentence out, only the first kept, a word out of a 3-word paragraph, a short Chinese cut, one figure out of a line of figures, in English and Chinese where they have twins; fails_when=a reply made of the paragraph's own words is set aside as the model's talk; no_claim=what a real model writes.
  test.each([
    {
      case: "en, the second sentence out",
      name: "Lease terms",
      line: LEASE.en.lines[1],
      part: LEASE.en.part,
      cut: "Parking: the tenant may use six underground spaces. Spaces are allocated by the landlord.",
    },
    {
      case: "zh, the second sentence out",
      name: "租赁条款",
      line: LEASE.zh.lines[1],
      part: LEASE.zh.part,
      cut: "停车位：承租方可使用地下停车位 6 个。车位由出租方分配。",
    },
    {
      case: "en, only the first sentence kept",
      name: "Lease terms",
      line: LEASE.en.lines[1],
      part: LEASE.en.part,
      cut: "Parking: the tenant may use six underground spaces.",
    },
    {
      case: "zh, only the first sentence kept",
      name: "租赁条款",
      line: LEASE.zh.lines[1],
      part: LEASE.zh.part,
      cut: "停车位：承租方可使用地下停车位 6 个。",
    },
    {
      case: "en, a word out of three",
      name: "Lease terms",
      line: "Parking is free.",
      part: "Parking is free",
      cut: "Parking is.",
    },
    {
      case: "zh, a short cut",
      name: "租赁条款",
      line: "地下停车场免费。",
      part: "地下停车场免费",
      cut: "地下停车场。",
    },
    {
      case: "en, one figure out",
      name: "Lease terms",
      line: "Rent by year: 2025: 1,200. 2026: 1,300. 2027: 1,400.",
      part: "Rent by year",
      cut: "Rent by year: 2025: 1,200. 2027: 1,400.",
    },
  ])("$case", async (each) => {
    const kept = each.name === "租赁条款" ? "押金：三个月租金，由出租方保管。" : LEASE.en.lines[2];
    const model = stepping([
      {
        tool: "edit_mind",
        input: { part: each.part, instruction: "Delete part of it.", removes_only: true },
        edit: each.cut,
      },
    ]);
    const { core, mind, client, answer } = await askOn(
      model,
      each.name,
      [each.line, kept],
      "Delete part of it.",
    );

    const told = lastResult(model);
    expect(told).not.toContain(SET_ASIDE);
    expect(told).toContain("It applies in the Note at once");
    const requests = changesIn(answer).map((change) => change.request);
    expect(requests).toHaveLength(1);
    await core.applyAskedChanges({ answerId: answer.id, mindId: mind.id, requests });
    await client.settled();
    expect(shownWithChanges(client)).toEqual([each.name, each.cut, kept]);
  });

  // protects=a first edit asked only to take text out whose rewrite answers in a line of its own is set aside: nothing is written or held, and the model is told what the rewrite said; English and Chinese; fails_when=the line is written as the paragraph, even waiting; no_claim=what a real model writes.
  test.each([{ language: "en" }, { language: "zh" }] as const)(
    "$language, a first call's talk",
    async ({ language }) => {
      const model = stepping([
        {
          tool: "edit_mind",
          input: {
            part: LEASE[language].part,
            instruction: LEASE[language].asked,
            removes_only: true,
          },
          edit: PROSE[language],
        },
      ]);
      const { client, answer } = await setUp(language, model);

      expect(lastResult(model)).toContain(
        `${SET_ASIDE}, and they were not written: “${PROSE[language]}”`,
      );
      expect(changesIn(answer)).toHaveLength(0);
      expect(shownWithChanges(client)).toEqual([LEASE[language].name, ...LEASE[language].lines]);
    },
  );

  // protects=after a cut, a later edit on the same paragraph not asked only to take text out ("Make the rest formal.") writes its real rewrite, unnamed, never set aside as talk, and waits with the cut it revises; English and Chinese; fails_when=an inherited flag sets a real rewrite aside and the model is told the rewrite answered in words of its own; no_claim=what a real model writes.
  test.each([
    {
      language: "en",
      formal:
        "Parking: subterranean bays are available to the lessee at a monthly charge of 800 apiece.",
    },
    { language: "zh", formal: "泊位：承租人享有地库泊位，月费每处 800 元。" },
  ] as const)("$language, a cut, then the rest made formal", async ({ language, formal }) => {
    const lease = LEASE[language];
    const model = stepping([
      removal(language, CUT[language]),
      {
        tool: "edit_mind",
        input: { part: lease.part, instruction: "Make the rest formal.", removes_only: false },
        edit: formal,
      },
    ]);
    const { client, answer } = await setUp(language, model);

    expect(lastResult(model)).not.toContain(SET_ASIDE);
    expect(changesIn(answer)).toHaveLength(2);
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)[2]).toBe(formal);
  });
});
