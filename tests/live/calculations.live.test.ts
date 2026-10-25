/**
 * Calculated figures (#438) against real models: five Questions in English
 * and five in Chinese whose Answers work numbers out from an annual report (a
 * PDF) and a workbook, asked in the assistant through the core as the app
 * uses it. Each model runs only when its key (or, for Ollama, its name) is in
 * the environment, and is skipped otherwise, so `npx vitest run` makes no
 * request without one. The keys and models are those of
 * ./assistantAnswers.live.test.ts.
 *
 * Set INCARNAMIND_LIVE_REPORT to a file to keep what each model wrote: each
 * Answer as it reads, its figures with their formulas and inputs, and the
 * numbers it wrote that are neither quoted nor calculated.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, onTestFinished, test } from "vitest";
import type { ChatProviderKind, ConversationAnswer, Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createOllamaModels, outputTokensFor } from "../../src/core/providers/ollamaModels";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readFigures } from "../../src/shared/figures";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { xlsxPackage } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

const ACME = buildPdf([
  {
    lines: [
      "Acme Annual Report 2025",
      "Revenue was $1,482.6 million in 2025, compared with $1,231.0 million in 2024.",
      "Operating income was $312.4 million in 2025 and $251.9 million in 2024.",
      "Net income was $201.7 million in 2025, up from $170.3 million in 2024.",
    ],
  },
  {
    lines: [
      "Five-year summary (in millions, except percentages)",
      "Year 2021 2022 2023 2024 2025",
      "Revenue 802.5 917.3 1,054.8 1,231.0 1,482.6",
      "Gross margin 37.1% 37.8% 38.2% 38.9% 41.2%",
    ],
  },
  {
    lines: [
      "Revenue by segment (in millions)",
      "Segment 2025 2024",
      "North America 642.1 531.2",
      "Europe 418.3 352.9",
      "Asia Pacific 301.7 241.0",
      "Rest of world 120.5 105.9",
    ],
  },
]);

const REPORT = buildPdf([
  {
    chineseLines: [
      "合并利润表",
      "单位：万元 币种：人民币",
      "项目 2025年度 2024年度 2023年度",
      "营业收入 152,340.56 121,883.20 98,765.43",
      "营业成本 98,021.33 80,114.27 66,330.10",
      "净利润 18,442.07 14,906.55 11,230.81",
    ],
  },
]);

/** The report of #577: amounts in 万元, stated only in the table's heading. */
const CHENGHU = buildPdf([
  {
    chineseLines: [
      "澄湖科技股份有限公司2025年年度报告",
      "合并利润表",
      "单位：万元　币种：人民币",
      "项目 2025年度 2024年度",
      "营业收入 120,345.67 98,812.40",
      "营业成本 70,763.25 59,416.08",
    ],
  },
]);

/** #577: an amount asked for in a larger scale than its page's, which the model once converted itself. */
const IN_ANOTHER_SCALE = [
  "澄湖科技2025年营业收入同比增长多少？2025年的毛利率是多少？2025年营业收入合计多少亿元？",
  "What was Acme's revenue in 2025, in billions of dollars?",
];

const STYLES = [
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>`,
  `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`,
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`,
  `<borders count="1"><border><left/><right/><top/><bottom/></border></borders>`,
  `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0"/></cellXfs>`,
].join("");
const cell = (ref: string, value: string | number, percent = false) =>
  typeof value === "string"
    ? `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`
    : `<c r="${ref}"${percent ? ` s="1"` : ""}><v>${value}</v></c>`;
const row = (number: number, values: (string | number)[], percentFrom = 99) =>
  `<row r="${number}">${values.map((value, index) => cell(`${"ABCDEF"[index]}${number}`, value, index >= percentFrom)).join("")}</row>`;
const SALES = xlsxPackage({
  sheets: [
    {
      name: "区域销售",
      xml: `<sheetData>${[
        row(1, ["区域", "一季度", "二季度", "三季度", "四季度", "毛利率"]),
        row(2, ["华东", 1250.4, 1310.2, 1408.9, 1522.7, 0.31247], 5),
        row(3, ["华南", 980.1, 1012.6, 1101.3, 1170.8, 0.28713], 5),
        row(4, ["华北", 760.5, 801.9, 845.2, 902.4, 0.26158], 5),
      ].join("")}</sheetData>`,
    },
  ],
  styles: STYLES,
});

