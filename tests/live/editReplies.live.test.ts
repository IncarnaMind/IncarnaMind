/**
 * What the reply and its status line say an edit did, against real models (#2180): the
 * assistant writes a memo into an empty Note, its changes apply as the window applies them, and
 * a follow-up in the same conversation lengthens it, shortens a paragraph, deletes a sentence or
 * deletes a list item. Counts the runs where the Note changed but the Answer is marked as not
 * having made every change it describes (its status line), and keeps each such reply, and each
 * reply that says the change waits or wasn't made, with what the check of its claims was told.
 * A question the assistant asks the User (`ask_user`, such as which sentence to delete) is answered
 * as a User would, with the option it recommends (#2322).
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each follow-up runs (3 by default),
 * INCARNAMIND_LIVE_ASK keeps only the follow-ups that contain one of these words (split by |),
 * INCARNAMIND_LIVE_CONCURRENCY how many run at once (3); set INCARNAMIND_LIVE_REPORT to a file
 * to keep the numbers, each run's as it ends. With INCARNAMIND_LIVE_WRITTEN=1 the memo is put in
 * the Note as AI text, as an applied memo leaves it, and the follow-up starts a conversation.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind, ConversationAnswer, Core } from "../../src/core";
import { GENERATED_MARK } from "../../src/core/api";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const LIVE: { name: string; kind: ChatProviderKind; apiKey: string | undefined; model: string }[] =
  [
    {
      name: "Anthropic",
      kind: "anthropic",
      apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
      model:
        process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
        (catalogProvider("anthropic")?.roles.quickTasks as string),
    },
  ];

interface FollowUp {
  ask: string;
  /** Whether the Note, before and after, shows the change was made. */
  made: (before: string[], after: string[]) => boolean;
}

const chars = (texts: string[]) => texts.join("").length;
const including = (texts: string[], words: string) => texts.find((text) => text.includes(words));
const sentences = (text: string | undefined) =>
  (text ?? "").split(/(?<=[.!?。！？])\s*/u).filter((each) => each.trim() !== "").length;

const LANGUAGES: { language: string; memo: string; followUps: FollowUp[] }[] = [
  {
    language: "English",
    memo: [
      "Write this memo into the empty Note in front, word for word:",
      "## Lease terms",
      "Rent: from 1 March 2026 the monthly rent is 98,000, paid by the 5th of each month. It is reviewed every two years.",
      "Parking: the tenant may use six underground spaces. Each costs 800 a month. Spaces are allocated by the landlord.",
      "- Deposit: three months' rent, held by the landlord.",
      "- Signing: the supplement was signed on 20 January 2026.",
    ].join("\n"),
    followUps: [
      { ask: "Make it longer.", made: (before, after) => chars(after) > chars(before) },
      {
        ask: "Make the Rent paragraph shorter.",
        made: (before, after) =>
          (including(after, "Rent")?.length ?? 0) < (including(before, "Rent")?.length ?? 0),
      },
      {
        ask: "Delete one sentence from the Parking paragraph.",
        made: (before, after) =>
          sentences(including(after, "Parking")) === sentences(including(before, "Parking")) - 1,
      },
      {
        ask: "Delete the deposit item, leave the rest.",
        made: (_before, after) => !after.some((text) => text.includes("Deposit")),
      },
      {
        ask: "Take one sentence out of the parking paragraph.",
        made: (before, after) =>
          sentences(including(after, "Parking")) === sentences(including(before, "Parking")) - 1,
      },
    ],
  },
  {
    language: "Chinese",
    memo: [
      "把下面这份备忘录原样写进前面这篇空白笔记：",
      "## 租赁条款",
      "租金：自 2026 年 3 月 1 日起，月租金为九万八千元，每月 5 日前支付。租金每两年调整一次。",
      "停车位：承租方可使用地下停车位 6 个。每个车位每月 800 元。车位由出租方分配。",
      "- 押金：三个月租金，由出租方保管。",
      "- 签署：补充协议于 2026 年 1 月 20 日签署。",
    ].join("\n"),
    followUps: [
      { ask: "把它写长一点。", made: (before, after) => chars(after) > chars(before) },
      {
        ask: "把租金那一段缩短。",
        made: (before, after) =>
          (including(after, "租金")?.length ?? 0) < (including(before, "租金")?.length ?? 0),
      },
      {
        ask: "从停车位那一段删掉一句话。",
        made: (before, after) =>
          sentences(including(after, "停车")) === sentences(including(before, "停车")) - 1,
      },
      {
        ask: "把押金那一条删掉，其他不变。",
        made: (_before, after) => !after.some((text) => text.includes("押金")),
      },
      {
        ask: "停车位那段去掉一句。",
        made: (before, after) =>
          sentences(including(after, "停车")) === sentences(including(before, "停车")) - 1,
      },
    ],
  },
];

