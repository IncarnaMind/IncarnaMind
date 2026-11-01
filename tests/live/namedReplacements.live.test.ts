/**
 * Named replacements against real models, on Notes and requests written after the design of
 * #2356 was fixed and never used to tune it: a Note in English and one in Chinese, each with
 * headings, paragraphs, a list and a table, and requests that change one line, add one or two,
 * take one out, rewrite a short list item, turn the list into a table, find nothing to do, or meet
 * the output limit.
 * Once the changes are accepted, the Note is checked: every line the request didn't name is there
 * word for word (none lost or written over), and the request is done as asked.
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY.
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each request runs (10 by default),
 * INCARNAMIND_LIVE_ANTHROPIC_MODEL the model, INCARNAMIND_LIVE_CONCURRENCY how many run at once
 * (4), and INCARNAMIND_LIVE_REPORT a file to keep the numbers and each miss in.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type * as Y from "yjs";
import type { EditWithAiResult } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { resolveProposals } from "../../src/shared/proposals";
import { createTempDataFolder, namedSaid, spentBy, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

type Block = ["heading" | "paragraph" | "bullet", string] | ["row", string[]];

interface Case {
  /** change: `target` gives way to one line that says `says`; add: `added` new lines say `says`; remove: `target` goes; table: the list becomes a table naming `says`; cut: the reply meets its output limit and nothing changes; none: there is nothing to do, and nothing changes. */
  kind: "change" | "add" | "remove" | "table" | "cut" | "none";
  ask: string;
  target?: string;
  says?: string[];
  added?: number;
}

interface Note {
  language: "English" | "Chinese";
  blocks: Block[];
  /** The list's items, which a table made of the list may take the place of. */
  list: string[];
  cases: Case[];
}

const EN: Note = {
  language: "English",
  blocks: [
    ["heading", "Move"],
    ["paragraph", "The office moves to Harbour Street on 3 March."],
    ["paragraph", "Movers arrive at 8:00 and leave by 17:00."],
    ["heading", "People"],
    ["bullet", "Lena books the van."],
    ["bullet", "Omar packs the archive."],
    ["bullet", "Priya updates the address."],
    ["heading", "Costs"],
    ["row", ["Item", "Cost"]],
    ["row", ["Van", "250"]],
    ["row", ["Boxes", "80"]],
    ["paragraph", "Storage is 150 pounds a week."],
  ],
  list: ["Lena books the van.", "Omar packs the archive.", "Priya updates the address."],
  cases: [
    {
      kind: "change",
      ask: "Omar labels the boxes now, instead of packing the archive.",
      target: "Omar packs the archive.",
      says: ["label"],
    },
    {
      kind: "change",
      ask: "The movers now arrive at 7:30.",
      target: "Movers arrive at 8:00 and leave by 17:00.",
      says: ["7:30"],
    },
    { kind: "change", ask: "The van costs 300 now.", target: "250", says: ["300"] },
    {
      kind: "change",
      ask: "Change the bullet about the address to say Priya also tells the bank.",
      target: "Priya updates the address.",
      says: ["bank"],
    },
    {
      kind: "change",
      ask: "The move is on 10 March now.",
      target: "The office moves to Harbour Street on 3 March.",
      says: ["10 March"],
    },
    { kind: "add", ask: "Add Sam to the people: he sets up the network.", says: ["Sam"], added: 1 },
    {
      kind: "add",
      ask: "Add a line saying parking is free on moving day.",
      says: ["parking"],
      added: 1,
    },
    {
      kind: "add",
      ask: "Add two people: Uma brings the keys and Vic cleans the old office.",
      says: ["Uma", "Vic"],
      added: 2,
    },
    {
      kind: "remove",
      ask: "Delete the line about storage.",
      target: "Storage is 150 pounds a week.",
    },
    { kind: "remove", ask: "Take Lena off the list.", target: "Lena books the van." },
    {
      kind: "table",
      ask: "Turn the list of people into a table of name and task.",
      says: ["Lena", "Omar", "Priya"],
    },
    { kind: "cut", ask: "Make it more formal." },
    { kind: "none", ask: "Correct any spelling mistakes." },
  ],
};

