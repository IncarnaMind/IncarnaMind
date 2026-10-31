/**
 * Removal requests in the User's own words, against real models (#2180): a Note of four
 * sections, one of them a list, and requests worded many ways in each language to take out a
 * section, a paragraph, a list item or "the part about …", to take one out and change the rest,
 * to replace one, or to take out all of a selection. Once the changes are accepted the Note is
 * checked: what was asked to go is gone, everything else is as it was, and no other text came in.
 * Each model runs only when its key is in the environment, as in ./editWithAi.live.test.ts.
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each request runs (10 by default),
 * INCARNAMIND_LIVE_ASK keeps only the requests that contain these words, INCARNAMIND_LIVE_KIND
 * only those of one kind, INCARNAMIND_LIVE_LANGUAGE one language ("English", "Chinese"),
 * INCARNAMIND_LIVE_CONCURRENCY how many run at once (4); set INCARNAMIND_LIVE_REPORT to a file
 * to keep the numbers and what each miss left in the Note. With INCARNAMIND_LIVE_ASSISTANT=1 each
 * request is asked of the assistant beside the Note instead, and each miss keeps what its reply
 * said, so a reply that claims a removal the Note doesn't show can be read.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type * as Y from "yjs";
import type { ChatProviderKind, Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { proposalRequestOf, resolveProposals } from "../../src/shared/proposals";
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
    {
      name: "Local",
      kind: "ollama",
      apiKey: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ? "" : undefined,
      model: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ?? "",
    },
  ];

type Block = ["heading" | "paragraph" | "bullet", string];

interface Case {
  ask: string;
  /**
   * remove: only `gone` goes; edit: `gone` goes and the rest may be reworded; replace: `gone`
   * gives way to one new paragraph that `says` these words; whole: the selection is `only`, and
   * all of it goes.
   */
  kind: "remove" | "edit" | "replace" | "whole";
  /** The Note's Blocks that must go, by index. */
  gone: number[];
  /** Blocks that may go or stay: the heading of a section whose text was asked to go. */
  optional?: number[];
  says?: string[];
  only?: number[];
}

interface Language {
  language: "English" | "Chinese";
  blocks: Block[];
  /** A word of each Block's own, to find it once the rest is reworded. */
  keys: string[];
  cases: Case[];
}

const EN: Language = {
  language: "English",
  blocks: [
    ["heading", "Role"],
    ["paragraph", "The post is a senior analyst position in the finance team."],
    ["heading", "Hours"],
    ["paragraph", "Work is full time, Monday to Friday."],
    ["paragraph", "Core hours are 9:30 to 15:30."],
    ["heading", "Benefits"],
    ["bullet", "A pension matched up to 5% of salary."],
    ["bullet", "25 days of annual leave."],
    ["bullet", "Free parking at the north site."],
    ["heading", "Pay"],
    ["paragraph", "The salary is set by grade 7 and paid monthly."],
  ],
  keys: [
    "Role",
    "analyst",
    "Hours",
    "Monday",
    "9:30",
    "Benefits",
    "5%",
    "25",
    "north",
    "Pay",
    "grade 7",
  ],
  cases: [
    { kind: "remove", ask: "Remove the Hours section.", gone: [2, 3, 4] },
    { kind: "remove", ask: "I don't need the Pay section any more, cut it.", gone: [9, 10] },
    { kind: "remove", ask: "Erase the Role section.", gone: [0, 1] },
    { kind: "remove", ask: "Lose the benefits section entirely.", gone: [5, 6, 7, 8] },
    { kind: "remove", ask: "Cut the paragraph about core hours.", gone: [4] },
    { kind: "remove", ask: "Delete the sentence saying the job is full time.", gone: [3] },
    { kind: "remove", ask: "Remove the bullet about parking.", gone: [8] },
    { kind: "remove", ask: "Take the annual leave item off the list.", gone: [7] },
    { kind: "remove", ask: "Drop the bit about hours.", gone: [3, 4], optional: [2] },
    {
      kind: "remove",
      ask: "Get rid of everything about working hours.",
      gone: [3, 4],
      optional: [2],
    },
    { kind: "remove", ask: "Take out the part about the pension.", gone: [6] },
    { kind: "remove", ask: "Please remove the line about 9:30 to 15:30.", gone: [4] },
    {
      kind: "edit",
      ask: "Remove the Hours section and make the rest more formal.",
      gone: [2, 3, 4],
    },
    { kind: "edit", ask: "Drop the parking bullet and fix any typos.", gone: [8] },
    {
      kind: "replace",
      ask: "Replace the two paragraphs under Hours with one sentence: hours are flexible.",
      gone: [3, 4],
      says: ["flexible"],
    },
    {
      kind: "replace",
      ask: "Change the parking bullet to say parking is no longer free.",
      gone: [8],
      says: ["parking"],
    },
    { kind: "whole", ask: "Delete this.", gone: [2, 3, 4], only: [2, 3, 4] },
    { kind: "whole", ask: "Get rid of it", gone: [8], only: [8] },
  ],
};

