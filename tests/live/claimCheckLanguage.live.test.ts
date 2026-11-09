/**
 * A claim check's sentence is written in the interface's language (#701, #2081), against Claude
 * on the Anthropic key. Runs only with the key in the environment (INCARNAMIND_LIVE_ANTHROPIC_KEY;
 * the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku 5.5 by default), and makes no request
 * without one. INCARNAMIND_LIVE_REPORT keeps what each run said.
 *
 * Each explanation the card shows (a Contradicted card's sentence, an Unsupported card's reason)
 * is read by its grammar (`explanationLanguage`): English around Chinese labels and units is
 * English, a Chinese sentence naming an English company is Chinese, and one it can't tell fails.
 * Every claim states a wrong figure, so none comes back Supported, and a Contradicted sentence
 * gives the Document's own value. The held-out sets, and the sets whose Document is in the other
 * language, are no prompt's examples.
 */
import { appendFile, utimes } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { type ClaimCheckResult, createAiSdkChatModel } from "../../src/core";
import { explanationLanguage } from "../../src/core/answers/checks/explanations";
import type { Language } from "../../src/core/language";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

interface Claim {
  text: string;
  /** The Document's own value, as a Contradicted sentence about it writes it in either language. */
  value: RegExp;
}

interface ClaimSet {
  title: string;
  language: Language;
  documents: readonly { name: string; contents: string }[];
  claims: readonly Claim[];
}

const HALDEN_EN =
  "# Halden annual figures\n\n| Year | Revenue (GBP m) | Operating profit (GBP m) |\n|---|---|---|\n| FY2022 | 1,142.0 | 151.2 |\n| FY2023 | 1,180.4 | 160.9 |\n| FY2024 | 1,226.7 | 171.6 |\n";
const HALDEN_ZH =
  "# 哈尔登年度数据\n\n| 年度 | 收入（百万英镑） | 营业利润（百万英镑） |\n|---|---|---|\n| 2022 财年 | 1,142.0 | 151.2 |\n| 2023 财年 | 1,180.4 | 160.9 |\n| 2024 财年 | 1,226.7 | 171.6 |\n";

const SETS: readonly ClaimSet[] = [
  {
    title: "five checks",
    language: "en",
    documents: [{ name: "Halden.md", contents: HALDEN_EN }],
    claims: [
      { text: "Operating profit rose to GBP 178.6 million in FY2024.", value: /171\.6/ },
      { text: "Revenue in FY2023 was GBP 1,210.4 million.", value: /1,?180\.4/ },
      { text: "Operating profit in FY2022 was GBP 140.2 million.", value: /151\.2/ },
      { text: "Revenue reached GBP 1,300.0 million in FY2024.", value: /1,?226\.7/ },
      { text: "Operating profit in FY2023 was GBP 165.0 million.", value: /160\.9/ },
    ],
  },
  {
    title: "five checks",
    language: "zh-CN",
    documents: [{ name: "哈尔登.md", contents: HALDEN_ZH }],
    claims: [
      { text: "2024 财年营业利润增至 1.786 亿英镑。", value: /171\.6|1\.716/ },
      { text: "2023 财年收入为 12.104 亿英镑。", value: /1,?180\.4|11\.804/ },
      { text: "2022 财年营业利润为 1.402 亿英镑。", value: /151\.2|1\.512/ },
      { text: "2024 财年收入达到 13 亿英镑。", value: /1,?226\.7|12\.267|12\.27/ },
      { text: "2023 财年营业利润为 1.65 亿英镑。", value: /160\.9|1\.609/ },
    ],
  },
  {
    title: "held-out checks",
    language: "en",
    documents: [
      {
        name: "Brackley Dairy.md",
        contents:
          "# Brackley Dairy, year to March 2026\n\n| Measure | FY2025 | FY2026 |\n|---|---|---|\n| Milk processed (million litres) | 312.5 | 329.8 |\n| Herd size | 4,120 | 4,380 |\n| Export sales (EUR m) | 46.3 | 51.7 |\n",
      },
    ],
    claims: [
      { text: "Brackley processed 341.2 million litres of milk in FY2026.", value: /329\.8/ },
      { text: "Brackley's herd numbered 4,650 in FY2026.", value: /4,?380/ },
      { text: "Brackley's export sales were EUR 39.8 million in FY2025.", value: /46\.3/ },
    ],
  },
  {
    title: "held-out checks",
    language: "zh-CN",
    documents: [
      {
        name: "青石水务.md",
        contents:
          "# 青石水务 2025 年运营数据\n\n| 指标 | 2024 年 | 2025 年 |\n|---|---|---|\n| 日均供水量（万吨） | 44.8 | 46.2 |\n| 管网漏损率 | 10.4% | 9.8% |\n| 供水营收（亿元） | 18.6 | 19.3 |\n",
      },
    ],
    claims: [
      { text: "青石水务 2025 年日均供水量为 52.6 万吨。", value: /46\.2/ },
      { text: "青石水务 2025 年管网漏损率降至 7.9%。", value: /9\.8/ },
      { text: "青石水务 2024 年供水营收为 21.4 亿元。", value: /18\.6/ },
    ],
  },
  {
    title: "checks against a Document in English",
    language: "zh-CN",
    documents: [
      {
        name: "Fenwick Rail 2025.md",
        contents:
          "# Fenwick Rail, 2025\n\nFenwick Rail carried 41.3 million passengers in 2025, and 88.4% of its trains ran on time. The depot upgrade cost £14.2 million.\n",
      },
      {
        name: "Steering group notes.md",
        contents:
          "# Steering group notes\n\nThe harbour project budget was raised to 2.6 million pounds on 14 October 2026.\n",
      },
    ],
    claims: [
      { text: "Fenwick Rail 2025 年运送乘客 4,600 万人次。", value: /41\.3|4,?130/ },
      { text: "Fenwick Rail 2025 年的列车准点率为 91.2%。", value: /88\.4/ },
      { text: "Fenwick Rail 的车辆段升级耗资 1,620 万英镑。", value: /14\.2|1,?420/ },
      { text: "海港项目的预算为二百四十万英镑。", value: /2\.6|260|二百六十/ },
    ],
  },
  {
    title: "checks against a Document in Chinese",
    language: "en",
    documents: [
      {
        name: "华东物流 2025.md",
        contents:
          "# 华东物流 2025 年数据\n\n华东物流 2025 年处理包裹 3.8 亿件，准时送达率为 96.1%。新分拣中心投资 12.5 亿元。\n",
      },
    ],
    claims: [
      { text: "华东物流 handled 420 million parcels in 2025.", value: /3\.8|380/ },
      { text: "华东物流's on-time delivery rate was 93.5% in 2025.", value: /96\.1/ },
      { text: "华东物流's new sorting centre cost CNY 9.8 billion.", value: /12\.5|1\.25/ },
    ],
  },
];

