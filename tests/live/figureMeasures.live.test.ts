/**
 * The same number about another measure, on real models (#2255): 20 held-out pairs, 10 in English
 * and 10 in Chinese, each the right figure beside a sentence that gives the same number for a
 * measure the Document never states ("Insurance cost £14.2m" beside "Fuel costs were £14.2m"). A
 * wrong measure must never be Supported, as a figure or as a sentence, or the run fails; how many
 * right figures stay Supported is reported. Beside them, five sentences a language each give two
 * figures, each the number the Document states for the other's measure (#2187's review found the
 * check binding each to the other's quote): neither figure, nor the sentence, may be Supported.
 * The measures here are none of the check's own examples.
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY, so `npx vitest run` makes no request without one.
 *
 * - INCARNAMIND_LIVE_ANTHROPIC_MODEL: the model (Claude Haiku 5.5 when unset).
 * - INCARNAMIND_LIVE_LANGUAGES: "en", "zh" or both ("en,zh" when unset).
 * - INCARNAMIND_LIVE_REPORT: a file to keep each run's verdicts, requests, tokens and cost.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? catalogProvider("anthropic")?.roles.quickTasks;
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh").split(",");

/** A sentence whose figure the Document states, and one that gives the same number for another measure. */
type Pair = [right: string, wrong: string];

interface Pack {
  document: { name: string; text: string };
  pairs: Pair[];
  swaps: string[];
}

const PACKS: Record<string, Pack> = {
  en: {
    document: {
      name: "Harbourline Logistics annual review 2025.md",
      text: [
        "# Harbourline Logistics: annual review 2025",
        "",
        "Freight volumes rose 7% in 2025 as two new retail contracts started.",
        "",
        "At the end of 2025 the company employed 1,840 drivers.",
        "",
        "Fuel costs were £14.2m for the year, helped by lower diesel prices.",
        "",
        "Customer complaints fell 18% compared with 2024.",
        "",
        "The average delivery took 2.4 days from order to doorstep.",
        "",
        "The fleet drove 96 million kilometres over the year.",
        "",
        "Carbon emissions per tonne moved fell 11%.",
        "",
        "The board proposes a final dividend of 6.5p per share.",
        "",
        "Capital expenditure was £38m, mostly on electric vans.",
        "",
        "| Depot | On-time rate |",
        "| --- | --- |",
        "| Felixstowe | 94% |",
        "| Leeds | 89% |",
        "",
      ].join("\n"),
    },
    pairs: [
      ["In 2025 freight volumes grew by 7%.", "In 2025 warehouse headcount grew by 7%."],
      [
        "Harbourline employed 1,840 drivers at the end of 2025.",
        "Harbourline owned 1,840 trailers at the end of 2025.",
      ],
      ["Fuel cost Harbourline £14.2m in 2025.", "Insurance cost Harbourline £14.2m in 2025."],
      ["Customer complaints fell 18% from 2024.", "Late deliveries fell 18% from 2024."],
      [
        "An average delivery took 2.4 days in 2025.",
        "Customers took 2.4 days on average to pay their invoices in 2025.",
      ],
      [
        "The fleet covered 96 million kilometres in 2025.",
        "Rail partners carried Harbourline's freight 96 million kilometres in 2025.",
      ],
      ["Carbon emissions per tonne fell 11% in 2025.", "Water use per tonne fell 11% in 2025."],
      ["The final dividend is 6.5p per share.", "Earnings were 6.5p per share."],
      ["Capital expenditure came to £38m in 2025.", "Free cash flow came to £38m in 2025."],
      [
        "Felixstowe's on-time rate was 94% in 2025.",
        "Felixstowe depot's space occupancy was 94% in 2025.",
      ],
    ],
    swaps: [
      "Fuel costs were £38m and capital expenditure was £14.2m in 2025.",
      "In 2025 freight volumes rose 11% and carbon emissions per tonne fell 7%.",
      "In 2025 Felixstowe's on-time rate was 89% and Leeds's was 94%.",
      "An average delivery took 6.5 days, and the final dividend is 2.4p per share.",
      "Customer complaints fell 11% and carbon emissions per tonne fell 18% in 2025.",
    ],
  },
  zh: {
    document: {
      name: "明川物流2025年度报告.md",
      text: [
        "# 明川物流2025年度报告",
        "",
        "2025年两份零售合同开始执行，货运量增长7%。",
        "",
        "截至2025年末，公司共有司机1,840名。",
        "",
        "受柴油价格下降带动，全年燃油成本为1,420万元。",
        "",
        "客户投诉较2024年下降18%。",
        "",
        "从下单到送达，平均每单配送用时2.4天。",
        "",
        "车队全年行驶9,600万公里。",
        "",
        "每吨货物的碳排放下降11%。",
        "",
        "董事会建议派发末期股息每股0.65元。",
        "",
        "资本开支为3,800万元，主要用于电动货车。",
        "",
        "| 仓库 | 准时率 |",
        "| --- | --- |",
        "| 苏州 | 94% |",
        "| 成都 | 89% |",
        "",
      ].join("\n"),
    },
    pairs: [
      ["明川物流2025年货运量增长了7%。", "明川物流2025年仓库员工人数增长了7%。"],
      ["2025年末公司有1,840名司机。", "2025年末公司有1,840辆挂车。"],
      ["2025年燃油成本为1,420万元。", "2025年保险费用为1,420万元。"],
      ["客户投诉比2024年减少了18%。", "延误交付比2024年减少了18%。"],
      ["2025年平均配送用时为2.4天。", "2025年客户平均付款周期为2.4天。"],
      ["车队2025年共行驶9,600万公里。", "铁路合作方2025年为明川物流运输货物9,600万公里。"],
      ["2025年每吨货物的碳排放下降了11%。", "2025年每吨货物的用水量下降了11%。"],
      ["末期股息为每股0.65元。", "每股收益为0.65元。"],
      ["2025年资本开支为3,800万元。", "2025年自由现金流为3,800万元。"],
      ["苏州仓库2025年准时率为94%。", "苏州仓库2025年仓位使用率为94%。"],
    ],
    swaps: [
      "2025年燃油成本为3,800万元，资本开支为1,420万元。",
      "2025年货运量增长11%，每吨货物的碳排放下降7%。",
      "苏州仓库2025年准时率为89%，成都仓库为94%。",
      "平均每单配送用时0.65天，末期股息为每股2.4元。",
      "客户投诉下降11%，每吨货物的碳排放下降18%。",
    ],
  },
};

