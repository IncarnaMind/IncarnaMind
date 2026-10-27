/**
 * A sentence about a workbook's summary row, checked by a real model (#1459): Northwind Retail's
 * monthly sales workbook ends with a sheet of 2026 totals by region, a different shape from the
 * 288 month rows before it. The assistant (scripted, so what it cites is known) writes one true
 * sentence per region, each citing that region's summary row, and every check goes to the real
 * model. Each figure must come out Supported. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY.
 *
 * - INCARNAMIND_LIVE_ANTHROPIC_MODEL: the model (Claude Haiku 5.5 when unset).
 * - INCARNAMIND_LIVE_RUNS: how many times each language writes and checks (1 when unset).
 * - INCARNAMIND_LIVE_LANGUAGES: "en", "zh-CN" or both (both when unset).
 * - INCARNAMIND_LIVE_REPORT: a file to keep each figure's result and its reason.
 * - INCARNAMIND_LIVE_TRACE: a file to keep each check's requests and Tool calls.
 */
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { writeResearchFiles } from "../../e2e/demo/research";
import { type ChatModelFactory, createAiSdkChatModel } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { askAssistant } from "../helpers/assistant";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 1);
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh-CN").split(",");
const TRACE = process.env.INCARNAMIND_LIVE_TRACE;

const CASES = {
  en: {
    ask: "Add a line to this note with North's and West's 2026 sales from the workbook's 2026 by region sheet.",
    query: "2026 by region North West 2026 sales",
    regions: [
      { label: "North", total: "6496265" },
      { label: "West", total: "9537361" },
    ],
    sentence: (region: string, total: string, marker: number) =>
      `${region}'s 2026 sales were £${Number(total).toLocaleString("en-GB")}[^${marker}].`,
    done: "Added the two totals.",
  },
  "zh-CN": {
    ask: "请根据工作簿中的“2026 年分地区”表，在笔记里写下北区和西区 2026 年的销售额。",
    query: "2026 年分地区 北区 西区 2026 年销售额",
    regions: [
      { label: "北区", total: "6496265" },
      { label: "西区", total: "9537361" },
    ],
    sentence: (region: string, total: string, marker: number) =>
      `${region} 2026 年的销售额为 ${Number(total).toLocaleString("zh-CN")} 英镑[^${marker}]。`,
    done: "已写下两个地区的合计。",
  },
} as const;

type Language = keyof typeof CASES;

/** Searches, cites each region's summary row, writes one sentence per region, and replies. */
function writer(language: Language) {
  const each = CASES[language];
  return scriptedModel((call: ModelCall): ScriptedReply => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: each.query } }] };
    if (!call.results.some((result) => result.tool === "cite")) {
      const passages = shownPassages(search.text);
      const citations = each.regions.map(({ label, total }, index) => {
        const passage = passages.find((shown) =>
          shown.text.split("\n").some((line) => line.startsWith(label) && line.includes(total)),
        );
        const quote = passage?.text
          .split("\n")
          .find((line) => line.startsWith(label) && line.includes(total));
        return { marker: index + 1, passage: passage?.id, quote };
      });
      return { calls: [{ tool: "cite", input: { citations } }] };
    }
    if (!call.results.some((result) => result.tool === "add_to_mind")) {
      const content = each.regions
        .map(({ label, total }, index) => each.sentence(label, total, index + 1))
        .join(" ");
      return { calls: [{ tool: "add_to_mind", input: { content } }] };
    }
    return { text: each.done };
  });
}

const isWriting = (prompt: readonly { role: string; content: unknown }[]) => {
  const system = prompt
    .filter((message) => message.role === "system")
    .map((message) => String(message.content))
    .join("\n");
  const text = JSON.stringify(prompt.filter((message) => message.role !== "system"));
  return !system.startsWith("You check one sentence") && !text.includes("<task action=");
};

describe.each(LANGUAGES as Language[])("a summary row's figures, live: %s", (language) => {
  test.skipIf(KEY === undefined)(
    `each region's 2026 total is Supported, ${RUNS} run(s)`,
    { timeout: 1_800_000 },
    async () => {
      const results: { figure: string; state: string; why: string }[] = [];
      let spent = 0;
      for (let run = 0; run < RUNS; run++) {
        const scripted = writer(language);
        const createChatModel: ChatModelFactory = (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              wrapStream: async ({ doStream, params }) => {
                if (isWriting(params.prompt)) return scripted.doStream(params);
                const result = await doStream();
                if (!TRACE) return result;
                let written = "";
                const calls: unknown[] = [];
                const kept = result.stream.pipeThrough(
                  new TransformStream({
                    transform(part, controller) {
                      if (part.type === "text-delta") written += part.delta;
                      if (part.type === "tool-call")
                        calls.push({ tool: part.toolName, input: part.input });
                      controller.enqueue(part);
                    },
                    async flush() {
                      await appendFile(
                        TRACE,
                        `${JSON.stringify({ language, run, prompt: params.prompt.slice(1), written, calls })}\n`,
                      );
                    },
                  }),
                );
                return { ...result, stream: kept };
              },
            },
          });
        const core = startCore(await createTempDataFolder(), { createChatModel });
        core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
        await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
        await core.updateSettings({ user: { language } });
        const sources = await createTempDataFolder();
        const files = await writeResearchFiles(sources, language);
        const documents = await addAndProcess(core, [
          files.workbook,
          files.guide,
          files.background,
        ]);
        const folder = await core.createLibraryGroup({ name: "Northwind", description: "" });
        await core.moveToFolder({
          documentIds: documents.map((document) => document.id),
          folderId: folder.id,
        });
        const mind = await core.createMind({ title: "Northwind", folderId: folder.id });
        const client = await connectToMind(core, mind.id);
        writeMind(client, [note(language === "en" ? "Sales notes." : "销售要点。")]);
        await client.settled();
        await askAssistant(core, {
          text: CASES[language].ask,
          mindId: mind.id,
          scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
        });
        await client.settled();
        const schedule = await core.getFigureSchedule(mind.id);
        for (const { total } of CASES[language].regions) {
          const row = schedule.rows.find((each) => each.reading.value === Number(total));
          results.push({
            figure: total,
            state: row?.shown.state ?? "missing",
            why: row ? JSON.stringify(row.shown) : "",
          });
        }
        const cost = await core.getCostSummary();
        spent += cost.spent.find((money) => money.currency === "USD")?.amount ?? 0;
        await core.close();
      }
      const supported = results.filter((each) => each.state === "supported").length;
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(
          process.env.INCARNAMIND_LIVE_REPORT,
          `${[
            `## ${MODEL} · ${language} · ${RUNS} run(s) · $${spent.toFixed(4)}`,
            `supported: ${supported} of ${results.length}`,
            ...results.map((each) => `- ${each.figure} → ${each.state} ${each.why}`),
          ].join("\n")}\n\n`,
        );
      }
      expect(supported).toBe(results.length);
    },
  );
});
