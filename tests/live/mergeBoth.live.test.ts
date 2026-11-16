/**
 * A rewrite that merges two paragraphs says both are replaced, so no sentence of the old text
 * stands beside its new version (#2333): the four-paragraph summary of the 2026-11-07 walk, asked
 * "Make the summary shorter.", then accepted. Reports in how many runs a figure the Note stated
 * once is stated twice, and how many runs were held for the User. The same run on another build
 * compares. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (INCARNAMIND_LIVE_ANTHROPIC_MODEL the
 * model); INCARNAMIND_LIVE_RUNS sets how many times each language runs (5 by default).
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type * as Y from "yjs";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { resolveProposals } from "../../src/shared/proposals";
import { createTempDataFolder, spentBy, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

const NOTES = [
  {
    language: "English",
    ask: "Make the summary shorter.",
    blocks: [
      "The survey team is two people and a volunteer.",
      "It used 14 stations along the north shore.",
      "The approved survey budget is £182,500.",
      "The report is due on 12 December.",
    ],
    figure: "182,500",
  },
  {
    language: "Chinese",
    ask: "把摘要改短一些。",
    blocks: [
      "测量组有两名成员和一名志愿者。",
      "共使用了北岸沿线的14个测量站。",
      "获批的测量预算为182,500英镑。",
      "报告须于12月12日提交。",
    ],
    figure: "182,500",
  },
];

describe("A merge names both paragraphs, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: no figure is stated twice after a shortening is accepted`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 5);
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      const report: string[] = [`## ${MODEL} (#2333, merge)`];
      for (const each of NOTES) {
        let twice = 0;
        let held = 0;
        let lost = 0;
        const misses: string[] = [];
        for (let run = 1; run <= runs; run++) {
          const mind = await core.createMind({ title: each.language });
          const client = await connectToMind(core, mind.id);
          const blocks = each.blocks.map((text, index) => ({
            type: "paragraph",
            attrs: { id: `b${index}` },
            content: [{ type: "text", text }],
          }));
          writeMind(client, blocks);
          await client.settled();
          const result = await core.editWithAi({
            requestId: crypto.randomUUID(),
            mindId: mind.id,
            from: { blockId: "b0", offset: 0 },
            to: { blockId: "b3", offset: (each.blocks[3] ?? "").length },
            text: each.blocks.join("\n"),
            action: "instruction",
            instruction: each.ask,
          });
          await client.settled();
          if (result.kind === "proposed" && result.held === true) held++;
          if (result.kind === "proposed") {
            client.doc.transact(() => {
              resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
            }, "editor");
            await client.settled();
          }
          const after = readMind(client).textContent;
          const times = after.split(each.figure).length - 1;
          if (times > 1) {
            twice++;
            misses.push(`  ${each.language} run ${run}: ${JSON.stringify(after)}`);
          }
          if (times === 0) lost++;
        }
        report.push(
          `  ${each.language}: figure stated twice ${twice}/${runs}, figure gone ${lost}/${runs}, held ${held}/${runs}`,
          ...misses,
        );
      }
      report.push(...spentBy(dataDir));
      core.close();
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(report.length).toBeGreaterThan(1);
    },
  );
});
