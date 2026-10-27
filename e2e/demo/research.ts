/**
 * The test Documents of the recording that the shipped examples don't have: Northwind Retail's
 * monthly sales workbook, the interview guide, and the interview's background deck, written in the
 * formats a real folder holds (Excel, Word, PowerPoint). Every organisation, figure and sentence
 * here is invented, as the shipped examples are.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { docxOf, xlsxOf } from "../../tests/helpers/office";
import { para, pptxOf, sp, txBody, xfrm } from "../../tests/helpers/pptx";
import type { DemoLanguage } from "./documents";

const WORDS = {
  en: {
    workbook: "Northwind Retail · monthly sales 2025–2026",
    sheet: "Sales",
    columns: ["Month", "Region", "Channel", "Sales (£)"],
    regions: ["North", "South", "East", "West"],
    channels: ["Stores", "Online", "Wholesale"],
    summary: "2026 by region",
    summaryColumns: ["Region", "2026 sales (£)"],
    about: "About",
    guide: "Northwind Retail · expert interview guide",
    topics: [
      [
        "Store traffic",
        "Why did store traffic change after opening hours were shortened? Which visits fell most?",
      ],
      [
        "Supplier terms",
        "What payment period do suppliers offer? Have discounts or delivery terms changed?",
      ],
      ["Pricing", "Which products changed price? How did customers respond?"],
    ],
    background: "Northwind Retail · interview background",
    backgroundLines: [
      "Northwind Retail sells through stores, online and wholesale channels.",
      "The group reports in sterling, and its financial year ends in March.",
      "Separate what the expert says from the analyst's assumptions and the company documents.",
    ],
    fictional:
      "Fictional Northwind Retail test data written for IncarnaMind. No company, interview or sales figure here is real.",
  },
  "zh-CN": {
    workbook: "Northwind Retail · 2025–2026 年月度销售",
    sheet: "销售",
    columns: ["月份", "地区", "渠道", "销售额（英镑）"],
    regions: ["北区", "南区", "东区", "西区"],
    channels: ["门店", "线上", "批发"],
    summary: "2026 年分地区",
    summaryColumns: ["地区", "2026 年销售额（英镑）"],
    about: "说明",
    guide: "Northwind Retail · 专家访谈提纲",
    topics: [
      ["门店客流", "缩短营业时间后，门店客流为什么变化？哪些时段的到访减少最明显？"],
      ["供应商条款", "供应商提供多长的付款期？折扣或交货条款有没有变化？"],
      ["定价", "哪些商品调整了价格？顾客有什么反应？"],
    ],
    background: "Northwind Retail · 访谈背景",
    backgroundLines: [
      "Northwind Retail 通过门店、线上和批发渠道销售商品。",
      "集团以英镑报告，财年在三月结束。",
      "区分专家说过的话、分析师的假设以及公司文档里的内容。",
    ],
    fictional:
      "为 IncarnaMind 编写的 Northwind Retail 虚构测试资料。公司、访谈和销售数字均为虚构。",
  },
} as const;

/**
 * Each region and channel's monthly sales, in sterling, for the two years. Stores slip from
 * September 2026, when the shops began closing an hour earlier.
 */
function sales(
  regions: readonly string[],
  channels: readonly string[],
): { rows: (string | number)[][]; totals: Map<string, number> } {
  const rows: (string | number)[][] = [];
  const totals = new Map<string, number>();
  for (const year of [2025, 2026]) {
    for (let month = 1; month <= 12; month++) {
      const storesClosedEarly = year === 2026 && month >= 9;
      for (const [regionIndex, region] of regions.entries()) {
        for (const [channelIndex, channel] of channels.entries()) {
          const base = 150_000 + regionIndex * 25_000 + channelIndex * 10_000;
          const seasonal = 1 + month / 100;
          const growth = year === 2026 ? 1.08 : 1;
          const slip = storesClosedEarly && channelIndex === 0 ? 0.82 : 1;
          const sales = Math.round(base * seasonal * growth * slip);
          rows.push([`${year}-${String(month).padStart(2, "0")}`, region, channel, sales]);
          if (year === 2026) totals.set(region, (totals.get(region) ?? 0) + sales);
        }
      }
    }
  }
  return { rows, totals };
}

export interface ResearchFiles {
  workbook: string;
  guide: string;
  background: string;
  /** Each Document's name in the Library: its file's name without the extension. */
  names: { workbook: string; guide: string; background: string };
}

/** The workbook, the guide and the background deck in `folder`. Returns their paths. */
export async function writeResearchFiles(
  folder: string,
  language: DemoLanguage,
): Promise<ResearchFiles> {
  const words = WORDS[language];
  const workbook = join(folder, `${words.workbook}.xlsx`);
  const guide = join(folder, `${words.guide}.docx`);
  const background = join(folder, `${words.background}.pptx`);
  const { rows, totals } = sales(words.regions, words.channels);
  await mkdir(folder, { recursive: true });
  await writeFile(
    workbook,
    xlsxOf([
      { name: words.sheet, rows: [words.columns.slice(), ...rows] },
      {
        name: words.summary,
        rows: [
          words.summaryColumns.slice(),
          ...words.regions.map((region) => [region, totals.get(region) ?? 0]),
        ],
      },
      { name: words.about, rows: [[words.fictional]] },
    ]),
  );
  await writeFile(
    guide,
    docxOf([
      { text: words.guide, heading: 1 },
      { text: words.fictional },
      ...words.topics.flatMap(([title, question]) => [
        { text: title, heading: 2 },
        { text: question },
      ]),
    ]),
  );
  await writeFile(
    background,
    pptxOf({
      slides: [
        {
          shapes: sp({
            name: words.background,
            spPr: xfrm(457_200, 457_200, 8_229_600, 4_114_800),
            body: txBody(
              [words.background, ...words.backgroundLines, words.fictional]
                .map((text) => para(text))
                .join(""),
            ),
          }),
        },
      ],
    }),
  );
  return {
    workbook,
    guide,
    background,
    names: { workbook: words.workbook, guide: words.guide, background: words.background },
  };
}
