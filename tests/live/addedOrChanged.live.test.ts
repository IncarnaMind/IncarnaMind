/**
 * Whether the assistant's reply to an edit says truthfully that it added a line or changed one,
 * against real models (#2356): each request runs on a fresh Note of the User's own text, in English
 * and Chinese, and what the change did is read from its Proposals before the window applies it: a
 * Block added whole with none of the User's text struck is an addition, anything else a change.
 * Each run's reply is kept beside what the change did, for reading; the two marks only point at
 * replies to read first, as a model's wording can't be judged by its words alone.
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each request runs (2 by default),
 * INCARNAMIND_LIVE_CONCURRENCY how many run at once (3); INCARNAMIND_LIVE_REPORT names the file
 * the numbers and every reply go to.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { ChatProviderKind, ConversationAnswer, Core } from "../../src/core";
import {
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../../src/core/api";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { readProposalAttribute } from "../../src/shared/proposals";
import { createTempDataFolder, spentBy, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";

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
    {
      name: "DeepSeek",
      kind: "deepseek",
      apiKey: process.env.DEEPSEEK_API_KEY,
      model:
        process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ??
        (catalogProvider("deepseek")?.roles.answers as string),
    },
  ];

interface Request {
  name: string;
  /** The Note's paragraphs, the User's own text. */
  note: string[];
  ask: string;
  /** What the request asks for: a new line beside the User's, or a change to their text. */
  asks: "added" | "changed";
}

/** Written before any run of them (#2356): made-up Notes, none of them a test fixture or prompt example. */
const REQUESTS: Request[] = [
  {
    name: "en, a fee line added",
    note: ["Rent is 950 a month.", "Water is 25 a month."],
    ask: "Add a line saying parking is 60 a month.",
    asks: "added",
  },
  {
    name: "en, a ferry line added",
    note: ["The ferry leaves at 7:10.", "Tickets are sold on board."],
    ask: "Add a separate line: bikes travel free.",
    asks: "added",
  },
  {
    name: "en, a closing paragraph added",
    note: ["Bring a warm jacket.", "Lunch is provided."],
    ask: "Add a new paragraph at the end saying the bus returns at five.",
    asks: "added",
  },
  {
    name: "en, a room added",
    note: ["Room 4 is the quiet room.", "Room 6 has the projector."],
    ask: "Add a line for room 7: it has the whiteboard.",
    asks: "added",
  },
  {
    name: "en, a list line added",
    note: ["Milk", "Eggs"],
    ask: "Add bread to my list as its own line.",
    asks: "added",
  },
  {
    name: "en, only an amount changed",
    note: ["Gym is 35 a month.", "Phone is 20 a month."],
    ask: "The gym is 40 a month now.",
    asks: "changed",
  },
  {
    name: "en, a day changed",
    note: ["The meeting is on Tuesday at nine.", "Bring the budget sheet."],
    ask: "Move the meeting to Wednesday.",
    asks: "changed",
  },
  {
    name: "en, words added inside a line",
    note: ["Rent is 950 a month.", "Water is 25 a month."],
    ask: "Add that rent is paid on the first, in the rent line itself.",
    asks: "changed",
  },
  {
    name: "en, a line replaced",
    note: ["Dinner is at the harbour cafe.", "Dress is casual."],
    ask: "Replace the dinner line: dinner is now at the hill inn.",
    asks: "changed",
  },
  {
    name: "en, a paragraph shortened",
    note: [
      "The workshop starts at ten, but please arrive fifteen minutes early so we can sign everyone in.",
      "Coffee is in room 2.",
    ],
    ask: "Make the first paragraph shorter.",
    asks: "changed",
  },
  {
    name: "zh, a fee line added",
    note: ["房租每月950元。", "水费每月25元。"],
    ask: "加一行：停车费每月60元。",
    asks: "added",
  },
  {
    name: "zh, a ferry line added",
    note: ["渡轮七点十分出发。", "船票在船上购买。"],
    ask: "另起一行写上：自行车免费上船。",
    asks: "added",
  },
  {
    name: "zh, a closing paragraph added",
    note: ["请带一件厚外套。", "午饭由主办方提供。"],
    ask: "在最后加一段，说大巴五点返回。",
    asks: "added",
  },
  {
    name: "zh, a room added",
    note: ["四号房间是安静室。", "六号房间有投影仪。"],
    ask: "加一行七号房间：有白板。",
    asks: "added",
  },
  {
    name: "zh, a list line added",
    note: ["牛奶", "鸡蛋"],
    ask: "在我的清单里单独加一行面包。",
    asks: "added",
  },
  {
    name: "zh, only an amount changed",
    note: ["健身房每月35元。", "电话费每月20元。"],
    ask: "健身房现在每月40元了。",
    asks: "changed",
  },
  {
    name: "zh, a day changed",
    note: ["会议定在周二上午九点。", "请带上预算表。"],
    ask: "把会议改到周三。",
    asks: "changed",
  },
  {
    name: "zh, words added inside a line",
    note: ["房租每月950元。", "水费每月25元。"],
    ask: "在房租那行里写上每月一号交。",
    asks: "changed",
  },
  {
    name: "zh, a line replaced",
    note: ["晚饭在港口咖啡馆。", "着装随意。"],
    ask: "把晚饭那行换掉：晚饭改在山顶客栈。",
    asks: "changed",
  },
  {
    name: "zh, a paragraph shortened",
    note: ["工作坊十点开始，请提前十五分钟到场，方便我们为大家签到。", "咖啡在二号房间。"],
    ask: "把第一段写短一点。",
    asks: "changed",
  },
];

