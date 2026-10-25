/**
 * Compare Documents against real models (#1798): a final workbook in GBP thousands (万元) in a
 * Unit column, beside a superseded draft PDF in GBP millions (亿元), asked for amounts in
 * millions (亿元). 310,000 GBP thousands is GBP 310 million, never GBP 310,000 million: a cell
 * gives each amount at its value, or says its scale differs from the Document, and never says so
 * of a right one. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (or INCARNAMIND_LIVE_KIMI_KEY), so
 * `npx vitest run` makes no request without one.
 *
 * - INCARNAMIND_LIVE_ANTHROPIC_MODEL: the model (Claude Haiku 5.5 when unset); Kimi's is kimi-k2.6.
 * - INCARNAMIND_LIVE_RUNS: how many tables per language (1 when unset).
 * - INCARNAMIND_LIVE_LANGUAGES: "en", "zh" or both ("en,zh" when unset).
 * - INCARNAMIND_LIVE_REPORT: a file to keep each cell, what the model was told and the counts in.
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LanguageModel, wrapLanguageModel } from "ai";
import { describe, expect, onTestFinished, test } from "vitest";
import type { ChatProviderKind, Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { comparisonCellOf } from "../../src/shared/comparisons";
import { type Figure, readFigures } from "../../src/shared/figures";
import { compare } from "../helpers/comparisons";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const FIXTURES = join(import.meta.dirname, "../fixtures/comparisons");

interface Case {
  language: "en" | "zh";
  final: string;
  draft: { name: string; contents: Uint8Array };
  questions: [string, string];
  instruction: string;
  /** The first Question's numbers as each Document writes them, with no unit: final, then draft. */
  written: { final: number[]; draft: number[] };
  /** The scale its Questions ask for: 1e6 for millions, 1e8 for 亿. */
  asked: number;
}

/** The first Question's amounts in base units: the final row's, then the draft's. */
const EXPECTED = { final: [310e6, 95e6], draft: [340e6, 80e6] };

const CASES: Case[] = [
  {
    language: "en",
    final: "Cedar Q3 2026 final.xlsx",
    draft: {
      name: "Cedar Q3 2026 draft.pdf",
      contents: buildPdf([
        {
          lines: [
            "Cedar Holdings plc: Q3 2026 results (DRAFT, 6 October 2026)",
            "Superseded by the final results approved on 20 October 2026.",
            "All amounts in GBP million unless stated otherwise.",
            "Net debt: 340. LTM adjusted EBITDA: 80.",
            "FY 2026 forecast adjusted EBITDA: 88 (forecast).",
          ],
        },
      ]),
    },
    questions: [
      "What net debt and adjusted EBITDA apply to Q3 2026 actuals, in GBP millions?",
      "What profit before tax was reported for Q3 2026, in GBP millions?",
    ],
    instruction: "Keep draft and final distinct, preserve GBP million units, exclude forecasts.",
    written: { final: [310_000, 95_000], draft: [340, 80] },
    asked: 1e6,
  },
  {
    language: "zh",
    final: "雪松控股2026年三季度终稿.xlsx",
    draft: {
      name: "雪松控股2026年三季度初稿.pdf",
      contents: buildPdf([
        {
          chineseLines: [
            "雪松控股2026年三季度业绩（初稿，2026年10月6日）",
            "已被2026年10月20日批准的终稿取代。",
            "金额单位：亿元",
            "净负债：3.4。调整后EBITDA（近十二个月）：0.8。",
            "2026年全年预测调整后EBITDA：0.88（预测）。",
          ],
        },
      ]),
    },
    questions: [
      "2026年三季度实际的净负债和调整后EBITDA分别是多少亿元？",
      "2026年三季度的税前利润是多少亿元？",
    ],
    instruction: "区分初稿和终稿，以亿元列示，不含预测。",
    written: { final: [31_000, 9_500], draft: [3.4, 0.8] },
    asked: 1e8,
  },
];