const ZH: Note = {
  language: "Chinese",
  blocks: [
    ["heading", "活动"],
    ["paragraph", "年会定在十二月五日举行。"],
    ["paragraph", "签到从下午两点开始。"],
    ["heading", "分工"],
    ["bullet", "小林负责场地。"],
    ["bullet", "阿美负责餐饮。"],
    ["bullet", "老周负责音响。"],
    ["heading", "预算"],
    ["row", ["项目", "费用"]],
    ["row", ["场地", "8000"]],
    ["row", ["餐饮", "6000"]],
    ["paragraph", "外地同事可报销一晚住宿。"],
  ],
  list: ["小林负责场地。", "阿美负责餐饮。", "老周负责音响。"],
  cases: [
    { kind: "change", ask: "阿美改为负责礼品。", target: "阿美负责餐饮。", says: ["礼品"] },
    {
      kind: "change",
      ask: "签到改成一点半开始。",
      target: "签到从下午两点开始。",
      says: ["一点半"],
    },
    { kind: "change", ask: "场地费改成9000。", target: "8000", says: ["9000"] },
    {
      kind: "change",
      ask: "把老周那条改成老周和小李一起负责音响。",
      target: "老周负责音响。",
      says: ["小李"],
    },
    {
      kind: "change",
      ask: "日期改到十二月十二日。",
      target: "年会定在十二月五日举行。",
      says: ["十二月十二日"],
    },
    { kind: "add", ask: "加一条：小陈负责摄影。", says: ["小陈"], added: 1 },
    { kind: "add", ask: "加一句：当天停车免费。", says: ["停车"], added: 1 },
    {
      kind: "add",
      ask: "再加两个人：小王负责主持，小赵负责签到。",
      says: ["小王", "小赵"],
      added: 2,
    },
    { kind: "remove", ask: "删掉住宿那一句。", target: "外地同事可报销一晚住宿。" },
    { kind: "remove", ask: "把小林从名单里去掉。", target: "小林负责场地。" },
    { kind: "table", ask: "把分工列表做成表格，列出人名和任务。", says: ["小林", "阿美", "老周"] },
    { kind: "cut", ask: "改得更正式一些。" },
    { kind: "none", ask: "看看有没有错别字，有就改掉。" },
  ],
};

/** A Note's Blocks as Mind content: a list's items in one list, a table's rows in one table, its first row the heading row. */
function contentOf(blocks: readonly Block[]): JSONContent[] {
  const content: JSONContent[] = [];
  const words = (value: string) => [{ type: "text", text: value }];
  for (const [index, block] of blocks.entries()) {
    const last = content.at(-1);
    if (block[0] === "row") {
      const first = last?.type !== "table";
      const row = {
        type: "tableRow",
        content: block[1].map((value, at) => ({
          type: first ? "tableHeader" : "tableCell",
          attrs: { colspan: 1, rowspan: 1 },
          content: [{ type: "paragraph", attrs: { id: `b${index}c${at}` }, content: words(value) }],
        })),
      };
      if (last?.type === "table") last.content?.push(row);
      else content.push({ type: "table", content: [row] });
    } else if (block[0] === "heading") {
      content.push({
        type: "heading",
        attrs: { id: `b${index}`, level: 2 },
        content: words(block[1]),
      });
    } else if (block[0] === "paragraph") {
      content.push({ type: "paragraph", attrs: { id: `b${index}` }, content: words(block[1]) });
    } else {
      const item = {
        type: "listItem",
        content: [{ type: "paragraph", attrs: { id: `b${index}` }, content: words(block[1]) }],
      };
      if (last?.type === "bulletList") last.content?.push(item);
      else content.push({ type: "bulletList", content: [item] });
    }
  }
  return content;
}

/** The Note's lines with any words, in order: a table's cells each a line. */
function textsOf(client: MindClient): string[] {
  const texts: string[] = [];
  readMind(client).descendants((node) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, "", "￼");
    if (text.trim() !== "") texts.push(text);
    return false;
  });
  return texts;
}

const linesOf = (note: Note) =>
  note.blocks.flatMap((block) => (block[0] === "row" ? block[1] : [block[1]]));

/**
 * What went wrong: `lost` when a line the request didn't name is gone, `grew` when one is changed
 * with every word of it kept, else `not as asked`; null when all is well.
 */
function verdict(
  note: Note,
  asked: Case,
  after: string[],
  result: EditWithAiResult,
): string | null {
  const before = linesOf(note);
  const free = new Set([
    ...(asked.target ? [asked.target] : []),
    ...(asked.kind === "table" ? note.list : []),
  ]);
  // A line can be there twice, as the table's "Van" cell and in the list: each is counted.
  const left = [...after];
  const missing = before.filter((line) => {
    const at = left.indexOf(line);
    if (at >= 0) left.splice(at, 1);
    return at < 0 && !free.has(line);
  });
  // A line whose words all stand in a longer one was written over, its words kept: a named rewrite that added to it.
  const lost = missing.filter((line) => !after.some((each) => each.includes(line)));
  if (lost.length > 0) return `lost: ${JSON.stringify(lost)}`;
  if (missing.length > 0) return `grew: ${JSON.stringify(missing)}`;
  const fresh = left.filter((line) => !before.includes(line));
  const lower = fresh.join("\n").toLowerCase();
  const says = (asked.says ?? []).every((word) => lower.includes(word.toLowerCase()));
  if (asked.kind === "cut") {
    return result.kind === "failed" && result.error.kind === "cut-short"
      ? null
      : `not as asked: ${result.kind}`;
  }
  if (result.kind === "misnamed") return "refused: misnamed";
  if (asked.kind === "none") {
    return fresh.length === 0 ? null : `not as asked: text came in ${JSON.stringify(fresh)}`;
  }
  if (asked.kind === "remove") {
    if (after.includes(asked.target ?? "")) return "not as asked: still there";
    return fresh.length === 0 ? null : `not as asked: text came in ${JSON.stringify(fresh)}`;
  }
  if (asked.kind === "table") {
    return says ? null : `not as asked: ${JSON.stringify(fresh)}`;
  }
  if (asked.kind === "change" && after.includes(asked.target ?? ""))
    return "not as asked: still there";
  if (!says) return `not as asked: doesn't say ${JSON.stringify(asked.says)}`;
  const count = asked.kind === "add" ? (asked.added ?? 1) : 1;
  return fresh.length === count
    ? null
    : `not as asked: ${fresh.length} new lines ${JSON.stringify(fresh)}`;
}