/** What the Answer's change did in the Note, from its Proposals: a Block added whole, or more. */
function didOf(blocks: Y.XmlFragment): "added" | "changed" | "nothing" {
  let added = false;
  let changed = false;
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const run of child.toDelta() as { attributes?: Record<string, unknown> }[]) {
          if (run.attributes?.[PROPOSAL_INSERT_MARK] || run.attributes?.[PROPOSAL_DELETE_MARK]) {
            changed = true;
          }
        }
      } else if (child instanceof Y.XmlElement) {
        const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
        if (proposal?.kind === "insert") {
          added = true;
          continue;
        }
        if (proposal?.kind === "delete") changed = true;
        visit(child);
      }
    }
  };
  visit(blocks);
  return changed ? "changed" : added ? "added" : "nothing";
}

/** Marks to read a reply by first: it speaks of adding, or of changing. */
const SAYS_ADDED =
  /\badd(?:s|ed|ing)?\b|\bnew (?:line|paragraph)\b|添加|加了|加上|新增|加入|补充|另起/i;
const SAYS_CHANGED =
  /\bchang|\bupdat|\breplac|\bedit|\brevis|\breword|\bshorten|\btrimm|\bmoved\b|修改|改为|改成|改到|更新|替换|换成|缩短|精简|改了|调整/i;

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
  return answer as ConversationAnswer;
}

describe.each(LIVE)("Added or changed, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: the reply to an edit says it added a line or changed one, as the change did`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 2);
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
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
      const jobs = REQUESTS.flatMap((request) => Array.from({ length: runs }, () => request));
      const rows: string[] = [];
      let failed = 0;
      let next = 0;
      const one = async () => {
        while (next < jobs.length) {
          const index = next++;
          const request = jobs[index] as Request;
          try {
            const mind = await core.createMind({ title: `Case ${index + 1}` });
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
            const answer = await ask(core, request.ask, mind.id);
            await client.settled();
            const did = didOf(client.doc.getXmlFragment(MIND_CONTENT_FIELD));
            // None of these asks only for text to go, so an edit that says it does is wrong (#2356).
            const removesOnly = answer.toolCalls
              .filter((call) => call.tool === "edit_mind")
              .map((call) => call.input.removes_only ?? "absent");
            rows.push(
              [
                `- ${request.name} (asks ${request.asks}): did ${did}`,
                `removes_only ${JSON.stringify(removesOnly)}`,
                `marks added ${SAYS_ADDED.test(answer.text)}, changed ${SAYS_CHANGED.test(answer.text)}`,
                `reply ${JSON.stringify(answer.text)}`,
              ].join(" · "),
            );
          } catch (error) {
            failed++;
            rows.push(`- ${request.name}: ${String(error)}`);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Number(process.env.INCARNAMIND_LIVE_CONCURRENCY ?? 3) }, one),
      );
      const report = [
        `## ${live.name} · ${live.model} (#2356, added or changed)`,
        `  runs ${jobs.length}, failed ${failed}`,
        ...spentBy(dataDir),
        ...rows.sort(),
      ];
      core.close();
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(rows.length).toBe(jobs.length);
    },
  );
});
