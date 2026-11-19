/**
 * Held-out pairs for a change between two percentages (#3408): a savings bank, a ferry operator, a
 * hardware retailer and a council in English, and a bank, a courier, a furniture maker and a
 * district in Chinese, invented for the evaluation. Each pair is one change written twice: in
 * `…-points` as the wrong figure, a difference of percentage points written as a percent, or (the
 * mirror) a relative change written as points, which the Document's figures make false, so it is
 * Contradicted and never Supported; in `…-points-right` as it is, in points or as the true relative
 * change, which is Supported. The two halves are Notes of their own, so a right sentence is never
 * above its twin as context. Written before any change to the check's instructions was run; none is
 * an example in them, nor a sentence of the other sets.
 *
 * - A rate's fall and rise: arrears and the bad loans ratio; the load factor and the next-day
 *   delivery rate.
 * - An interest rate, right in basis points.
 * - A share of a total, right as the relative change.
 * - A margin, right as the relative change.
 * - A market share.
 * - The mirror: a relative change the Document gives, written as points.
 * - Points the Document itself gives, written as a percent.
 */
import type { LibraryDocument, RepeatSentence, RepeatSet } from "./cases";

const sentencesOf =
  (kind: RepeatSentence["kind"], expected: RepeatSentence["expected"]) =>
  (list: readonly (readonly [string, string])[]): RepeatSentence[] =>
    list.map(([key, text]) => ({ key, kind, expected, text }));

const wrong = sentencesOf("wrong-figure", "contradicted");
const right = sentencesOf("paraphrase", "supported");

export const PERCENT_POINT_SETS_OF = {
  en: ["en-points", "en-points-right"],
  zh: ["zh-points", "zh-points-right"],
} as const;