/** The memo's lines as AI text, as the assistant leaves it once applied: a heading, paragraphs, a list. */
function memoBlocks(memo: string): JSONContent[] {
  const ai = (text: string): JSONContent[] => [
    { type: "text", text, marks: [{ type: GENERATED_MARK }] },
  ];
  const items: JSONContent[] = [];
  const blocks: JSONContent[] = [];
  const id = () => ({ id: randomUUID() });
  for (const line of memo.split("\n").slice(1)) {
    if (line.startsWith("## ")) {
      blocks.push({ type: "heading", attrs: { ...id(), level: 2 }, content: ai(line.slice(3)) });
    } else if (line.startsWith("- ")) {
      if (items.length === 0) blocks.push({ type: "bulletList", attrs: id(), content: items });
      items.push({
        type: "listItem",
        attrs: id(),
        content: [{ type: "paragraph", attrs: id(), content: ai(line.slice(2)) }],
      });
    } else blocks.push({ type: "paragraph", attrs: id(), content: ai(line) });
  }
  return blocks;
}

/** A reply that says the change waits or wasn't made. */
const DENIES =
  /\bwait|pending|not yet|haven't|hasn't|wasn't|didn't|couldn't|还没|尚未|待你|等待|确认后|没有(?:被)?(?:删|改)/i;

/** Asks in `conversationId` (a new one when none) beside `mindId`, and gives the Answer once it has ended. */
async function ask(core: Core, text: string, mindId: string, conversationId?: string) {
  const result = await core.askInConversation({
    text,
    mindId,
    ...(conversationId && { conversationId }),
    scope: { folderIds: [], tagIds: [], documentIds: [] },
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  const ended = await new Promise<boolean>((resolve) => {
    // An Answer that never ends is counted as such, so it doesn't hold up the other runs.
    const timer = setTimeout(() => done(false), 480_000);
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done(true)),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done(true)),
    ];
    function done(finished: boolean) {
      clearTimeout(timer);
      for (const stop of stops) stop();
      resolve(finished);
    }
  });
  if (!ended) throw new Error(`No end to the Answer of “${text}” in 8 minutes.`);
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer, conversationId: result.conversation.id };
}

/** Applies an Answer's changes in a Mind as the window does. */
async function apply(core: Core, answer: ConversationAnswer, mindId: string) {
  const requests = answer.toolCalls.flatMap((call) =>
    call.mindChange?.mindId === mindId ? [call.mindChange.request] : [],
  );
  if (requests.length === 0) return;
  await core.applyAskedChanges({ answerId: answer.id, mindId, requests });
}

