/**
 * Removing a sentence, or shortening, in a Note the User wrote, against real models (#2356, the
 * 2026-11-01 walk): the change applies like the English one in Chinese too, and the reply tells
 * the change made, never the edit tool's report. Each request runs on a fresh Note of the User's
 * own text (not AI text), in English and Chinese, and its change is applied as the window applies
 * it. Counts the runs whose Note came out as asked, those that waited for the User instead, and
 * among those made, the replies that talk of the tool or its report, or say the change wasn't
 * made or waits, and those the Answer's status marks as not having made every change it says.
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each request runs (2 by default),
 * INCARNAMIND_LIVE_ASK keeps only the requests that contain these words,
 * INCARNAMIND_LIVE_CONCURRENCY how many run at once (3); set INCARNAMIND_LIVE_REPORT to a file to
 * keep the numbers, with the edit's own reply and the Answer's Note calls for each run that went
 * wrong.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind, ConversationAnswer, Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { pendingProposals } from "../../src/shared/proposals";
import { createTempDataFolder, spentBy, startCore } from "../helpers/core";
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

interface Request {
  name: string;
  /** The Note's paragraphs, the User's own text. */
  note: string[];
  ask: string;
  /** Sentences that must go; every other sentence of the Note must stay word for word. */
  gone?: string[];
  /** Shortening: the Note must end shorter, every paragraph still there. */
  shorter?: true;
}

const REQUESTS: Request[] = [
  {
    name: "zh last sentence (the walk's own)",
    note: [
      "海港项目的预算为二百四十万英镑。工程将于2026年3月开工。首席工程师是林娜。测量船已预订在2026年12月2日。",
    ],
    ask: "把我笔记里关于测量船的那句话删掉。",
    gone: ["测量船已预订在2026年12月2日。"],
  },
  {
    name: "zh middle sentence",
    note: [
      "样品于周一送达实验室。样品在四摄氏度下保存。分析由王博士负责。结果预计在三月十五日公布。",
    ],
    ask: "删掉关于保存温度的那句话。",
    gone: ["样品在四摄氏度下保存。"],
  },
  {
    name: "zh first sentence",
    note: ["会议改到周四下午三点。地点仍在二楼会议室。请带上季度报表。茶点由行政部准备。"],
    ask: "把开会时间那句删掉，其他不动。",
    gone: ["会议改到周四下午三点。"],
  },
  {
    name: "zh two sentences",
    note: [
      "新办公室在西湖路十二号。搬家定在五月六日。每人需自行打包桌面物品。IT部门会负责电脑搬运。停车卡需重新申请。",
    ],
    ask: "删掉关于打包和停车卡的两句话。",
    gone: ["每人需自行打包桌面物品。", "停车卡需重新申请。"],
  },
  {
    name: "zh a sentence with a quote",
    note: ["经理说：“预算不能再增加。”我们决定推迟采购。供应商同意延期两周。"],
    ask: "删掉经理说的那句话。",
    gone: ["经理说：“预算不能再增加。”"],
  },
  {
    name: "zh shorter",
    note: [
      "本季度销售额比上季度增长了百分之十二，主要来自华东地区的新客户。我们的客户满意度调查显示，大部分客户对交付速度表示满意，但也有一些客户希望能有更多的产品选择。",
      "下季度我们计划在华南地区开设两个新的销售点，同时加强对现有客户的回访工作，并且会继续跟进满意度调查中提到的问题。",
    ],
    ask: "把我的笔记写短一点。",
    shorter: true,
  },
  {
    name: "en last sentence (the walk's, in English)",
    note: [
      "The harbour project's budget is 2.4 million pounds. Work starts in March 2026. The lead engineer is Lin Na. The survey vessel is booked for 2 December 2026.",
    ],
    ask: "Delete the sentence about the survey vessel from my note.",
    gone: ["The survey vessel is booked for 2 December 2026."],
  },
  {
    name: "en middle sentence",
    note: [
      "The samples arrived at the lab on Monday. They are stored at four degrees. Dr Wang leads the analysis. Results are due on 15 March.",
    ],
    ask: "Remove the sentence about the storage temperature.",
    gone: ["They are stored at four degrees."],
  },
  {
    name: "en first sentence",
    note: [
      "The meeting moved to Thursday at 3 pm. It is still in the second-floor room. Please bring the quarterly figures. Admin will provide snacks.",
    ],
    ask: "Delete the sentence about the meeting time, leave the rest.",
    gone: ["The meeting moved to Thursday at 3 pm."],
  },
  {
    name: "en two sentences",
    note: [
      "The new office is at 12 West Lake Road. The move is on 6 May. Everyone packs their own desk. IT will move the computers. Parking cards must be renewed.",
    ],
    ask: "Delete the sentences about packing and parking cards.",
    gone: ["Everyone packs their own desk.", "Parking cards must be renewed."],
  },
  {
    name: "en a sentence with a quote",
    note: [
      'The manager said, "The budget cannot grow." We decided to delay the purchase. The supplier agreed to a two-week delay.',
    ],
    ask: "Delete the manager's quote.",
    gone: ['The manager said, "The budget cannot grow."'],
  },
  {
    name: "en shorter",
    note: [
      "Sales this quarter grew twelve percent over last quarter, mostly from new customers in the east. Our satisfaction survey shows that most customers are happy with delivery times, though some would like a wider choice of products.",
      "Next quarter we plan to open two new sales points in the south, follow up more often with existing customers, and keep working on the issues the survey raised.",
    ],
    ask: "Make my note shorter.",
    shorter: true,
  },
];