const QUESTIONS = [
  "How much did Acme's revenue grow in 2025?",
  "How did Acme's gross margin change from 2024 to 2025?",
  "What was Acme's operating margin in 2025, and how did it compare with 2024?",
  "What was Acme's compound annual growth rate of revenue from 2021 to 2025?",
  "What share of Acme's 2025 revenue came from Europe, and did Europe grow faster than Asia Pacific?",
  "公司2025年营业收入同比增长多少？",
  "公司2025年营业收入比上年增加了多少？",
  "公司2025年的毛利率是多少？比2024年变动了多少个百分点？",
  "公司近两年营业收入的复合增长率是多少？",
  "区域销售表中，华东区全年销售额合计是多少？比华北高多少？",
];

interface Live {
  name: string;
  kind: ChatProviderKind;
  apiKey: string | undefined;
  model: string;
  local: boolean;
}

const LIVE: Live[] = [
  {
    name: "Anthropic",
    kind: "anthropic",
    apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
    model:
      process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
      (catalogProvider("anthropic")?.roles.quickTasks as string),
    local: false,
  },
  {
    name: "OpenAI",
    kind: "openai",
    apiKey: process.env.INCARNAMIND_LIVE_OPENAI_KEY,
    model:
      process.env.INCARNAMIND_LIVE_OPENAI_MODEL ??
      (catalogProvider("openai")?.roles.quickTasks as string),
    local: false,
  },
  {
    name: "Ollama",
    kind: "ollama",
    apiKey: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ? "" : undefined,
    model: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ?? "",
    local: true,
  },
  {
    name: "Ollama cloud",
    kind: "ollama",
    apiKey: process.env.INCARNAMIND_LIVE_OLLAMA_CLOUD_MODEL ? "" : undefined,
    model: process.env.INCARNAMIND_LIVE_OLLAMA_CLOUD_MODEL ?? "",
    local: false,
  },
];

/** A core with `live`'s model as its chat model, and `files` added as Documents. */
async function liveCore(
  live: Live,
  files: readonly { name: string; contents: Uint8Array | string }[],
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: createAiSdkChatModel,
    ...(live.kind === "ollama" && {
      ollamaModels: live.local
        ? {
            ...createOllamaModels(),
            async describe(baseUrl, model) {
              const profile = await createOllamaModels().describe(baseUrl, model);
              if (!profile) return null;
              const numCtx = Math.min(profile.settings.numCtx, 8_192);
              const outputTokens = outputTokensFor(numCtx, profile.settings.think);
              return { ...profile, settings: { ...profile.settings, numCtx, outputTokens } };
            },
          }
        : createOllamaModels(),
    }),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.saveChatProvider({
    kind: live.kind,
    ...(live.apiKey && { apiKey: live.apiKey }),
    modelId: live.model,
  });
  if (live.local) await core.setLocalOnly(true);
  const sources = await createTempDataFolder();
  await addAndProcess(
    core,
    await Promise.all(files.map((file) => writeSourceFile(sources, file.name, file.contents))),
  );
  return core;
}

/** Keeps what a model wrote, when INCARNAMIND_LIVE_REPORT names a file. */
function keepReport(report: string[]) {
  onTestFinished(async () => {
    if (process.env.INCARNAMIND_LIVE_REPORT)
      await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
  });
}