/** What the card shows as the reason: a Contradicted card's sentence, an Unsupported card's why. */
const explanationOf = (result: ClaimCheckResult): string | null =>
  result.verdict === "contradicted"
    ? result.says
    : result.verdict === "unsupported"
      ? (result.unsupported?.reason ?? null)
      : null;

const EXPECTED: Record<Language, string> = { en: "English", "zh-CN": "Chinese" };

describe.each(SETS)("claim check language, live: $title, $language", (set) => {
  test.skipIf(KEY === undefined)(
    `${set.title} in ${set.language} come back in ${EXPECTED[set.language]}`,
    { timeout: 900_000 },
    async () => {
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      await core.updateSettings({ user: { language: set.language } });
      const sources = await createTempDataFolder();
      const files = await Promise.all(
        set.documents.map(async (document) => {
          const file = await writeSourceFile(sources, document.name, document.contents);
          // A file dated 1 January 2000, as a placeholder date would show: it is never to be repeated (#821).
          await utimes(file, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
          return file;
        }),
      );
      await addAndProcess(core, files);
      const lines: string[] = [`## ${MODEL} · ${set.title} · ${set.language}`];
      const wrong: string[] = [];
      let explained = 0;
      for (const claim of set.claims) {
        const result = await core.checkClaim({ claim: claim.text });
        const explanation = explanationOf(result);
        const language = explanation === null ? null : explanationLanguage(explanation);
        const correction =
          result.verdict === "contradicted"
            ? (result.correction?.choices[0]?.wording ?? null)
            : null;
        lines.push(
          `- ${claim.text} → ${result.verdict}${result.verdict === "not-checked" ? ` (${result.reason})` : ""}: ${explanation ?? "(none)"} [${language ?? "unclassified"}]${correction ? ` · fix: ${correction}` : ""}`,
        );
        if (result.verdict === "supported") wrong.push(`${claim.text}: Supported`);
        if (explanation === null) continue;
        explained++;
        if (language !== set.language) {
          wrong.push(`${claim.text}: ${language ?? "unclassified"}: ${explanation}`);
        }
        if (
          result.verdict === "contradicted" &&
          !claim.value.test(explanation.replace(/\s/g, ""))
        ) {
          wrong.push(`${claim.text}: no Document value: ${explanation}`);
        }
        expect(explanation, "no date, and none of our words for how it was found").not.toMatch(
          /2000|\bindex|passage|metadata|索引|段落|元数据/i,
        );
      }
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n\n`);
      }
      expect(explained, "an explanation to read").toBeGreaterThan(0);
      expect(wrong).toEqual([]);
    },
  );
});