const ZH: Language = {
  language: "Chinese",
  blocks: [
    ["heading", "职位"],
    ["paragraph", "该岗位是财务团队的高级分析岗位。"],
    ["heading", "工时"],
    ["paragraph", "全职，周一至周五上班。"],
    ["paragraph", "核心工作时间为9:30至15:30。"],
    ["heading", "福利"],
    ["bullet", "养老金按工资的5%匹配。"],
    ["bullet", "每年25天年假。"],
    ["bullet", "北区免费停车。"],
    ["heading", "薪酬"],
    ["paragraph", "薪酬按7级确定，按月发放。"],
  ],
  keys: ["职位", "高级分析", "工时", "周一", "9:30", "福利", "5%", "25", "北区", "薪酬", "7级"],
  cases: [
    { kind: "remove", ask: "删掉工时那一节。", gone: [2, 3, 4] },
    { kind: "remove", ask: "薪酬部分不需要了，直接删掉。", gone: [9, 10] },
    { kind: "remove", ask: "把“职位”这一节去掉。", gone: [0, 1] },
    { kind: "remove", ask: "福利这一节整个拿掉吧。", gone: [5, 6, 7, 8] },
    { kind: "remove", ask: "删去关于核心工作时间的那一段。", gone: [4] },
    { kind: "remove", ask: "把说全职上班的那句话删了。", gone: [3] },
    { kind: "remove", ask: "去掉停车那一条。", gone: [8] },
    { kind: "remove", ask: "年假那条从列表里删掉。", gone: [7] },
    { kind: "remove", ask: "去掉关于工时的内容。", gone: [3, 4], optional: [2] },
    { kind: "remove", ask: "工时相关的内容都不要了。", gone: [3, 4], optional: [2] },
    { kind: "remove", ask: "养老金那部分不要了。", gone: [6] },
    { kind: "remove", ask: "请移除9:30至15:30那一行。", gone: [4] },
    { kind: "edit", ask: "删掉工时那一节，其余的改得更正式。", gone: [2, 3, 4] },
    { kind: "edit", ask: "去掉停车那一条，顺便改正错别字。", gone: [8] },
    {
      kind: "replace",
      ask: "把工时下面的两段换成一句话：工作时间灵活。",
      gone: [3, 4],
      says: ["灵活"],
    },
    { kind: "replace", ask: "把停车那一条改成停车不再免费。", gone: [8], says: ["停车"] },
    { kind: "whole", ask: "删掉这部分。", gone: [2, 3, 4], only: [2, 3, 4] },
    { kind: "whole", ask: "这条不要了", gone: [8], only: [8] },
  ],
};

/** The Note's Blocks as Mind content, a list's items in one list. */
function contentOf(blocks: readonly Block[]): JSONContent[] {
  const content: JSONContent[] = [];
  for (const [index, [kind, text]] of blocks.entries()) {
    const words = [{ type: "text", text }];
    if (kind === "heading") {
      content.push({ type: "heading", attrs: { id: `b${index}`, level: 2 }, content: words });
    } else if (kind === "paragraph") {
      content.push({ type: "paragraph", attrs: { id: `b${index}` }, content: words });
    } else {
      const item = {
        type: "listItem",
        attrs: { id: `i${index}` },
        content: [{ type: "paragraph", attrs: { id: `b${index}` }, content: words }],
      };
      const last = content.at(-1);
      if (last?.type === "bulletList") last.content?.push(item);
      else content.push({ type: "bulletList", attrs: { id: `l${index}` }, content: [item] });
    }
  }
  return content;
}