export const PERCENT_POINT_DOCUMENTS: readonly LibraryDocument[] = [
  {
    language: "en",
    file: "Hollin Vale Savings Bank - Annual Review 2025.pdf",
    onlyFor: PERCENT_POINT_SETS_OF.en,
    pages: [
      {
        lines: [
          "HOLLIN VALE SAVINGS BANK - ANNUAL REVIEW 2025",
          "Hollin Vale Savings Bank serves 46,000 members from nine branches.",
          "1. Lending",
          "Mortgage lending grew to 1,214 million pounds.",
          "The share of mortgage accounts in arrears fell from 3.8% at the end of 2024 to 2.3% at the end of 2025.",
          "2. Savings",
          "In September 2025 the rate on the two-year fixed saver rose from 3.60% to 4.10%.",
          "Members held 1,380 million pounds in savings at the year end.",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Orrin Sound Ferries - Operating Report 2025.pdf",
    onlyFor: PERCENT_POINT_SETS_OF.en,
    pages: [
      {
        lines: [
          "ORRIN SOUND FERRIES - OPERATING REPORT 2025",
          "Orrin Sound Ferries runs four routes between the mainland and the islands.",
          "1. Passengers",
          "The ferries carried 812,000 passengers in 2025.",
          "The load factor, the share of seats filled, was 67.0% in 2025, against 61.5% in 2024.",
          "2. Bookings",
          "Bookings made online were 58.5% of all bookings in 2025, against 52.0% in 2024.",
          "3. Fleet",
          "A fifth ferry joins the fleet in 2027.",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Glasswick Hardware plc - Half-year Statement 2025.pdf",
    onlyFor: PERCENT_POINT_SETS_OF.en,
    pages: [
      {
        lines: [
          "GLASSWICK HARDWARE PLC - HALF-YEAR STATEMENT",
          "Six months to 30 June 2025",
          "Revenue was 184.6 million pounds, against 171.2 million pounds in the first half of 2024.",
          "Operating margin was 10.0% in the half, down from 12.5% in the first half of 2024.",
          "Glasswick's share of the UK trade hardware market was 7.2% in the half, against 6.4% a year earlier.",
          "The interim dividend is 3.1 pence a share.",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Brackmoor District Council - Waste and Recycling 2025.pdf",
    onlyFor: PERCENT_POINT_SETS_OF.en,
    pages: [
      {
        lines: [
          "BRACKMOOR DISTRICT COUNCIL - WASTE AND RECYCLING REPORT 2025",
          "The council collects waste from 58,300 households.",
          "1. Recycling",
          "The recycling rate rose from 40.0% in 2024 to 46.0% in 2025, a rise of 15% on its 2024 level.",
          "2. Garden waste",
          "The share of households using the garden waste service rose 3.2 percentage points in 2025, to 27.9%.",
          "3. Fly-tipping",
          "Reports of fly-tipping fell to 1,140.",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "青禾农商银行2025年经营报告.pdf",
    onlyFor: PERCENT_POINT_SETS_OF.zh,
    pages: [
      {
        chineseLines: [
          "青禾农商银行2025年经营报告",
          "青禾农商银行在全县设有营业网点28个。",
          "一、资产质量：不良贷款率由2024年末的2.15%降至2025年末的1.65%。",
          "二、存款：2025年10月起，一年期定期存款利率由1.75%下调至1.45%。",
          "三、贷款：各项贷款余额达到186.4亿元。",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "澜舟快运2025年运营简报.pdf",
    onlyFor: PERCENT_POINT_SETS_OF.zh,
    pages: [
      {
        chineseLines: [
          "澜舟快运2025年运营简报",
          "澜舟快运在华南地区运营分拣中心6个。",
          "一、时效：2025年次日送达率为67.4%，2024年为61.0%。",
          "二、渠道：线上下单占全部订单的比例由2024年的62.5%提高到2025年的75.0%。",
          "三、车队：新能源货车增至1,240辆。",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "瑞川家居2025年年度报告摘要.pdf",
    onlyFor: PERCENT_POINT_SETS_OF.zh,
    pages: [
      {
        chineseLines: [
          "瑞川家居股份有限公司2025年年度报告摘要",
          "公司主营实木家具，在全国设有门店312家。",
          "一、盈利：2025年营业收入为58.6亿元；净利率由2024年的8.0%降至2025年的6.0%。",
          "二、市场：公司在华东地区实木家具市场的占有率由2024年的14.0%提升至2025年的16.8%。",
          "三、分红：每10股派发现金红利2.5元。",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "鹭洲新区2025年垃圾分类工作总结.pdf",
    onlyFor: PERCENT_POINT_SETS_OF.zh,
    pages: [
      {
        chineseLines: [
          "鹭洲新区2025年垃圾分类工作总结",
          "全区共有居民小区146个。",
          "一、回收利用：生活垃圾回收利用率由2024年的32%提高到2025年的40%，较上年提高25%。",
          "二、居民参与：居民分类投放参与率提高4.5个百分点，达到71.5%。",
          "三、设施：新建智能回收站58座。",
        ],
      },
    ],
  },
];

export const PERCENT_POINT_SETS: readonly RepeatSet[] = [
  {
    id: "en-points",
    language: "en",
    mind: "Figures for the board",
    sentences: wrong([
      ["rate-fall", "Hollin Vale's mortgage arrears rate fell 1.5% in 2025."],
      [
        "interest",
        "Hollin Vale raised the rate on its two-year fixed saver by 0.5% in September 2025.",
      ],
      ["rate-rise", "Orrin Sound Ferries' load factor rose 5.5% in 2025."],
      ["share", "The share of Orrin Sound Ferries bookings made online rose 6.5% in 2025."],
      ["margin", "Glasswick Hardware's operating margin fell 2.5% in the first half of 2025."],
      [
        "market-share",
        "Glasswick Hardware's share of the UK trade hardware market rose 0.8% in the first half of 2025.",
      ],
      ["mirror", "Brackmoor's recycling rate rose 15 percentage points in 2025."],
      [
        "stated-points",
        "The share of Brackmoor households using the garden waste service rose 3.2% in 2025.",
      ],
    ]),
  },
  {
    id: "en-points-right",
    language: "en",
    mind: "Figures for the board, checked",
    sentences: right([
      ["rate-fall", "Hollin Vale's mortgage arrears rate fell 1.5 percentage points in 2025."],
      [
        "interest",
        "Hollin Vale raised the rate on its two-year fixed saver by 50 basis points in September 2025.",
      ],
      ["rate-rise", "Orrin Sound Ferries' load factor rose 5.5 percentage points in 2025."],
      ["share", "The share of Orrin Sound Ferries bookings made online rose 12.5% in 2025."],
      ["margin", "Glasswick Hardware's operating margin fell 20% in the first half of 2025."],
      [
        "market-share",
        "Glasswick Hardware's share of the UK trade hardware market rose 0.8 percentage points in the first half of 2025.",
      ],
      ["mirror", "Brackmoor's recycling rate rose 6 percentage points in 2025."],
      [
        "stated-points",
        "The share of Brackmoor households using the garden waste service rose 3.2 points in 2025, to 27.9%.",
      ],
    ]),
  },
  {
    id: "zh-points",
    language: "zh-CN",
    mind: "董事会数据要点",
    sentences: wrong([
      ["rate-fall", "青禾农商银行2025年不良贷款率下降了0.5%。"],
      ["interest", "青禾农商银行2025年10月将一年期定期存款利率下调了0.3%。"],
      ["rate-rise", "澜舟快运2025年次日送达率比上年上升6.4%。"],
      ["share", "澜舟快运线上下单占全部订单的比例2025年提高了12.5%。"],
      ["margin", "瑞川家居2025年净利率比上年下降了2%。"],
      ["market-share", "瑞川家居2025年在华东地区实木家具市场的占有率提升了2.8%。"],
      ["mirror", "鹭洲新区2025年生活垃圾回收利用率提高了25个百分点。"],
      ["stated-points", "鹭洲新区2025年居民分类投放参与率提高了4.5%。"],
    ]),
  },
  {
    id: "zh-points-right",
    language: "zh-CN",
    mind: "董事会数据要点（已核对）",
    sentences: right([
      ["rate-fall", "青禾农商银行2025年不良贷款率下降了0.5个百分点。"],
      ["interest", "青禾农商银行2025年10月将一年期定期存款利率下调了30个基点。"],
      ["rate-rise", "澜舟快运2025年次日送达率比上年上升6.4个百分点。"],
      ["share", "澜舟快运线上下单占全部订单的比例2025年比上年提高了20%。"],
      ["margin", "瑞川家居2025年净利率比上年下降了25%。"],
      ["market-share", "瑞川家居2025年在华东地区实木家具市场的占有率提升了2.8个百分点。"],
      ["mirror", "鹭洲新区2025年生活垃圾回收利用率提高了8个百分点。"],
      ["stated-points", "鹭洲新区2025年居民分类投放参与率提高了4.5个百分点，达到71.5%。"],
    ]),
  },
];
