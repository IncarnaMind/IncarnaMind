import type { JudgementNote } from "./judgementSentences.cases";

type Line = JudgementNote["lines"][number];

/**
 * Notes laid out the way people and assistants write them (#3332): a title, sections under
 * headings, bullets, and one-line conclusions and advice that don't name what they are about,
 * since the heading or the lines above already did. Each over one invented Document.
 *
 * A line that stands alone in its paragraph is the case: a fact that names its subject by the
 * heading alone ("The average was 9 days in 2026." under "Waiting times"), its wrong twin, and
 * the writer's advice, with what the Document gives for it.
 *
 * The set is fixed: a Note is not edited once a baseline rests on it, and a new shape is a new Note.
 */
export interface StructuredNote extends Omit<JudgementNote, "lines"> {
  /** The Note from its top: a heading, the sentences of one paragraph, or a list of one-sentence items. */
  blocks: readonly (
    | { heading: string; level: 1 | 2 }
    | { paragraph: readonly Line[] }
    | { bullets: readonly Line[] }
  )[];
}

export const linesOf = (note: StructuredNote): Line[] =>
  note.blocks.flatMap((block) =>
    "paragraph" in block ? block.paragraph : "bullets" in block ? block.bullets : [],
  );

export const STRUCTURED_NOTES: readonly StructuredNote[] = [
  {
    id: "en-s1",
    language: "en",
    name: "Riverside Clinic hours",
    document:
      "Riverside Clinic opens Monday to Friday from 8:00 to 18:00. In 2026 it saw 14,600 patients, up from 13,000 in 2025. The average wait for a routine appointment was 9 days in 2026, against 6 days in 2025. Evening slots after 17:00 were fully booked on 92% of days. A patient survey in October 2026 found that 61% of respondents wanted Saturday opening. The clinic employs 4 nurses, and one of them leaves in March 2027.",
    blocks: [
      { heading: "Riverside Clinic: opening hours for 2027", level: 1 },
      {
        paragraph: [
          { sentence: "The clinic saw 14,600 patients in 2026.", expected: "right" },
          {
            sentence: "That is about 12% more than the year before.",
            expected: "right",
            worked: true,
          },
        ],
      },
      { heading: "Waiting times", level: 2 },
      { paragraph: [{ sentence: "The average was 9 days in 2026.", expected: "right" }] },
      { paragraph: [{ sentence: "A year earlier it was 16 days.", expected: "wrong" }] },
      { heading: "Evening and Saturday demand", level: 2 },
      {
        bullets: [
          { sentence: "Evening slots were fully booked on 92% of days.", expected: "right" },
          {
            sentence: "In the October survey, 61% of respondents wanted Saturday opening.",
            expected: "right",
          },
          { sentence: "The survey was run in June 2026.", expected: "wrong" },
        ],
      },
      { heading: "Staffing", level: 2 },
      {
        paragraph: [
          { sentence: "There are 4 nurses, and one leaves in March 2027.", expected: "right" },
        ],
      },
      { heading: "Recommendation", level: 2 },
      {
        paragraph: [
          { sentence: "We should open on Saturday mornings.", expected: "none", grounds: "for" },
        ],
      },
      {
        paragraph: [
          { sentence: "One more nurse will not be enough.", expected: "none", grounds: "for" },
        ],
      },
      {
        paragraph: [
          { sentence: "Review it again after six months.", expected: "none", grounds: "none" },
        ],
      },
    ],
  },
  {
    id: "en-s2",
    language: "en",
    name: "Hollin Farm irrigation log",
    document:
      "Hollin Farm's orchard has 1,200 apple trees on 8 hectares. The drip system installed in 2024 cost £38,000. Water use fell from 5,400 cubic metres in 2023 to 3,900 in 2026. The 2026 harvest was 310 tonnes, against 265 tonnes in 2023. The pump failed twice in July 2026 and each repair cost £1,150. The water licence allows 4,500 cubic metres a year and is reviewed in 2028.",
    blocks: [
      { heading: "Hollin Farm orchard: irrigation after three seasons", level: 1 },
      {
        paragraph: [
          { sentence: "The orchard has 1,200 apple trees on 8 hectares.", expected: "right" },
          { sentence: "That is 150 trees a hectare.", expected: "right", worked: true },
        ],
      },
      { heading: "Water", level: 2 },
      { paragraph: [{ sentence: "Use fell to 3,900 cubic metres in 2026.", expected: "right" }] },
      {
        paragraph: [
          {
            sentence: "That is 600 cubic metres under the licence.",
            expected: "right",
            worked: true,
          },
        ],
      },
      { paragraph: [{ sentence: "It allows 5,400 cubic metres a year.", expected: "wrong" }] },
      { heading: "Harvest", level: 2 },
      {
        bullets: [
          { sentence: "The 2026 harvest was 310 tonnes.", expected: "right" },
          { sentence: "It was 365 tonnes in 2023.", expected: "wrong" },
        ],
      },
      { heading: "Pump", level: 2 },
      { paragraph: [{ sentence: "It failed twice in July 2026.", expected: "right" }] },
      {
        paragraph: [
          {
            sentence: "The two repairs cost £2,300 together.",
            expected: "right",
            worked: true,
          },
        ],
      },
      {
        paragraph: [
          { sentence: "We should keep a spare on site.", expected: "none", grounds: "for" },
        ],
      },
      { heading: "Next steps", level: 2 },
      {
        paragraph: [
          {
            sentence: "Apply early, well before the review.",
            expected: "none",
            grounds: "for",
          },
        ],
      },
      {
        paragraph: [{ sentence: "Plant the north field next.", expected: "none", grounds: "none" }],
      },
    ],
  },
  {
    id: "zh-s1",
    language: "zh-CN",
    name: "河湾社区卫生站门诊记录",
    document:
      "河湾社区卫生站周一至周五8:00到18:00开诊。2026年接诊14,600人次，2025年为13,000人次。2026年普通门诊平均等候9天，2025年为6天。17:00以后的晚间号源有92%的日子全部约满。2026年10月的居民问卷显示，61%的受访者希望周六开诊。卫生站有4名护士，其中一名将在2027年3月离职。",
    blocks: [
      { heading: "河湾社区卫生站：2027年门诊时间", level: 1 },
      {
        paragraph: [
          { sentence: "卫生站2026年接诊14,600人次。", expected: "right" },
          { sentence: "比上一年多了约12%。", expected: "right", worked: true },
        ],
      },
      { heading: "等候时间", level: 2 },
      { paragraph: [{ sentence: "2026年平均要等9天。", expected: "right" }] },
      { paragraph: [{ sentence: "一年前是16天。", expected: "wrong" }] },
      { heading: "晚间和周六的需求", level: 2 },
      {
        bullets: [
          { sentence: "晚间号源有92%的日子全部约满。", expected: "right" },
          { sentence: "10月的问卷里，61%的受访者希望周六开诊。", expected: "right" },
          { sentence: "问卷是2026年6月做的。", expected: "wrong" },
        ],
      },
      { heading: "人手", level: 2 },
      {
        paragraph: [{ sentence: "现有4名护士，其中一名2027年3月离职。", expected: "right" }],
      },
      { heading: "建议", level: 2 },
      {
        paragraph: [{ sentence: "我们应该在周六上午开诊。", expected: "none", grounds: "for" }],
      },
      { paragraph: [{ sentence: "只补一名护士是不够的。", expected: "none", grounds: "for" }] },
      { paragraph: [{ sentence: "半年后再评估一次。", expected: "none", grounds: "none" }] },
    ],
  },
  {
    id: "zh-s2",
    language: "zh-CN",
    name: "禾岭果园灌溉记录",
    document:
      "禾岭果园有1,200棵苹果树，占地8公顷。2024年安装的滴灌系统花费38万元。用水量从2023年的5,400立方米降到2026年的3,900立方米。2026年收成310吨，2023年为265吨。水泵在2026年7月坏了两次，每次维修花费1.15万元。取水许可每年允许4,500立方米，2028年复审。",
    blocks: [
      { heading: "禾岭果园：滴灌三年后的情况", level: 1 },
      {
        paragraph: [
          { sentence: "果园有1,200棵苹果树，占地8公顷。", expected: "right" },
          { sentence: "也就是每公顷150棵。", expected: "right", worked: true },
        ],
      },
      { heading: "用水", level: 2 },
      { paragraph: [{ sentence: "2026年降到了3,900立方米。", expected: "right" }] },
      {
        paragraph: [{ sentence: "比许可的额度少600立方米。", expected: "right", worked: true }],
      },
      { paragraph: [{ sentence: "许可每年允许5,400立方米。", expected: "wrong" }] },
      { heading: "收成", level: 2 },
      {
        bullets: [
          { sentence: "2026年收成310吨。", expected: "right" },
          { sentence: "2023年是365吨。", expected: "wrong" },
        ],
      },
      { heading: "水泵", level: 2 },
      { paragraph: [{ sentence: "2026年7月坏了两次。", expected: "right" }] },
      {
        paragraph: [{ sentence: "两次维修一共花了2.3万元。", expected: "right", worked: true }],
      },
      {
        paragraph: [{ sentence: "我们应该在现场备一台备用的。", expected: "none", grounds: "for" }],
      },
      { heading: "下一步", level: 2 },
      {
        paragraph: [{ sentence: "尽早申请，别等到复审前。", expected: "none", grounds: "for" }],
      },
      {
        paragraph: [{ sentence: "接下来先种北边那块地。", expected: "none", grounds: "none" }],
      },
    ],
  },
  {
    id: "en-s3",
    language: "en",
    name: "Harbour Dairy fleet record",
    document:
      "Harbour Dairy runs 9 delivery vans. Four of them are more than ten years old. Repairs cost £21,400 in 2026, up from £12,900 in 2025. Two vans failed their annual inspection in September 2026. Diesel made up 18% of delivery costs in 2026. A new electric van is quoted at £41,000, and the council offers a grant of £8,000 a van until December 2027.",
    blocks: [
      { heading: "Harbour Dairy: the delivery fleet in 2027", level: 1 },
      {
        paragraph: [
          { sentence: "Harbour Dairy runs 9 delivery vans.", expected: "right" },
          { sentence: "Four are more than ten years old.", expected: "right" },
        ],
      },
      { heading: "Costs", level: 2 },
      { paragraph: [{ sentence: "Repairs came to £21,400 in 2026.", expected: "right" }] },
      {
        paragraph: [
          { sentence: "That is £8,500 more than in 2025.", expected: "right", worked: true },
        ],
      },
      { paragraph: [{ sentence: "They were £31,400 the year before.", expected: "wrong" }] },
      { heading: "Recommendation", level: 2 },
      {
        paragraph: [
          { sentence: "We should start replacing them now.", expected: "none", grounds: "for" },
        ],
      },
      {
        paragraph: [
          { sentence: "Order before the offer runs out.", expected: "none", grounds: "for" },
        ],
      },
      {
        paragraph: [
          {
            sentence: "Waiting another year would cost more than acting.",
            expected: "none",
            grounds: "for",
          },
        ],
      },
      { paragraph: [{ sentence: "Do it in two batches.", expected: "none", grounds: "none" }] },
    ],
  },
  {
    id: "zh-s3",
    language: "zh-CN",
    name: "港湾乳业车队记录",
    document:
      "港湾乳业有9辆送货车，其中4辆车龄超过十年。2026年维修费用为21.4万元，2025年为12.9万元。2026年9月有两辆车没有通过年检。2026年柴油占送货成本的18%。一辆新的电动货车报价41万元，市里对每辆车补贴8万元，截止到2027年12月。",
    blocks: [
      { heading: "港湾乳业：2027年的送货车队", level: 1 },
      {
        paragraph: [
          { sentence: "港湾乳业有9辆送货车。", expected: "right" },
          { sentence: "其中4辆车龄超过十年。", expected: "right" },
        ],
      },
      { heading: "费用", level: 2 },
      { paragraph: [{ sentence: "2026年维修花了21.4万元。", expected: "right" }] },
      {
        paragraph: [{ sentence: "比2025年多了8.5万元。", expected: "right", worked: true }],
      },
      { paragraph: [{ sentence: "前一年是31.4万元。", expected: "wrong" }] },
      { heading: "建议", level: 2 },
      {
        paragraph: [{ sentence: "我们应该现在就开始换。", expected: "none", grounds: "for" }],
      },
      {
        paragraph: [{ sentence: "要赶在优惠结束之前下单。", expected: "none", grounds: "for" }],
      },
      {
        paragraph: [
          { sentence: "再等一年，花的钱会比现在动手更多。", expected: "none", grounds: "for" },
        ],
      },
      { paragraph: [{ sentence: "分两批来做。", expected: "none", grounds: "none" }] },
    ],
  },
];
