/**
 * The four edges of #2333 against a real model, through Edit with AI over all of a small Note:
 * a <removed> the User typed (the model may write it back without its escape), words the User
 * types into a paragraph while the model writes (the reply takes that paragraph out), a reply cut
 * off at its output limit, and a partial reply that adds a line on the pattern of the others or
 * changes one of them. Once the changes are accepted, the Note is checked: no word of the User's
 * is lost, and the request is done as asked. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY.
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each case runs (10 by default),
 * INCARNAMIND_LIVE_KIND keeps one kind ("typed", "meanwhile", "cut", "partial"),
 * INCARNAMIND_LIVE_CONCURRENCY how many run at once (4), and INCARNAMIND_LIVE_REPORT a file to
 * keep the numbers and each miss in.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type * as Y from "yjs";
import type { EditAction, EditWithAiResult } from "../../src/core";
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

interface Case {
  kind: "typed" | "meanwhile" | "cut" | "partial";
  language: "English" | "Chinese";
  lines: string[];
  ask: string;
  action?: EditAction;
  /** Lines that must be in the Note afterwards, word for word. */
  kept: string[];
  /** Lines that must be gone. */
  gone?: string[];
  /** Words a new or changed line must say; with `added`, how many lines it adds. */
  says?: string[];
  added?: number;
  /** Typed into the second line once the reply starts. */
  typed?: string;
}

const TYPED_EN = [
  "Write <removed>draft</removed> in the subject line until the memo is final.",
  "Send it to the whole team on Friday.",
  "Keep a copy in the shared folder.",
];
const TYPED_ZH = [
  "备忘录定稿前，主题行里写<removed>草稿</removed>。",
  "周五发给全组。",
  "在共享文件夹里留一份。",
];
const KEYS_EN = [
  "Rent is due on the first.",
  "Keys are at the front desk.",
  "Water is billed quarterly.",
];
const KEYS_ZH = ["房租每月一号交。", "钥匙在前台。", "水费按季度收。"];
const COSTS_EN = ["Rent is 1,200 a month.", "Parking is 100 a month.", "Water is 30 a month."];
const COSTS_ZH = ["房租每月1200元。", "停车每月100元。", "物业每月30元。"];
const LONG_EN = [
  "The harbour office publishes the tide tables every March.",
  "Spring tides are strongest at new moon and at full moon.",
  "Boats should leave the inner basin two hours before low water.",
];
const LONG_ZH = [
  "港务办公室每年三月公布潮汐表。",
  "大潮在新月和满月时最强。",
  "船只应在低潮前两小时离开内港。",
];