const KIMI = process.env.INCARNAMIND_LIVE_KIMI_KEY;
const LIVE: { kind: ChatProviderKind; key: string | undefined; model: string } = KIMI
  ? { kind: "kimi", key: KIMI, model: process.env.INCARNAMIND_LIVE_KIMI_MODEL ?? "kimi-k2.6" }
  : {
      kind: "anthropic",
      key: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
      model:
        process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
        (catalogProvider("anthropic")?.roles.quickTasks as string),
    };
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "1");
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh").split(",");

interface ReadCell {
  status: string;
  problem: string | null;
  message: string | null;
  text: string;
}

function cellsOf(client: MindClient): ReadCell[][] {
  const rows: ReadCell[][] = [];
  readMind(client).forEach((block) => {
    if (block.type.name !== "comparisonTable") return;
    block.forEach((row) => {
      const cells: ReadCell[] = [];
      row.forEach((cell) => {
        const { status, problem, message } = comparisonCellOf(cell.attrs);
        const text = cell.textBetween(0, cell.content.size, " ", " ");
        cells.push({ status, problem, message, text: text.replace(/\s+/g, " ").trim() });
      });
      rows.push(cells);
    });
  });
  return rows;
}

/** What an amount is worth: at its own scale, or one its words state ("80 (GBP million)"). */
function worth(figure: Figure): number[] {
  if (figure.scale !== 1) return [figure.value];
  const scaled = figure.ambiguous
    .filter((each) => each.kind === "scale")
    .flatMap((each) => each.readings)
    .filter((each) => each.scale !== 1)
    .map((each) => each.value);
  return scaled.length > 0 ? scaled : [figure.value];
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.005 * Math.abs(b);

/**
 * Each expected amount at its value ("right"); as its Document writes it, or in the scale the
 * Question asks for, with no unit at all ("as-written", "bare-in-asked-scale"); an amount 10ⁿ off
 * ("wrong-scale"); or neither.
 */
function verdictOf(
  text: string,
  expected: readonly number[],
  written: readonly number[],
  asked: number,
  language: string,
) {
  const figures = readFigures(text, { language: language === "zh" ? "zh-CN" : "en" }).filter(
    (figure) => figure.unit.kind === "plain" || figure.unit.kind === "currency",
  );
  const bare = (figure: Figure) =>
    figure.unit.kind === "plain" && figure.scale === 1 && worth(figure)[0] === figure.value;
  if (
    figures.length > 0 &&
    figures.every((figure) => bare(figure) && written.some((each) => near(figure.value, each)))
  )
    return "as-written";
  if (
    figures.length > 0 &&
    figures.every(
      (figure) => bare(figure) && expected.some((each) => near(figure.value, each / asked)),
    )
  )
    return "bare-in-asked-scale";
  const amounts = figures.map(worth);
  const offByTen = amounts.some(
    (values) =>
      !values.some((value) => expected.some((amount) => near(value, amount))) &&
      values.some((value) =>
        expected.some((amount) => {
          const power = Math.round(Math.log10(Math.abs(value / amount)));
          return power !== 0 && near(value, amount * 10 ** power);
        }),
      ),
  );
  if (offByTen) return "wrong-scale";
  return expected.every((amount) => amounts.some((values) => values.some((v) => near(v, amount))))
    ? "right"
    : "other";
}

/** A core with the live model, the fixtures added, and what the model is told of a changed scale. */
async function liveCore(item: Case): Promise<{ core: Core; told: string[] }> {
  const told: string[] = [];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: (spec) =>
      wrapLanguageModel({
        model: createAiSdkChatModel(spec) as Exclude<LanguageModel, string>,
        middleware: {
          specificationVersion: "v4",
          transformParams: async ({ params }) => {
            const last = params.prompt.at(-1);
            if (last?.role === "user") {
              const text = last.content.map((part) => (part.type === "text" ? part.text : ""));
              if (text.join("").startsWith("Your cell writes")) told.push(text.join(""));
            }
            return params;
          },
        },
      }),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.saveChatProvider({
    kind: LIVE.kind,
    apiKey: LIVE.key as string,
    modelId: LIVE.model,
    ...(LIVE.kind === "kimi" && { endpoint: "intl" }),
  });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, item.final, await readFile(join(FIXTURES, item.final))),
    await writeSourceFile(sources, item.draft.name, item.draft.contents),
  ]);
  return { core, told };
}