/** An Answer as the report keeps it: how it ended, what it reads, what it wrote, and its figures. */
function reported(question: string, answer: ConversationAnswer, seconds: number): string[] {
  const language = /\p{Script=Han}/u.test(question) ? "zh-CN" : "en";
  const shown = textOf(answerBlocks(answer)).replace(/\s+/g, " ").trim();
  const call = answer.toolCalls.find((each) => each.tool === "calculate");
  return [
    `### ${question}`,
    `${answer.status}${answer.errorKind ? ` (${answer.errorKind})` : ""}, ${answer.citationSupport}, ${seconds.toFixed(1)} s, ${answer.citations.length} Citations, ${answer.figures.length} figures${call?.uncalculated ? `, ${call.uncalculated} couldn't be calculated` : ""}`,
    "",
    `> ${shown}`,
    "",
    `Written: ${answer.text.replace(/\s+/g, " ")}`,
    "",
    ...answer.figures.map(
      (figure) =>
        `- [=${figure.marker}] ${figure.shown} = ${figure.formula} (${figure.inputs
          .map(
            (input) =>
              `${input.name}: ${input.number.chars}${input.unitStatement ? ` under "${input.unitStatement.citation.quote}"` : ""}${input.cell?.stored != null ? ` (${input.cell.stored} in ${input.cell.ref})` : ""}`,
          )
          .join("; ")})${figure.written ? `; the Answer wrote ${figure.written}` : ""}`,
    ),
    `- Neither quoted nor calculated: ${uncheckedIn(answer, shown, language).join(", ") || "none"}`,
    "",
  ];
}

/** Asks in a new conversation and waits until its Answer has ended. */
async function ask(core: Core, text: string) {
  const started = Date.now();
  const result = await core.askInConversation({ text });
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
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer, seconds: (Date.now() - started) / 1000 };
}

const textOf = (nodes: readonly NodeJSON[]): string =>
  nodes
    .map((node) => (node.type === "text" ? (node.text ?? "") : `${textOf(node.content ?? [])} `))
    .join("");

/**
 * The numbers an Answer wrote that are neither in its Citations' quotes nor its
 * calculated figures: a rough look at what #442 will mark.
 */
function uncheckedIn(answer: ConversationAnswer, shown: string, language: string): string[] {
  const quoted = answer.citations.flatMap((citation) =>
    readFigures(citation.quote, { language }).map((figure) => figure.value),
  );
  const calculated = answer.figures.map((figure) => figure.shown);
  return readFigures(shown, { language })
    .filter(
      (figure) =>
        !calculated.some((each) => each.includes(figure.chars)) &&
        !quoted.some((value) => Math.abs(value - figure.value) <= 1e-6 * Math.abs(value)),
    )
    .map((figure) => figure.chars);
}

describe.each(LIVE)("Calculated figures, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: Answers that work numbers out give them as calculated figures`,
    { timeout: 1_800_000 },
    async () => {
      const core = await liveCore(live, [
        { name: "Acme Annual Report 2025.pdf", contents: ACME },
        { name: "某公司2025年年度报告.pdf", contents: REPORT },
        { name: "区域销售.xlsx", contents: SALES },
      ]);
      const report: string[] = [`## ${live.name} · ${live.model}`];
      keepReport(report);
      let calculated = 0;
      for (const question of QUESTIONS) {
        const { answer, seconds } = await ask(core, question);
        calculated += answer.figures.length;
        report.push(...reported(question, answer, seconds));
        expect(answer.status, answer.errorMessage ?? "").toBe("done");
      }
      // Only models the catalog offers calculate get it (ADR-0021); the others answer as before.
      if (live.kind === "anthropic" || live.kind === "openai")
        expect(calculated).toBeGreaterThan(0);
      else expect(calculated).toBe(0);
    },
  );
});

describe.each(LIVE)("An amount asked for in another scale, live: $name (#577)", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: 万元 asked for in 亿元, and millions in billions, never come out 10,000 or 1,000 times too small`,
    { timeout: 600_000 },
    async () => {
      const core = await liveCore(live, [
        { name: "澄湖科技2025年年度报告.pdf", contents: CHENGHU },
        { name: "Acme Annual Report 2025.pdf", contents: ACME },
      ]);
      const report: string[] = [`## #577 · ${live.name} · ${live.model}`];
      keepReport(report);
      for (const question of IN_ANOTHER_SCALE) {
        const { answer, seconds } = await ask(core, question);
        report.push(...reported(question, answer, seconds));
        expect(answer.status, answer.errorMessage ?? "").toBe("done");
        const shown = textOf(answerBlocks(answer));
        expect(shown).not.toMatch(/(万|亿)元?\s*(万|亿)元|(million|billion)\s+(million|billion)/);
        for (const figure of answer.figures.filter((each) => typeof each.value === "number"))
          expect([120_345.67, 1_482_600], figure.formula).not.toContainEqual(
            expect.closeTo(figure.value as number, 2),
          );
      }
    },
  );
});