/** Whether the Note's paragraphs, once accepted, are what the case asked for; why not, if not. */
function verdict(each: Language, asked: Case, after: string[]): string | null {
  const before = each.blocks.map(([, text]) => text);
  const optional = new Set(asked.optional ?? []);
  const gone = new Set(asked.gone);
  const expected = before.filter(
    (text, index) => !gone.has(index) && (!optional.has(index) || after.includes(text)),
  );
  const news = after.filter((text) => !before.includes(text));
  if (asked.kind === "remove" || asked.kind === "whole") {
    if (news.length > 0) return `text came in: ${JSON.stringify(news)}`;
    return JSON.stringify(after) === JSON.stringify(expected) ? null : "not as asked";
  }
  if (asked.kind === "replace") {
    const kept = after.filter((text) => before.includes(text));
    if (JSON.stringify(kept) !== JSON.stringify(expected)) return "the rest changed";
    if (news.length !== 1) return `${news.length} new paragraphs`;
    const said = (news[0] ?? "").toLowerCase();
    return (asked.says ?? []).every((word) => said.includes(word.toLowerCase()))
      ? null
      : "the new text doesn't say it";
  }
  const joined = after.join("\n").toLowerCase();
  const has = (index: number) => joined.includes((each.keys[index] ?? "").toLowerCase());
  const missing = each.keys.filter(
    (_key, index) => !gone.has(index) && !optional.has(index) && !has(index),
  );
  const left = asked.gone.filter(has);
  if (left.length > 0) return `still there: ${left.join(", ")}`;
  if (missing.length > 0) return `lost: ${missing.join(", ")}`;
  const most = before.length - asked.gone.length;
  const least = most - optional.size;
  return after.length >= least && after.length <= most ? null : `${after.length} paragraphs`;
}

/** The Note's paragraphs with any words, in order. */
function textsOf(client: Awaited<ReturnType<typeof connectToMind>>): string[] {
  const texts: string[] = [];
  readMind(client).descendants((node) => {
    if (!node.isTextblock) return true;
    const plain = node.textBetween(0, node.content.size, "", "￼");
    if (plain.trim() !== "") texts.push(plain);
    return false;
  });
  return texts;
}

/** Runs `work` on each item, `limit` at a time. */
async function pooled<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

const CLAIMS = /remov|delet|took out|taken out|dropp|cut|删|去掉|去除|移除|拿掉/i;

/** Asks the assistant beside `mindId` with no Documents, and gives what its reply says once it has ended. */
async function askAssistant(core: Core, text: string, mindId: string): Promise<string> {
  const result = await core.askInConversation({
    text,
    mindId,
    scope: { folderIds: [], tagIds: [], documentIds: [] },
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done()),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
    ];
    function done() {
      for (const stop of stops) stop();
      resolve();
    }
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  return answer?.kind === "answer" ? answer.text : "";
}