describe.each(CASES.filter((item) => LANGUAGES.includes(item.language)))(
  "Compare Documents keeps each amount's scale, live ($language)",
  (item) => {
    test.skipIf(LIVE.key === undefined)(
      `${LIVE.model}: ${RUNS} tables, a final in thousands beside a draft in millions`,
      { timeout: 3_600_000 },
      async () => {
        const { core, told } = await liveCore(item);
        const documents = await core.listDocuments();
        const final = documents.find((each) => each.path.endsWith(item.final));
        const draft = documents.find((each) => each.path.endsWith(item.draft.name));
        if (!final || !draft) throw new Error("The fixtures weren't added.");
        const report = [`## ${item.language} · ${LIVE.model} · ${RUNS} tables`];
        const counts: Record<string, number> = {};
        const count = (key: string) => {
          counts[key] = (counts[key] ?? 0) + 1;
        };
        onTestFinished(async () => {
          const { spent } = await core.getCostSummary();
          report.push("", `Counts: ${JSON.stringify(counts)}`, `Spent: ${JSON.stringify(spent)}`);
          if (process.env.INCARNAMIND_LIVE_REPORT)
            await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
        });
        for (let run = 1; run <= RUNS; run++) {
          const before = told.length;
          const mind = await core.createMind({ title: `Run ${run}` });
          const client = await connectToMind(core, mind.id);
          await compare(core, client, {
            mindId: mind.id,
            documentIds: [final.id, draft.id],
            questions: item.questions,
            instruction: item.instruction,
          });
          report.push(`### Table ${run}`);
          const [finalRow = [], draftRow = []] = cellsOf(client);
          for (const [name, [first, second]] of [
            ["final", finalRow],
            ["draft", draftRow],
          ] as const) {
            if (first) {
              const outcome =
                first.status === "done"
                  ? verdictOf(
                      first.text,
                      EXPECTED[name],
                      item.written[name],
                      item.asked,
                      item.language,
                    )
                  : (first.problem ?? "failed");
              count(`${name}:${outcome}`);
              const message = first.message ? ` [${first.message}]` : "";
              report.push(`- ${name} · Q1 · ${outcome}: "${first.text}"${message}`);
            }
            if (second) {
              count(`${name}:q2:${second.status === "done" ? "answered" : second.problem}`);
              report.push(`- ${name} · Q2: ${second.status} "${second.text}"`);
            }
          }
          for (const note of told.slice(before)) {
            // A note about a right amount is a false problem; one about a wrong one is a catch.
            const written = /^Your cell writes (.+?), which is/.exec(note)?.[1] ?? "";
            const right = readFigures(written, {
              language: item.language === "zh" ? "zh-CN" : "en",
            })
              .map(worth)
              .some((values) =>
                values.some((value) =>
                  [...EXPECTED.final, ...EXPECTED.draft].some((amount) => near(value, amount)),
                ),
              );
            count(right ? "told:about-a-right-amount" : "told:about-a-changed-scale");
            report.push(`  - told: ${note.split(". Write")[0]}`);
          }
        }
        expect(counts["final:wrong-scale"] ?? 0).toBe(0);
        expect(counts["draft:wrong-scale"] ?? 0).toBe(0);
        expect(counts["told:about-a-right-amount"] ?? 0).toBe(0);
      },
    );
  },
);