/** A sentence ends at its stop, or after the closing quote mark right after it. */
const sentencesOf = (text: string) =>
  text.split(/(?<=[.!?。！？]["”]|[.!?。！？](?!["”]))\s*/u).filter((each) => each.trim() !== "");

/** Whether the Note came out as asked. */
function madeAsAsked(request: Request, after: string[]): boolean {
  const text = after.join("\n");
  if (request.shorter) {
    return after.length >= 1 && text.length < request.note.join("\n").length;
  }
  const gone = request.gone ?? [];
  const kept = request.note.flatMap(sentencesOf).filter((sentence) => !gone.includes(sentence));
  return gone.every((sentence) => !text.includes(sentence)) && kept.every((s) => text.includes(s));
}

/** A reply that talks of the edit tool or its report, rather than of the change. */
const TALKS_OF_TOOL = /\btool\b|\breport\b|contradict|工具|报告|矛盾/i;
/** A reply that says the change waits or wasn't made. */
const DENIES =
  /\bwait|pending|not yet|haven't|hasn't|wasn't|didn't|couldn't|还没|尚未|待你|等待|确认后|没有(?:被)?(?:删|改)/i;

async function ask(core: Core, text: string, mindId: string) {
  const result = await core.askInConversation({
    text,
    mindId,
    scope: { folderIds: [], tagIds: [], documentIds: [] },
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  const ended = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => done(false), 300_000);
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
  if (!ended) throw new Error(`No end to the Answer of “${text}” in 5 minutes.`);
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

/** Applies an Answer's changes in a Mind as the window does. */
async function apply(core: Core, answer: ConversationAnswer, mindId: string) {
  const requests = answer.toolCalls.flatMap((call) =>
    call.mindChange?.mindId === mindId ? [call.mindChange.request] : [],
  );
  if (requests.length === 0) return;
  await core.applyAskedChanges({ answerId: answer.id, mindId, requests });
}

describe.each(LIVE)("Honest edit replies, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: a sentence removed or a Note shortened applies, and the reply tells the change`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 2);
      const report: string[] = [`## ${live.name} · ${live.model} (#2356, honest edit replies)`];
      const edits: string[] = [];
      /** What each Tool call came to, as the assistant read it next. */
      const told: string[] = [];
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, {
        createChatModel: (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              wrapStream: async ({ doStream, params }) => {
                const result = await doStream();
                if (!JSON.stringify(params.prompt).includes("<passage>")) {
                  const last = params.prompt
                    .flatMap((message) => (message.role === "tool" ? message.content : []))
                    .flatMap((part) =>
                      part.type === "tool-result" && part.output.type === "text"
                        ? [part.output.value]
                        : [],
                    )
                    .at(-1);
                  if (last !== undefined && told.at(-1) !== last) told.push(last);
                  return result;
                }
                let text = "";
                const kept = new TransformStream<
                  LanguageModelV4StreamPart,
                  LanguageModelV4StreamPart
                >({
                  transform(part, controller) {
                    if (part.type === "text-delta") text += part.delta;
                    controller.enqueue(part);
                  },
                  flush() {
                    edits.push(text);
                  },
                });
                return { ...result, stream: result.stream.pipeThrough(kept) };
              },
            },
          }),
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      core.on(
        "approval.requested",
        (request) => void core.respondToApproval(request.requestId, "deny"),
      );
      await core.saveChatProvider({
        kind: live.kind,
        ...(live.apiKey && { apiKey: live.apiKey }),
        modelId: live.model,
      });
      const only = process.env.INCARNAMIND_LIVE_ASK;
      const asked = REQUESTS.filter((request) => !only || request.ask.includes(only));
      const jobs = asked.flatMap((request) => Array.from({ length: runs }, () => request));
      const tally = new Map<
        Request,
        { made: number; held: number; talks: number; denied: number; flagged: number }
      >();
      const kept: string[] = [];
      let failed = 0;
      let next = 0;
      const one = async () => {
        while (next < jobs.length) {
          const index = next++;
          const request = jobs[index] as Request;
          try {
            const mind = await core.createMind({ title: `${request.name} ${index + 1}` });
            const client = await connectToMind(core, mind.id);
            writeMind(
              client,
              request.note.map((text) => ({
                type: "paragraph",
                attrs: { id: randomUUID() },
                content: [{ type: "text", text }],
              })),
            );
            await client.settled();
            const editsBefore = edits.length;
            const toldBefore = told.length;
            const answer = await ask(core, request.ask, mind.id);
            await apply(core, answer, mind.id);
            await client.settled();
            const held = pendingProposals(client.blocks).length > 0;
            const after: string[] = [];
            readMind(client).descendants((node) => {
              if (!node.isTextblock) return true;
              const plain = node.textBetween(0, node.content.size, "", "￼");
              if (plain.trim() !== "") after.push(plain);
              return false;
            });
            const made = !held && madeAsAsked(request, after);
            const talks = TALKS_OF_TOOL.test(answer.text);
            const denied = DENIES.test(answer.text);
            const flagged = (answer.steps?.unbackedClaims ?? []).length > 0;
            const counts = tally.get(request) ?? {
              made: 0,
              held: 0,
              talks: 0,
              denied: 0,
              flagged: 0,
            };
            if (made) counts.made++;
            if (held) counts.held++;
            if (made && talks) counts.talks++;
            if (made && denied) counts.denied++;
            if (made && flagged) counts.flagged++;
            tally.set(request, counts);
            if (!made || talks || denied || flagged) {
              kept.push(
                `- ${request.name}: made ${made}, held ${held}, talks of the tool ${talks}, denies ${denied}, status flags ${flagged}`,
                `  reply: ${JSON.stringify(answer.text).slice(0, 400)}`,
                `  edit: ${JSON.stringify(edits.slice(editsBefore).join(" | ")).slice(0, 600)}`,
                `  note after: ${JSON.stringify(after).slice(0, 400)}`,
                `  told: ${JSON.stringify(told.slice(toldBefore)).slice(0, 1200)}`,
                `  calls: ${JSON.stringify(
                  answer.toolCalls
                    .filter((call) => call.source === "minds")
                    .map(({ tool, status, mindChange, mindProblem }) => ({
                      tool,
                      status,
                      ...(mindChange && { mindChange }),
                      ...(mindProblem && { mindProblem }),
                    })),
                )}`,
              );
            }
          } catch (error) {
            failed++;
            kept.push(`- ${request.name}: ${String(error)}`);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Number(process.env.INCARNAMIND_LIVE_CONCURRENCY ?? 3) }, one),
      );
      const all = { made: 0, held: 0, talks: 0, denied: 0, flagged: 0 };
      for (const request of asked) {
        const counts = tally.get(request) ?? { made: 0, held: 0, talks: 0, denied: 0, flagged: 0 };
        for (const key of Object.keys(all) as (keyof typeof all)[]) all[key] += counts[key];
        report.push(
          `  ${request.name} “${request.ask}”: made ${counts.made}/${runs}, held ${counts.held}; of those made, talks of the tool ${counts.talks}, says waits or not made ${counts.denied}, status flags ${counts.flagged}`,
        );
      }
      report.push(
        `  all: made ${all.made}/${jobs.length}, held ${all.held}; of those made, talks of the tool ${all.talks}, says waits or not made ${all.denied}, status flags ${all.flagged}; runs that failed ${failed}`,
        ...spentBy(dataDir),
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