const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [{ type: "text", text: value }],
});

interface Seen {
  sentence: string;
  state: string;
  figures: string[];
  why: string | null;
}

for (const language of LANGUAGES) {
  const pack = PACKS[language];
  if (!pack) continue;
  test.skipIf(!KEY || !MODEL)(
    `an equal number about another measure is never Supported (${language})`,
    { timeout: 3_600_000 },
    async () => {
      expect(pack.pairs).toHaveLength(10);
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.updateSettings({ user: { language: language === "zh" ? "zh-CN" : "en" } });
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL ?? "" });
      const sources = await createTempDataFolder();
      await addAndProcess(core, [
        await writeSourceFile(sources, pack.document.name, pack.document.text),
      ]);
      const mind = await core.createMind({ title: "Results points" });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [...pack.pairs.flat(), ...pack.swaps].map(paragraph));
      await client.settled();
      const result = await core.checkMind({ requestId: "measures", mindId: mind.id, mode: "all" });
      await client.settled();
      const seen = new Map<string, Seen>(
        claimSpans(readMind(client)).map(({ sentence, check }) => [
          sentence.text.trim(),
          {
            sentence: sentence.text.trim(),
            state: check.state,
            figures: (check.figures ?? []).map((figure) => figure.state),
            why: check.unsupported?.reason ?? null,
          },
        ]),
      );
      const of = (sentence: string): Seen =>
        seen.get(sentence) ?? { sentence, state: "missing", figures: [], why: null };
      const wrong = pack.pairs.map(([, sentence]) => of(sentence));
      const right = pack.pairs.map(([sentence]) => of(sentence));
      const swaps = pack.swaps.map(of);
      const supported = (each: Seen) =>
        each.state === "supported" || each.figures.includes("supported");
      const usage = queryDatabase<{
        requests: number;
        input: number;
        cached: number;
        written: number;
        output: number;
        cost: number;
      }>(
        dataDir,
        `SELECT count(*) AS requests, coalesce(sum(input_tokens), 0) AS input,
           coalesce(sum(cached_input_tokens), 0) AS cached,
           coalesce(sum(cache_write_tokens), 0) AS written,
           coalesce(sum(output_tokens), 0) AS output, coalesce(sum(cost), 0) AS cost
         FROM model_requests WHERE deleted_at IS NULL AND status = 'settled'`,
      )[0];
      core.close();
      const report = {
        language,
        model: MODEL,
        result: result.kind,
        wrongSupported: wrong.filter(supported).length,
        rightSupported: right.filter((each) => each.state === "supported").length,
        swapsSupported: swaps.filter(supported).length,
        wrong,
        right,
        swaps,
        usage,
      };
      if (process.env.INCARNAMIND_LIVE_REPORT)
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${JSON.stringify(report)}\n`);
      expect([...wrong, ...swaps].filter(supported), JSON.stringify(report)).toEqual([]);
    },
  );
}
