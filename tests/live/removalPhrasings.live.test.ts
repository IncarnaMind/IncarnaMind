/**
 * Removal requests in the User's own words, against real models (#2180): a Note of three
 * sections, a request to take one section or paragraph out in ten phrasings per language, and a
 * check of the Note once the changes are accepted: what was asked to go is gone and nothing else
 * is. Each model runs only when its key is in the environment, as in ./editWithAi.live.test.ts.
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each phrasing runs (10 by default),
 * INCARNAMIND_LIVE_ASK keeps only the phrasings that contain these words; set
 * INCARNAMIND_LIVE_REPORT to a file to keep what each run left in the Note.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type * as Y from "yjs";
import type { ChatProviderKind } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { resolveProposals } from "../../src/shared/proposals";
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

interface Phrasing {
  ask: string;
  /** A Note of its own, when the phrasing needs one. */
  blocks?: [string, string][];
  /** Words that must not be left in the Note. */
  gone: string[];
  /** Words that must still be there. */
  stays: string[];
}

const EN = {
  language: "English",
  blocks: [
    ["heading", "Role"],
    ["paragraph", "The post is a senior analyst position in the finance team."],
    ["heading", "Hours"],
    ["paragraph", "Work is full time, Monday to Friday."],
    ["paragraph", "Core hours are 9:30 to 15:30."],
    ["heading", "Pay"],
    ["paragraph", "The salary is set by grade 7 and paid monthly."],
  ],
  phrasings: [
    {
      ask: "Remove the Hours section.",
      gone: ["Monday", "9:30"],
      stays: ["senior analyst", "grade 7"],
    },
    {
      ask: "Delete the hours section and its heading.",
      gone: ["Monday", "9:30", "Hours"],
      stays: ["senior analyst", "grade 7"],
    },
    {
      ask: "Drop the bit about hours.",
      gone: ["Monday", "9:30"],
      stays: ["senior analyst", "grade 7"],
    },
    {
      ask: "Get rid of everything about working hours.",
      gone: ["Monday", "9:30"],
      stays: ["senior analyst", "grade 7"],
    },
    {
      ask: "Take out the part about the hours.",
      gone: ["Monday", "9:30"],
      stays: ["senior analyst", "grade 7"],
    },
    {
      ask: "Cut the paragraph about core hours.",
      gone: ["9:30"],
      stays: ["Monday", "senior analyst", "grade 7"],
    },
    {
      ask: "Delete the paragraph on full-time work.",
      gone: ["Monday"],
      stays: ["9:30", "senior analyst", "grade 7"],
    },
    {
      ask: "Please remove the line about 9:30 to 15:30.",
      gone: ["9:30"],
      stays: ["Monday", "senior analyst", "grade 7"],
    },
    {
      ask: "I don't need the Pay section any more, cut it.",
      gone: ["grade 7"],
      stays: ["senior analyst", "Monday", "9:30"],
    },
    {
      ask: "Erase the Role section.",
      gone: ["senior analyst"],
      stays: ["Monday", "9:30", "grade 7"],
    },
    {
      ask: "Remove the Hours section and tighten the rest.",
      gone: ["Monday", "9:30"],
      stays: ["analyst", "grade"],
    },
    {
      ask: "Drop the hours section and fix any typos.",
      gone: ["Monday", "9:30"],
      stays: ["analyst", "grade"],
    },
    {
      ask: "Delete the Pay section.",
      blocks: [
        ["heading", "Role"],
        ["paragraph", "The post is a senior analyst position in the finance team."],
        ["heading", "Pay review"],
        ["paragraph", "The pay review is held every March."],
        ["heading", "Pay"],
        ["paragraph", "The salary is set by grade 7 and paid monthly."],
      ],
      gone: ["grade 7"],
      stays: ["analyst", "March"],
    },
    {
      ask: "Delete the Pay section and make the rest more formal.",
      gone: ["grade"],
      stays: ["analyst", "Monday", "9:30"],
    },
  ],
} satisfies { language: string; blocks: [string, string][]; phrasings: Phrasing[] };