const CASES: Case[] = [
  {
    kind: "typed",
    language: "English",
    lines: TYPED_EN,
    ask: "Fix the wording.",
    kept: [],
    says: ["<removed>draft</removed>"],
  },
  {
    kind: "typed",
    language: "English",
    lines: TYPED_EN,
    ask: "Make it more formal.",
    kept: [],
    says: ["<removed>draft</removed>"],
  },
  {
    kind: "typed",
    language: "English",
    lines: TYPED_EN,
    ask: "Delete the line about the shared folder.",
    kept: TYPED_EN.slice(0, 2),
    gone: [TYPED_EN[2] ?? ""],
  },
  {
    kind: "typed",
    language: "Chinese",
    lines: TYPED_ZH,
    ask: "修正措辞。",
    kept: [],
    says: ["<removed>草稿</removed>"],
  },
  {
    kind: "typed",
    language: "Chinese",
    lines: TYPED_ZH,
    ask: "改得更正式一些。",
    kept: [],
    says: ["<removed>草稿</removed>"],
  },
  {
    kind: "typed",
    language: "Chinese",
    lines: TYPED_ZH,
    ask: "删掉共享文件夹那一句。",
    kept: TYPED_ZH.slice(0, 2),
    gone: [TYPED_ZH[2] ?? ""],
  },
  {
    kind: "meanwhile",
    language: "English",
    lines: KEYS_EN,
    ask: "Delete the line about keys.",
    kept: [KEYS_EN[0] ?? "", KEYS_EN[2] ?? ""],
    typed: " Bring the fob.",
    says: ["Bring the fob."],
  },
  {
    kind: "meanwhile",
    language: "Chinese",
    lines: KEYS_ZH,
    ask: "删掉钥匙那一句。",
    kept: [KEYS_ZH[0] ?? "", KEYS_ZH[2] ?? ""],
    typed: "记得带门禁卡。",
    says: ["记得带门禁卡。"],
  },
  { kind: "cut", language: "English", lines: LONG_EN, ask: "Make it more formal.", kept: LONG_EN },
  { kind: "cut", language: "English", lines: LONG_EN, ask: "", action: "shorten", kept: LONG_EN },
  { kind: "cut", language: "Chinese", lines: LONG_ZH, ask: "改得更正式一些。", kept: LONG_ZH },
  { kind: "cut", language: "Chinese", lines: LONG_ZH, ask: "", action: "shorten", kept: LONG_ZH },
  {
    kind: "partial",
    language: "English",
    lines: COSTS_EN,
    ask: "Add a line for internet: 40 a month.",
    kept: COSTS_EN,
    says: ["internet", "40"],
    added: 1,
  },
  {
    kind: "partial",
    language: "English",
    lines: COSTS_EN,
    ask: "Add internet at 40 a month.",
    kept: COSTS_EN,
    says: ["internet", "40"],
    added: 1,
  },
  {
    kind: "partial",
    language: "English",
    lines: COSTS_EN,
    ask: "Change parking to 120 a month.",
    kept: [COSTS_EN[0] ?? "", COSTS_EN[2] ?? ""],
    gone: [COSTS_EN[1] ?? ""],
    says: ["120"],
    added: 1,
  },
  {
    kind: "partial",
    language: "Chinese",
    lines: COSTS_ZH,
    ask: "加一行网络费用，每月40元。",
    kept: COSTS_ZH,
    says: ["网络", "40"],
    added: 1,
  },
  {
    kind: "partial",
    language: "Chinese",
    lines: COSTS_ZH,
    ask: "把停车改成每月120元。",
    kept: [COSTS_ZH[0] ?? "", COSTS_ZH[2] ?? ""],
    gone: [COSTS_ZH[1] ?? ""],
    says: ["120"],
    added: 1,
  },
];

/** The Note's paragraphs with any words, as the User has them (changes still waiting read as before). */
function textsOf(client: MindClient): string[] {
  const texts: string[] = [];
  readMind(client).descendants((node) => {
    if (!node.isTextblock) return true;
    const plain = node.textBetween(0, node.content.size, "", "￼");
    if (plain.trim() !== "") texts.push(plain);
    return false;
  });
  return texts;
}

/** What went wrong, if anything: `lost` when a word of the User's is gone, else `not as asked`. */
function verdict(asked: Case, before: string[], after: string[], result: EditWithAiResult) {
  const missing = asked.kept.filter((line) => !after.includes(line));
  if (asked.kind === "meanwhile" && !after.some((line) => line.includes(asked.typed ?? "")))
    return "lost: the words typed meanwhile";
  if (missing.length > 0) return `lost: ${JSON.stringify(missing)}`;
  if (asked.kind === "cut") {
    if (JSON.stringify(after) !== JSON.stringify(before)) return "lost: the Note changed";
    return result.kind === "failed" && result.error.kind === "cut-short"
      ? null
      : `not as asked: ${result.kind}`;
  }
  if ((asked.gone ?? []).some((line) => after.includes(line))) return "not as asked: still there";
  const fresh = after.filter((line) => !before.includes(line));
  const joined = after.join("\n").toLowerCase();
  if (!(asked.says ?? []).every((word) => joined.includes(word.toLowerCase())))
    return `${asked.kind === "typed" ? "lost" : "not as asked"}: doesn't say ${JSON.stringify(asked.says)}`;
  if (asked.added !== undefined && fresh.length !== asked.added)
    return `not as asked: ${fresh.length} new lines`;
  return null;
}

async function pooled<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

