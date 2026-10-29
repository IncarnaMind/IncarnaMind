/**
 * What a rewrite takes out that nobody asked to go (#2180): a Note of five paragraphs, each with a
 * word of its own, edited by requests that are not removals (shorten, improve, more formal,
 * typos, translate, make it a table), then accepted. Reports how many of the paragraphs' words
 * are lost, and how many paragraphs the Note has, so the same run on another build compares.
 * Each model runs only when its key is in the environment, as in ./removalPhrasings.live.test.ts.
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each request runs (5 by default); set
 * INCARNAMIND_LIVE_REPORT to a file to keep the numbers.
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
  ];

interface Request {
  action: "instruction" | "shorten" | "improve" | "translate";
  ask: string;
}

const EN = {
  language: "English",
  blocks: [
    "The harbour office is open on weekdays and posts the tide tables every Monday morning.",
    "Gauge readings are checked twice a week by the duty officer, who logs any drift in a notebook.",
    "A new pontoon was added at the north quay last spring, and it takes boats up to twelve metres.",
    "Visitors must book a mooring through the office at least two days before they arrive.",
    "Fees are charged per night and are lower between November and March.",
  ],
  words: ["Monday", "duty officer", "pontoon", "two days", "November"],
  list: ["Spring tides: at new moon.", "Neap tides: weakest.", "Storm surge: after gales."],
  listWords: ["Spring", "Neap", "Storm"],
  requests: [
    { action: "shorten", ask: "" },
    { action: "improve", ask: "" },
    { action: "instruction", ask: "Make it shorter." },
    { action: "instruction", ask: "Improve the writing." },
    { action: "instruction", ask: "Make it more formal." },
    { action: "instruction", ask: "Fix any typos." },
    { action: "translate", ask: "French" },
  ] satisfies Request[],
};

const ZH = {
  language: "Chinese",
  blocks: [
    "港务办公室工作日开放，每周一上午公布潮汐表。",
    "值班员每周检查两次水位计读数，并在笔记本上记录任何偏差。",
    "去年春天在北码头新增了一个浮桥，可停靠十二米以内的船只。",
    "访客须在抵达前至少两天通过办公室预订泊位。",
    "费用按夜收取，十一月至三月较低。",
  ],
  words: ["周一", "值班员", "浮桥", "两天", "十一月"],
  list: ["大潮：新月时。", "小潮：最弱。", "风暴潮：大风之后。"],
  listWords: ["大潮", "小潮", "风暴潮"],
  requests: [
    { action: "shorten", ask: "" },
    { action: "improve", ask: "" },
    { action: "instruction", ask: "把它改短一些。" },
    { action: "instruction", ask: "润色一下。" },
    { action: "instruction", ask: "改得更正式。" },
    { action: "instruction", ask: "改正错别字。" },
    { action: "translate", ask: "English" },
  ] satisfies Request[],
};

describe.each(LIVE)("What an edit takes out unasked, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: paragraphs and their words survive requests that are not removals`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 5);
      const report: string[] = [`## ${live.name} · ${live.model} (#2180, over-removal)`];
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({
        kind: live.kind,
        ...(live.apiKey && { apiKey: live.apiKey }),
        modelId: live.model,
      });
      const paragraph = (id: string, text: string) => ({
        type: "paragraph",
        attrs: { id },
        content: [{ type: "text", text }],
      });
      const bullets = (id: string, items: string[]) => ({
        type: "bulletList",
        attrs: { id },
        content: items.map((text, index) => ({
          type: "listItem",
          attrs: { id: `${id}-${index}` },
          content: [paragraph(`${id}-${index}p`, text)],
        })),
      });
      let lostTotal = 0;
      let runsTotal = 0;
      let blocksLost = 0;
      for (const each of [EN, ZH]) {
        const cases = [
          ...each.requests.map((request) => ({ request, list: false })),
          {
            request: {
              action: "instruction",
              ask: each === EN ? "Make it a table." : "改成表格。",
            } satisfies Request,
            list: true,
          },
        ];
        for (const { request, list } of cases) {
          let lost = 0;
          let blocks = 0;
          let overall = 0;
          for (let run = 1; run <= runs; run++) {
            const mind = await core.createMind({ title: each.language });
            const client = await connectToMind(core, mind.id);
            writeMind(
              client,
              list
                ? [bullets("b0", each.list)]
                : each.blocks.map((text, index) => paragraph(`b${index}`, text)),
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
              action: request.action,
              ...(request.ask !== "" && { instruction: request.ask }),
            });
            await client.settled();
            if (result.kind === "proposed") {
              client.doc.transact(() => {
                resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
              }, "editor");
              await client.settled();
            }
            const after = readMind(client).textContent;
            let count = 0;
            readMind(client).descendants((node) => {
              if (node.isTextblock && node.content.size > 0) count++;
              return !node.isTextblock;
            });
            const expected = list ? each.listWords : each.words;
            // A translation changes the words themselves: only the paragraphs are counted.
            const gone =
              request.action === "translate"
                ? 0
                : expected.filter((word) => !after.includes(word)).length;
            const before = list ? each.list.length : each.blocks.length;
            lost += gone;
            blocks += Math.max(0, before - count);
            if (gone > 0 || count < before) overall++;
          }
          lostTotal += lost;
          blocksLost += blocks;
          runsTotal += runs;
          report.push(
            `  ${each.language} ${list ? "[list] " : ""}${request.action} “${request.ask}”: words lost ${lost}, paragraphs fewer ${blocks}, runs with any loss ${overall}/${runs}`,
          );
        }
      }
      report.push(
        `  all: words lost ${lostTotal}, paragraphs fewer ${blocksLost} in ${runsTotal} runs`,
      );
      core.close();
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(report.length).toBeGreaterThan(1);
    },
  );
});
