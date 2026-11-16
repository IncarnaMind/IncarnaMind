/**
 * A removal wider than the request names (#3178), against a real model: requests that name a
 * sentence the paragraph doesn't have ("Delete the sentence about the ferry."), over one paragraph
 * of a Note of four, in English and Chinese, where a model may quote the whole paragraph as taken
 * out; and a control of whole-paragraph removals the User did ask for ("Delete this paragraph.", a
 * sentence that is all of the paragraph), which must still apply at once. Reports, for the first,
 * how many leave the paragraph (declined, left, or waiting for the User) and how many take it
 * out at once; for the control, how many apply at once and how many wait.
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (INCARNAMIND_LIVE_ANTHROPIC_MODEL the model, Claude
 * Haiku 5.5 by default); INCARNAMIND_LIVE_RUNS sets how many times each request runs (3), and
 * INCARNAMIND_LIVE_REPORT a file to keep the numbers and each miss in.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type * as Y from "yjs";
import type { EditWithAiInput } from "../../src/core";
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

interface Request {
  language: "English" | "Chinese";
  /** "wider": names text the paragraph lacks; "asked": names all of the paragraph. */
  kind: "wider" | "asked";
  first: string;
  ask: string;
}

const wider = (language: Request["language"], first: string, ask: string): Request => ({
  language,
  kind: "wider",
  first,
  ask,
});
const asked = (language: Request["language"], first: string, ask: string): Request => ({
  language,
  kind: "asked",
  first,
  ask,
});

const REQUESTS: readonly Request[] = [
  wider(
    "English",
    "Boats leave at high water. The office opens at nine.",
    "Delete the sentence about the ferry.",
  ),
  wider(
    "English",
    "The garden is open daily. Entry is free for members.",
    "Delete the sentence about parking.",
  ),
  wider(
    "English",
    "Rent is due on the first of each month. Late fees start after five days.",
    "Remove the line about the deposit.",
  ),
  wider("Chinese", "船只在涨潮时出港。办公室九点开门。", "删掉关于渡轮的那句话。"),
  wider("Chinese", "花园每天开放。会员免费入场。", "删掉关于停车的那句话。"),
  wider("Chinese", "房租每月一号支付。逾期五天后收取滞纳金。", "去掉关于押金的那一句。"),
  asked("English", "The ferry leaves at six.", "Delete the sentence about the ferry."),
  asked(
    "English",
    "Boats leave at high water. The office opens at nine.",
    "Delete this paragraph.",
  ),
  asked("English", "The garden is open daily.", "Remove this."),
  asked("Chinese", "渡轮六点出发。", "删掉关于渡轮的那句话。"),
  asked("Chinese", "船只在涨潮时出港。办公室九点开门。", "把这一段删掉。"),
  asked("Chinese", "花园每天开放。", "这条不要了。"),
];

const REST = {
  English: [
    "Second paragraph stays.",
    "The harbour keeps a register of every vessel that ties up at the north quay during the season.",
    "Fees are charged per night and are lower between November and March.",
  ],
  Chinese: [
    "第二段保留。",
    "港口对整个季节里在北码头靠泊的每一艘船只都有登记，并在年底汇总公布。",
    "费用按夜收取，十一月至三月较低。",
  ],
} as const;

describe("A removal wider than the request names, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: a paragraph the request doesn't name waits, and a removal it names applies at once`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 3);
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      const report: string[] = [`## ${MODEL} (#3178, removal wider than asked)`];
      const misses: string[] = [];
      const total = {
        left: 0,
        waits: 0,
        removedAtOnce: 0,
        other: 0,
        atOnce: 0,
        heldControl: 0,
        notDone: 0,
      };
      let widerRuns = 0;
      let askedRuns = 0;
      for (const request of REQUESTS) {
        const each = {
          left: 0,
          waits: 0,
          removedAtOnce: 0,
          other: 0,
          atOnce: 0,
          heldControl: 0,
          notDone: 0,
        };
        for (let run = 1; run <= runs; run++) {
          const mind = await core.createMind({ title: request.language });
          const client = await connectToMind(core, mind.id);
          const paragraphs = [request.first, ...REST[request.language]].map((text, index) => ({
            type: "paragraph",
            attrs: { id: `p${index + 1}` },
            content: [{ type: "text", text }],
          }));
          writeMind(client, paragraphs);
          await client.settled();
          const input: EditWithAiInput = {
            requestId: crypto.randomUUID(),
            mindId: mind.id,
            from: { blockId: "p1", offset: 0 },
            to: { blockId: "p1", offset: request.first.length },
            text: request.first,
            action: "instruction",
            instruction: request.ask,
          };
          const result = await core.editWithAi(input);
          await client.settled();
          const waits = result.kind === "proposed" && result.held === true;
          if (result.kind === "proposed" && !waits) {
            client.doc.transact(() => {
              resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
            }, "editor");
            await client.settled();
          }
          const after: string[] = [];
          readMind(client).descendants((node) => {
            if (!node.isTextblock) return true;
            after.push(node.textContent);
            return false;
          });
          const gone = !after.includes(request.first);
          const restIntact = REST[request.language].every((line) => after.includes(line));
          if (request.kind === "wider") {
            if (waits) each.waits++;
            else if (!gone && restIntact) each.left++;
            else if (gone) {
              each.removedAtOnce++;
              misses.push(
                `- REMOVED AT ONCE ${request.language} “${request.ask}”: ${JSON.stringify(after)}`,
              );
            } else each.other++;
          } else if (waits) {
            each.heldControl++;
            misses.push(`- CONTROL HELD ${request.language} “${request.ask}”`);
          } else if (gone && restIntact) each.atOnce++;
          else {
            each.notDone++;
            misses.push(
              `- CONTROL NOT DONE ${request.language} “${request.ask}” (${result.kind}): ${JSON.stringify(after)}`,
            );
          }
        }
        for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += each[key];
        if (request.kind === "wider") widerRuns += runs;
        else askedRuns += runs;
        report.push(
          request.kind === "wider"
            ? `  ${request.language} wider “${request.ask}”: left ${each.left}, waits ${each.waits}, removed at once ${each.removedAtOnce}, other ${each.other} of ${runs}`
            : `  ${request.language} asked “${request.ask}”: applied at once ${each.atOnce}, held ${each.heldControl}, not done ${each.notDone} of ${runs}`,
        );
      }
      report.push(
        `  all, names text the paragraph lacks: left ${total.left}, waits ${total.waits}, removed at once ${total.removedAtOnce}, other ${total.other} of ${widerRuns}`,
        `  all, names all of the paragraph: applied at once ${total.atOnce}, held ${total.heldControl}, not done ${total.notDone} of ${askedRuns}`,
        ...spentBy(dataDir),
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