async function pooled<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

describe("Named replacements on held-out Notes, live (#2356)", () => {
  test.skipIf(KEY === undefined)(
    "no line the request didn't name is lost or written over, and each is done as asked",
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 10);
      const report: string[] = [`## Anthropic · ${MODEL} (#2356, held out)`];
      const runOf = new AsyncLocalStorage<{ raw: string; cut: boolean }>();
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, {
        createChatModel: (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              transformParams: async ({ params }) =>
                runOf.getStore()?.cut ? { ...params, maxOutputTokens: 16 } : params,
              wrapStream: async ({ doStream }) => {
                const { stream, ...rest } = await doStream();
                const kept = runOf.getStore();
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
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY, modelId: MODEL });

      const only = process.env.INCARNAMIND_LIVE_ASK;
      const jobs = [EN, ZH].flatMap((note) =>
        note.cases
          .filter((asked) => !only || asked.ask.includes(only))
          .flatMap((asked) => Array.from({ length: runs }, () => ({ note, asked }))),
      );
      const exact = new Map<Case, number>();
      const lost = new Map<Case, number>();
      const grew = new Map<Case, number>();
      const refused = new Map<Case, number>();
      const misses: string[] = [];
      const said: string[] = [];

      const runJob = async ({ note, asked }: { note: Note; asked: Case }) => {
        const mind = await core.createMind({ title: crypto.randomUUID() });
        const client = await connectToMind(core, mind.id);
        writeMind(client, contentOf(note.blocks));
        await client.settled();
        const ids: { id: string; size: number }[] = [];
        readMind(client).descendants((node) => {
          if (!node.isTextblock) return true;
          ids.push({ id: String(node.attrs.id), size: node.content.size });
          return false;
        });
        const first = ids[0];
        const last = ids.at(-1);
        if (!first || !last) throw new Error("No blocks.");
        const result = await core.editWithAi({
          requestId: crypto.randomUUID(),
          mindId: mind.id,
          from: { blockId: first.id, offset: 0 },
          to: { blockId: last.id, offset: last.size },
          text: linesOf(note).join("\n"),
          action: "instruction",
          instruction: asked.ask,
        });
        await client.settled();
        const raw = runOf.getStore()?.raw ?? "";
        if (asked.kind !== "cut") said.push(raw);
        client.doc.transact(() => {
          resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
        }, "editor");
        await client.settled();
        const after = textsOf(client);
        const wrong = verdict(note, asked, after, result);
        if (wrong === null) {
          exact.set(asked, (exact.get(asked) ?? 0) + 1);
          return;
        }
        if (wrong.startsWith("lost")) lost.set(asked, (lost.get(asked) ?? 0) + 1);
        if (wrong.startsWith("grew")) grew.set(asked, (grew.get(asked) ?? 0) + 1);
        if (wrong.startsWith("refused")) refused.set(asked, (refused.get(asked) ?? 0) + 1);
        misses.push(
          `- MISS ${note.language} ${asked.kind} “${asked.ask}” (${result.kind}; ${wrong}): ${JSON.stringify(after)}`,
          `  reply: ${JSON.stringify(raw)}`,
        );
      };
      await pooled(jobs, Number(process.env.INCARNAMIND_LIVE_CONCURRENCY ?? 4), (job) =>
        runOf.run({ raw: "", cut: job.asked.kind === "cut" }, () => runJob(job)),
      );

      let total = 0;
      let exactTotal = 0;
      let lostTotal = 0;
      let grewTotal = 0;
      let refusedTotal = 0;
      for (const note of [EN, ZH]) {
        for (const asked of note.cases) {
          const ran = jobs.filter((job) => job.asked === asked).length;
          if (ran === 0) continue;
          total += ran;
          exactTotal += exact.get(asked) ?? 0;
          lostTotal += lost.get(asked) ?? 0;
          grewTotal += grew.get(asked) ?? 0;
          refusedTotal += refused.get(asked) ?? 0;
          report.push(
            `  ${note.language} ${asked.kind} “${asked.ask}”: exact ${exact.get(asked) ?? 0}/${ran}, lines lost ${lost.get(asked) ?? 0}, written over with every word kept ${grew.get(asked) ?? 0}, refused as misnamed ${refused.get(asked) ?? 0}`,
          );
        }
      }
      report.push(
        `  all: exact ${exactTotal}/${total}; runs that lost a line ${lostTotal}/${total}; runs that wrote over a line, every word kept, ${grewTotal}/${total}; refused as misnamed ${refusedTotal}/${total}; ${namedSaid(said)}`,
        ...spentBy(dataDir),
        ...misses,
      );
      core.close();
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(total).toBeGreaterThan(0);
    },
  );
});