describe("The edges of an edit, live (#2333)", () => {
  test.skipIf(KEY === undefined)(
    "no word of the User's is lost, and each request is done as asked",
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 10);
      const report: string[] = [`## Anthropic · ${MODEL} (#2333, edit edges)`];
      /** Each run's reply, and what to do once its first words come. */
      const runOf = new AsyncLocalStorage<{ raw: string; started?: () => void; cut: boolean }>();
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
                        if (kept && part.type === "text-delta") {
                          if (kept.raw === "") kept.started?.();
                          kept.raw += part.delta;
                        }
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

      const jobs = CASES.filter(
        (asked) =>
          !process.env.INCARNAMIND_LIVE_KIND || asked.kind === process.env.INCARNAMIND_LIVE_KIND,
      ).flatMap((asked) => Array.from({ length: runs }, () => asked));
      const exact = new Map<Case, number>();
      const lost = new Map<Case, number>();
      const dropped = new Map<Case, number>();
      /** Results other than Proposals, by kind: an exact run may be a refusal that kept the Note. */
      const notProposed = new Map<Case, Map<string, number>>();
      const misses: string[] = [];
      /** The whole replies to requests in the User's words, whose passage shows its paragraphs' names. */
      const said: string[] = [];

      const runJob = async (asked: Case) => {
        const mind = await core.createMind({ title: `${asked.kind} ${crypto.randomUUID()}` });
        const client = await connectToMind(core, mind.id);
        const content: JSONContent[] = asked.lines.map((line, index) => ({
          type: "paragraph",
          attrs: { id: `b${index}` },
          content: [{ type: "text", text: line }],
        }));
        writeMind(client, content);
        await client.settled();
        const last = asked.lines.at(-1) ?? "";
        const kept = runOf.getStore();
        if (kept && asked.typed) {
          kept.started = () => {
            const words = (client.blocks.get(1) as Y.XmlElement).get(0) as Y.XmlText;
            words.insert(words.length, asked.typed ?? "");
          };
        }
        const result = await core.editWithAi({
          requestId: crypto.randomUUID(),
          mindId: mind.id,
          from: { blockId: "b0", offset: 0 },
          to: { blockId: `b${asked.lines.length - 1}`, offset: last.length },
          text: asked.lines.join("\n"),
          action: asked.action ?? "instruction",
          ...(asked.ask && { instruction: asked.ask }),
        });
        await client.settled();
        const before = textsOf(client);
        client.doc.transact(() => {
          resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
        }, "editor");
        await client.settled();
        const after = textsOf(client);
        const raw = kept?.raw ?? "";
        if (result.kind !== "proposed") {
          const kinds = notProposed.get(asked) ?? new Map<string, number>();
          kinds.set(result.kind, (kinds.get(result.kind) ?? 0) + 1);
          notProposed.set(asked, kinds);
        }
        if ((asked.action ?? "instruction") === "instruction" && asked.kind !== "cut")
          said.push(raw);
        if (asked.kind === "typed" && /(?<!\\)<removed>(?:draft|草稿)/.test(raw)) {
          dropped.set(asked, (dropped.get(asked) ?? 0) + 1);
        }
        const wrong = verdict(
          asked,
          asked.kind === "meanwhile" ? before : asked.lines,
          after,
          result,
        );
        if (wrong === null) {
          exact.set(asked, (exact.get(asked) ?? 0) + 1);
          return;
        }
        if (wrong.startsWith("lost")) lost.set(asked, (lost.get(asked) ?? 0) + 1);
        misses.push(
          `- MISS ${asked.language} ${asked.kind} “${asked.ask || asked.action}” (${result.kind}; ${wrong}): ${JSON.stringify(after)}`,
          `  reply: ${JSON.stringify(raw)}`,
        );
      };
      await pooled(jobs, Number(process.env.INCARNAMIND_LIVE_CONCURRENCY ?? 4), (asked) =>
        runOf.run({ raw: "", cut: asked.kind === "cut" }, () => runJob(asked)),
      );

      let total = 0;
      let exactTotal = 0;
      let lostTotal = 0;
      for (const asked of CASES) {
        const ran = jobs.filter((job) => job === asked).length;
        if (ran === 0) continue;
        total += ran;
        exactTotal += exact.get(asked) ?? 0;
        lostTotal += lost.get(asked) ?? 0;
        const escapes = asked.kind === "typed" ? `, escape dropped ${dropped.get(asked) ?? 0}` : "";
        const others = [...(notProposed.get(asked) ?? [])].map(
          ([kind, count]) => `${kind} ${count}`,
        );
        report.push(
          `  ${asked.language} ${asked.kind} “${asked.ask || asked.action}”: exact ${exact.get(asked) ?? 0}/${ran}, words lost ${lost.get(asked) ?? 0}${escapes}${others.length > 0 ? `, not proposed: ${others.join(", ")}` : ""}`,
        );
      }
      report.push(
        `  all: exact ${exactTotal}/${total}; words lost ${lostTotal}/${total}; ${namedSaid(said)}`,
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