describe.each(LIVE)("Removal in the User's own words, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: each request per language takes out exactly what was asked`,
    { timeout: 7_200_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 10);
      const report: string[] = [`## ${live.name} · ${live.model} (#2180, removal phrasings)`];
      // What the model wrote for each request, kept on the run it was for.
      const replies = new AsyncLocalStorage<{ raw: string }>();
      const core = startCore(await createTempDataFolder(), {
        createChatModel: (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              wrapStream: async ({ doStream }) => {
                const { stream, ...rest } = await doStream();
                const kept = replies.getStore();
                return {
                  ...rest,
                  stream: stream.pipeThrough(
                    new TransformStream({
                      transform(part, controller) {
                        if (kept && part.type === "text-delta") kept.raw += part.delta;
                        controller.enqueue(part);
                      },
                    }),
                  ),
                };
              },
            },
          }),
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({
        kind: live.kind,
        ...(live.apiKey && { apiKey: live.apiKey }),
        modelId: live.model,
      });
      const assistant = process.env.INCARNAMIND_LIVE_ASSISTANT === "1";
      if (assistant) report[0] += " through the assistant";
      const jobs: { each: Language; asked: Case; run: number }[] = [];
      for (const each of [EN, ZH]) {
        if (
          process.env.INCARNAMIND_LIVE_LANGUAGE &&
          each.language !== process.env.INCARNAMIND_LIVE_LANGUAGE
        )
          continue;
        for (const asked of each.cases) {
          if (
            process.env.INCARNAMIND_LIVE_ASK &&
            !asked.ask.includes(process.env.INCARNAMIND_LIVE_ASK)
          )
            continue;
          if (process.env.INCARNAMIND_LIVE_KIND && asked.kind !== process.env.INCARNAMIND_LIVE_KIND)
            continue;
          // The assistant has no selection: it is asked about the whole Note.
          if (assistant && asked.kind === "whole") continue;
          for (let run = 1; run <= runs; run++) jobs.push({ each, asked, run });
        }
      }
      const exact = new Map<Case, number>();
      const misses: string[] = [];
      let strays = 0;
      let claimed = 0;
      await pooled(jobs, Number(process.env.INCARNAMIND_LIVE_CONCURRENCY ?? 4), (job) =>
        replies.run({ raw: "" }, () => runJob(job)),
      );
      async function runJob(job: { each: Language; asked: Case; run: number }) {
        const { each, asked } = job;
        // A title of its own, so the assistant never takes another run's Note for this one.
        const mind = await core.createMind({ title: `${each.language} ${jobs.indexOf(job) + 1}` });
        const client = await connectToMind(core, mind.id);
        writeMind(client, contentOf(each.blocks));
        await client.settled();
        const only = new Set(
          (asked.only ?? each.blocks.map((_, index) => index)).map((i) => `b${i}`),
        );
        const sizes: { id: string; size: number; plain: string }[] = [];
        readMind(client).descendants((node) => {
          if (!node.isTextblock) return true;
          if (only.has(String(node.attrs.id))) {
            sizes.push({
              id: String(node.attrs.id),
              size: node.content.size,
              plain: node.textBetween(0, node.content.size, "", "￼"),
            });
          }
          return false;
        });
        const first = sizes[0];
        const last = sizes.at(-1);
        if (!first || !last) throw new Error("No blocks.");
        if (assistant) {
          const said = await askAssistant(core, asked.ask, mind.id);
          await client.settled();
          client.doc.transact(() => {
            resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
          }, "editor");
          await client.settled();
          const after = textsOf(client);
          const wrong = verdict(each, asked, after);
          if (wrong === null) {
            exact.set(asked, (exact.get(asked) ?? 0) + 1);
            return;
          }
          if (wrong.startsWith("text came in")) strays++;
          const before = each.blocks.map(([, text]) => text);
          if (asked.gone.some((index) => after.includes(before[index] ?? "")) && CLAIMS.test(said))
            claimed++;
          misses.push(
            `- MISS ${each.language} ${asked.kind} “${asked.ask}” (${wrong}): ${JSON.stringify(after)}`,
            `  said: ${JSON.stringify(said)}`,
          );
          return;
        }
        const result = await core.editWithAi({
          requestId: crypto.randomUUID(),
          mindId: mind.id,
          from: { blockId: first.id, offset: 0 },
          to: { blockId: last.id, offset: last.size },
          text: sizes.map((block) => block.plain).join("\n"),
          action: "instruction",
          instruction: asked.ask,
        });
        await client.settled();
        let why = "";
        if (result.kind === "proposed") {
          const made = proposalRequestOf(client.doc, result.request);
          why = made?.source === "edit-with-ai" ? (made.reason ?? "") : "";
          client.doc.transact(() => {
            resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
          }, "editor");
          await client.settled();
        }
        const after = textsOf(client);
        const wrong = verdict(each, asked, after);
        if (wrong === null) {
          exact.set(asked, (exact.get(asked) ?? 0) + 1);
          return;
        }
        if (wrong.startsWith("text came in")) strays++;
        const before = each.blocks.map(([, text]) => text);
        const stillThere = asked.gone.some((index) => after.includes(before[index] ?? ""));
        if (stillThere && CLAIMS.test(why)) claimed++;
        const failed = result.kind === "failed" ? ` ${JSON.stringify(result.error)}` : "";
        misses.push(
          `- MISS ${each.language} ${asked.kind} “${asked.ask}” (${result.kind}${failed}; ${wrong}; why: ${why}): ${JSON.stringify(after)}`,
          `  reply: ${JSON.stringify(replies.getStore()?.raw ?? "")}`,
        );
      }
      let total = 0;
      let exactTotal = 0;
      for (const each of [EN, ZH]) {
        for (const asked of each.cases) {
          const ran = jobs.filter((job) => job.asked === asked).length;
          if (ran === 0) continue;
          const got = exact.get(asked) ?? 0;
          total += ran;
          exactTotal += got;
          report.push(`  ${each.language} ${asked.kind} “${asked.ask}”: exact ${got}/${ran}`);
        }
      }
      const cost = await core.getCostSummary();
      report.push(
        `  all: exact ${exactTotal}/${total}; text other than the passage in the Note ${strays}/${total}; a miss whose ${assistant ? "reply" : "why"} says it removed ${claimed}/${total}`,
        `  requests ${cost.providers.reduce((sum, each) => sum + each.requests, 0)}, spent ${cost.spent.map((money) => `${money.amount.toFixed(4)} ${money.currency}`).join(", ") || "0"}`,
        ...misses,
      );
      core.close();
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(report.length).toBeGreaterThan(1);
    },
  );
});