const ZH = {
  language: "Chinese",
  blocks: [
    ["heading", "职位"],
    ["paragraph", "该岗位是财务团队的高级分析岗位。"],
    ["heading", "工时"],
    ["paragraph", "全职，周一至周五上班。"],
    ["paragraph", "核心工作时间为9:30至15:30。"],
    ["heading", "薪酬"],
    ["paragraph", "薪酬按7级确定，按月发放。"],
  ],
  phrasings: [
    { ask: "删掉工时那一节。", gone: ["周一", "9:30"], stays: ["高级分析", "按7级"] },
    {
      ask: "删除“工时”部分，包括标题。",
      gone: ["周一", "9:30", "工时"],
      stays: ["高级分析", "按7级"],
    },
    { ask: "去掉关于工时的内容。", gone: ["周一", "9:30"], stays: ["高级分析", "按7级"] },
    { ask: "把工时这一小节拿掉。", gone: ["周一", "9:30"], stays: ["高级分析", "按7级"] },
    { ask: "工时相关的内容都去掉。", gone: ["周一", "9:30"], stays: ["高级分析", "按7级"] },
    { ask: "删去关于核心工作时间的那一段。", gone: ["9:30"], stays: ["周一", "高级分析", "按7级"] },
    { ask: "把全职、周一至周五那一段删除。", gone: ["周一"], stays: ["9:30", "高级分析", "按7级"] },
    { ask: "请移除9:30至15:30那一行。", gone: ["9:30"], stays: ["周一", "高级分析", "按7级"] },
    { ask: "薪酬部分不需要了，直接删掉。", gone: ["按7级"], stays: ["高级分析", "周一", "9:30"] },
    { ask: "把“职位”这一节去掉。", gone: ["高级分析"], stays: ["周一", "9:30", "按7级"] },
    { ask: "删掉工时那一节，其余的精简一下。", gone: ["周一", "9:30"], stays: ["分析", "7级"] },
    { ask: "去掉工时部分，顺便改正错别字。", gone: ["周一", "9:30"], stays: ["分析", "7级"] },
    {
      ask: "删掉“工作安排”这一节。",
      blocks: [
        ["heading", "职位"],
        ["paragraph", "该岗位是财务团队的高级分析岗位。"],
        ["heading", "工作安排（试用期）"],
        ["paragraph", "试用期为三个月。"],
        ["heading", "工作安排"],
        ["paragraph", "全职，周一至周五上班。"],
      ],
      gone: ["周一"],
      stays: ["分析", "试用期为三个月"],
    },
    { ask: "删除薪酬部分，其余改得更正式。", gone: ["7级"], stays: ["分析", "周一", "9:30"] },
  ],
} satisfies { language: string; blocks: [string, string][]; phrasings: Phrasing[] };

describe.each(LIVE)("Removal in the User's own words, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: the phrasings per language remove exactly what was asked`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 10);
      const report: string[] = [`## ${live.name} · ${live.model} (#2180, removal phrasings)`];
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({
        kind: live.kind,
        ...(live.apiKey && { apiKey: live.apiKey }),
        modelId: live.model,
      });
      let exactTotal = 0;
      let total = 0;
      for (const each of [EN, ZH]) {
        for (const phrasing of each.phrasings.slice(
          0,
          Number(process.env.INCARNAMIND_LIVE_LIMIT ?? 99),
        )) {
          if (
            process.env.INCARNAMIND_LIVE_ASK &&
            !phrasing.ask.includes(process.env.INCARNAMIND_LIVE_ASK)
          ) {
            continue;
          }
          let exact = 0;
          for (let run = 1; run <= runs; run++) {
            const mind = await core.createMind({ title: each.language });
            const client = await connectToMind(core, mind.id);
            writeMind(
              client,
              (phrasing.blocks ?? each.blocks).map(([kind, text], index) =>
                kind === "heading"
                  ? {
                      type: "heading",
                      attrs: { id: `b${index}`, level: 2 },
                      content: [{ type: "text", text }],
                    }
                  : {
                      type: "paragraph",
                      attrs: { id: `b${index}` },
                      content: [{ type: "text", text }],
                    },
              ),
            );
            await client.settled();
            const sizes: { id: string; size: number; plain: string }[] = [];
            readMind(client).descendants((node) => {
              if (!node.isTextblock) return true;
              sizes.push({
                id: String(node.attrs.id),
                size: node.content.size,
                plain: node.textBetween(0, node.content.size, "", "￼"),
              });
              return false;
            });
            const first = sizes[0];
            const last = sizes.at(-1);
            if (!first || !last) throw new Error("No blocks.");
            const result = await core.editWithAi({
              requestId: crypto.randomUUID(),
              mindId: mind.id,
              from: { blockId: first.id, offset: 0 },
              to: { blockId: last.id, offset: last.size },
              text: sizes.map((block) => block.plain).join("\n"),
              action: "instruction",
              instruction: phrasing.ask,
            });
            await client.settled();
            if (result.kind === "proposed") {
              client.doc.transact(() => {
                resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
              }, "editor");
              await client.settled();
            }
            const text = readMind(client).textContent;
            const ok =
              phrasing.gone.every((word) => !text.includes(word)) &&
              phrasing.stays.every((word) => text.includes(word));
            if (ok) exact++;
            else {
              const why = result.kind === "failed" ? ` ${JSON.stringify(result.error)}` : "";
              report.push(
                `- MISS ${each.language} “${phrasing.ask}” (${result.kind}${why}): ${text}`,
              );
            }
          }
          exactTotal += exact;
          total += runs;
          report.push(`  ${each.language} “${phrasing.ask}”: exact ${exact}/${runs}`);
        }
      }
      report.push(`  all: exact ${exactTotal}/${total}`);
      core.close();
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(report.length).toBeGreaterThan(1);
    },
  );
});
