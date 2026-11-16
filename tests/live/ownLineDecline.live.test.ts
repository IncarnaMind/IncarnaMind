/**
 * A rewrite that finds nothing to do (#2589), against a real model: requests for what a
 * paragraph hasn't got (a sentence about a ferry that isn't there, typos that aren't there), asked
 * as a typed instruction over one paragraph of a Note of two, in English and Chinese; and real
 * edits that must be done, never declined, among them Improve, Shorten and Translate over lines
 * that have something to do. Reports how many of the requests that can't be done leave the
 * paragraph as it was (declined with a reason, left, or waiting for the User), how many write
 * something over it at once, and how many real edits are done.
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
  /** "talk": nothing to do; "real": a change that must be made. */
  kind: "talk" | "real";
  first: string;
  action: "instruction" | "shorten" | "improve" | "translate";
  /** The typed instruction, or a Translate's language. */
  ask?: string;
  /** For a real edit: what the paragraph must say and must no longer say. */
  has?: string;
  lacks?: string;
  /** For a real edit: the paragraph must come out shorter. */
  shorter?: boolean;
}

const EN = "Boats leave at high water. The office opens at nine.";
const ZH = "船只在涨潮时出港。办公室九点开门。";
const talk = (language: Request["language"], first: string, ask: string): Request => ({
  language,
  kind: "talk",
  first,
  action: "instruction",
  ask,
});
const real = (
  language: Request["language"],
  first: string,
  action: Request["action"],
  more: Partial<Request> = {},
): Request => ({ language, kind: "real", first, action, ...more });

const REQUESTS: readonly Request[] = [
  talk("English", EN, "Delete the sentence about the ferry."),
  talk("English", "The garden is open daily. Entry is free for members.", "Fix the typos."),
  talk(
    "English",
    "Rent is due on the first of each month. Late fees start after five days.",
    "Translate the sentence about parking into French.",
  ),
  talk("Chinese", ZH, "删掉关于渡轮的那句话。"),
  talk("Chinese", "花园每天开放。会员免费入场。", "改正错别字。"),
  talk("Chinese", "房租每月一号支付。逾期五天后收取滞纳金。", "把关于停车位的那句话译成法语。"),
  real(
    "English",
    "Boats go out when the water is high. The office is open from nine.",
    "instruction",
    {
      ask: "Make it more formal.",
    },
  ),
  real("English", EN, "instruction", {
    ask: "Delete the second sentence.",
    has: "Boats leave at high water.",
    lacks: "The office opens at nine.",
  }),
  real("English", EN, "instruction", { ask: "Change nine to ten.", has: "ten", lacks: "nine" }),
  real("Chinese", "船只在涨潮时出港，办公室九点开门。", "instruction", { ask: "改得更正式一些。" }),
  real("Chinese", ZH, "instruction", {
    ask: "删掉第二句。",
    has: "船只在涨潮时出港。",
    lacks: "办公室九点开门。",
  }),
  real("Chinese", ZH, "instruction", { ask: "把九点改成十点。", has: "十点", lacks: "九点" }),
  real(
    "English",
    "me and him goes to the harbour office on monday morning for to ask about tide",
    "improve",
  ),
  real(
    "English",
    "The harbour office, which is located near the north quay, is open on all weekdays from nine in the morning until five in the afternoon.",
    "shorten",
    { shorter: true },
  ),
  real("English", "Boats leave at high water.", "translate", { ask: "French" }),
  real("Chinese", "我和他周一早上去去港务办公室问问潮汐的事情的情况", "improve"),
  real(
    "Chinese",
    "位于北码头附近的港务办公室在所有工作日从早上九点一直开放到下午五点，欢迎大家前来咨询。",
    "shorten",
    { shorter: true },
  ),
  real("Chinese", ZH, "translate", { ask: "English" }),
];

const SECOND = "Second paragraph stays.";
const label = (request: Request) => `${request.action}${request.ask ? ` “${request.ask}”` : ""}`;

describe("A rewrite with nothing to do, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: it declines, or leaves the paragraph, and real edits are done`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 3);
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      const report: string[] = [`## ${MODEL} (#2589, nothing to do)`];
      const misses: string[] = [];
      const keys = [
        "declined",
        "left",
        "waits",
        "written",
        "failed",
        "done",
        "falseDecline",
        "notDone",
      ] as const;
      const total = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
        (typeof keys)[number],
        number
      >;
      let talkRuns = 0;
      let realRuns = 0;
      for (const request of REQUESTS) {
        const each = Object.fromEntries(keys.map((key) => [key, 0])) as typeof total;
        for (let run = 1; run <= runs; run++) {
          const mind = await core.createMind({ title: request.language });
          const client = await connectToMind(core, mind.id);
          const first = {
            type: "paragraph",
            attrs: { id: "p1" },
            content: [{ type: "text", text: request.first }],
          };
          const second = {
            type: "paragraph",
            attrs: { id: "p2" },
            content: [{ type: "text", text: SECOND }],
          };
          writeMind(client, [first, second]);
          await client.settled();
          const input: EditWithAiInput = {
            requestId: crypto.randomUUID(),
            mindId: mind.id,
            from: { blockId: "p1", offset: 0 },
            to: { blockId: "p1", offset: request.first.length },
            text: request.first,
            action: request.action,
            ...(request.ask && { instruction: request.ask }),
          };
          const result = await core.editWithAi(input);
          await client.settled();
          const waits = result.kind === "proposed" && result.held === true;
          // An edit that waits for the User isn't applied: the Note is as it was until they decide.
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
          const text = after[0] ?? "";
          const declined = result.kind === "unchanged" && !!result.said;
          if (request.kind === "talk") {
            if (declined) each.declined++;
            else if (waits) each.waits++;
            else if (text === request.first && after[1] === SECOND) each.left++;
            else if (result.kind === "failed") each.failed++;
            else {
              each.written++;
              misses.push(
                `- WRITTEN ${request.language} ${label(request)}: ${JSON.stringify(after)}`,
              );
            }
          } else {
            const hasIt = request.has === undefined || text.includes(request.has);
            const lacksIt = request.lacks === undefined || !text.includes(request.lacks);
            const changed = text !== request.first;
            const shorter = !request.shorter || [...text].length < [...request.first].length;
            if (declined) {
              each.falseDecline++;
              misses.push(
                `- DECLINED ${request.language} ${label(request)}: ${JSON.stringify(result)}`,
              );
            } else if (hasIt && lacksIt && changed && shorter && after[1] === SECOND) each.done++;
            else {
              each.notDone++;
              misses.push(
                `- NOT DONE ${request.language} ${label(request)} (${result.kind}${waits ? ", waits" : ""}): ${JSON.stringify(after)}`,
              );
            }
          }
        }
        for (const key of keys) total[key] += each[key];
        if (request.kind === "talk") talkRuns += runs;
        else realRuns += runs;
        report.push(
          request.kind === "talk"
            ? `  ${request.language} ${label(request)}: declined ${each.declined}, left as it was ${each.left}, waits ${each.waits}, written over ${each.written}, failed ${each.failed} of ${runs}`
            : `  ${request.language} real ${label(request)}: done ${each.done}, declined ${each.falseDecline}, not done ${each.notDone} of ${runs}`,
        );
      }
      report.push(
        `  all, nothing to do: declined ${total.declined}, left as it was ${total.left}, waits ${total.waits}, written over at once ${total.written}, failed ${total.failed} of ${talkRuns}`,
        `  all, real edits: done ${total.done}, declined ${total.falseDecline}, not done ${total.notDone} of ${realRuns}`,
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