describe.each(LIVE)("What the reply says an edit did, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: an edit that was made is told as made, and its status line agrees`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 3);
      const report: string[] = [`## ${live.name} · ${live.model} (#2180, edit replies)`];
      const judged = new AsyncLocalStorage<{ record: string[] }>();
      const core = startCore(await createTempDataFolder(), {
        createChatModel: (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              wrapGenerate: async ({ doGenerate, params }) => {
                const prompt = JSON.stringify(params.prompt);
                if (prompt.includes("You check an AI assistant")) {
                  judged.getStore()?.record.push(prompt.slice(prompt.indexOf("<tool-record>")));
                }
                return doGenerate();
              },
            },
          }),
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      // A call that asks the User first (a command) is declined, as the probe has no User to ask.
      let approvals = 0;
      let unended = 0;
      core.on("approval.requested", (request) => {
        approvals++;
        void core.respondToApproval(request.requestId, "deny");
      });
      // Unanswered, a question waits for the User as it should, and the run would never end (#2322).
      let questions = 0;
      core.on("question.asked", (asked) => {
        questions++;
        const [recommended] = asked.question.options;
        void core.answerUserQuestion(asked.requestId, {
          skipped: false,
          chosen: recommended ? [recommended.label] : [],
          wrote: null,
        });
      });
      await core.saveChatProvider({
        kind: live.kind,
        ...(live.apiKey && { apiKey: live.apiKey }),
        modelId: live.model,
      });
      const only = process.env.INCARNAMIND_LIVE_ASK?.split("|") ?? null;
      const jobs = LANGUAGES.flatMap((each) =>
        each.followUps
          .filter((followUp) => !only || only.some((words) => followUp.ask.includes(words)))
          .flatMap((followUp) => Array.from({ length: runs }, () => ({ each, followUp }))),
      );
      const tally = new Map<FollowUp, { made: number; flagged: number; denied: number }>();
      const kept: string[] = [];
      let next = 0;
      const one = async () => {
        while (next < jobs.length) {
          const index = next++;
          const { each, followUp } = jobs[index] as (typeof jobs)[number];
          await judged.run({ record: [] }, async () => {
            try {
              const mind = await core.createMind({ title: `${each.language} ${index + 1}` });
              const client = await connectToMind(core, mind.id);
              await client.settled();
              const written = process.env.INCARNAMIND_LIVE_WRITTEN === "1";
              let conversationId: string | undefined;
              if (written) writeMind(client, memoBlocks(each.memo));
              else {
                const first = await ask(core, each.memo, mind.id);
                await apply(core, first.answer, mind.id);
                conversationId = first.conversationId;
              }
              await client.settled();
              const textsOf = () => {
                const texts: string[] = [];
                readMind(client).descendants((node) => {
                  if (!node.isTextblock) return true;
                  const plain = node.textBetween(0, node.content.size, "", "￼");
                  if (plain.trim() !== "") texts.push(plain);
                  return false;
                });
                return texts;
              };
              const before = textsOf();
              judged.getStore()?.record.splice(0);
              const second = await ask(core, followUp.ask, mind.id, conversationId);
              await apply(core, second.answer, mind.id);
              await client.settled();
              const after = textsOf();
              const made = followUp.made(before, after);
              const flagged = (second.answer.steps?.unbackedClaims ?? []).length > 0;
              const denied = DENIES.test(second.answer.text);
              const counts = tally.get(followUp) ?? { made: 0, flagged: 0, denied: 0 };
              if (made) counts.made++;
              if (made && flagged) counts.flagged++;
              if (made && denied) counts.denied++;
              tally.set(followUp, counts);
              if (process.env.INCARNAMIND_LIVE_REPORT) {
                await appendFile(
                  process.env.INCARNAMIND_LIVE_REPORT,
                  `run ${each.language} “${followUp.ask}”: made ${made}, status says not all done ${flagged}, reply says waits or not made ${denied}: ${JSON.stringify(second.answer.text).slice(0, 300)}\n`,
                );
              }
              if (made && (flagged || denied)) {
                kept.push(
                  `- ${each.language} “${followUp.ask}”: ${flagged ? "status says not all done; " : ""}${denied ? "reply says waits or not made; " : ""}reply: ${JSON.stringify(second.answer.text)}`,
                  `  record: ${JSON.stringify(judged.getStore()?.record.at(-1) ?? "").slice(0, 1200)}`,
                );
              }
            } catch (error) {
              unended++;
              kept.push(`- ${each.language} “${followUp.ask}”: ${String(error)}`);
            }
          });
        }
      };
      await Promise.all(
        Array.from({ length: Number(process.env.INCARNAMIND_LIVE_CONCURRENCY ?? 3) }, one),
      );
      let made = 0;
      let flagged = 0;
      let denied = 0;
      for (const each of LANGUAGES) {
        for (const followUp of each.followUps) {
          if (!jobs.some((job) => job.followUp === followUp)) continue;
          const counts = tally.get(followUp) ?? { made: 0, flagged: 0, denied: 0 };
          made += counts.made;
          flagged += counts.flagged;
          denied += counts.denied;
          report.push(
            `  ${each.language} “${followUp.ask}”: made ${counts.made}/${runs}; of those, status says not all done ${counts.flagged}, reply says waits or not made ${counts.denied}`,
          );
        }
      }
      const cost = await core.getCostSummary();
      report.push(
        `  all: made ${made}/${jobs.length}; status says not all done ${flagged}; reply says waits or not made ${denied}; approvals asked and declined ${approvals}; questions asked and answered ${questions}; Answers that never ended ${unended}`,
        `  requests ${cost.providers.reduce((sum, each) => sum + each.requests, 0)}, spent ${cost.spent.map((money) => `${money.amount.toFixed(4)} ${money.currency}`).join(", ") || "0"}`,
        ...kept,
      );
      core.close();
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(report.length).toBeGreaterThan(1);
    },
  );
});
