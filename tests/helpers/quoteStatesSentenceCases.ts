/**
 * The ten sentences of #2739, each in English and Chinese over a made-up Document, with the quote a
 * model gave for it: one that stops before the claim, at a printed line's end or a comma, or one
 * about another claim. Each ends as the issue says: with a Citation whose shown quote states it, or
 * with no green check. Shared by the unit test and the live check of the sentence judgement.
 */

import { shownPassages } from "./citations";
import type { ModelCall, ScriptedReply } from "./models";
import { buildPdf } from "./pdf";

export interface Case {
  name: string;
  /** The Document's page, line by line as printed. */
  lines: readonly string[];
  /** A second page, when the claim is there. */
  more?: readonly string[];
  sentence: string;
  /** The quote the model gave. */
  quote: string;
  /** Words a quote must hold to state the sentence. */
  states: readonly string[];
  /** The judge's verdict on what the Passages say; supported when absent. */
  verdict?: "unsupported";
  ends: "found" | "not-checked" | "unsupported";
}

export const ENGLISH: readonly Case[] = [
  {
    name: "stops at a line's end before its number",
    lines: [
      "Building the corpus",
      "To gather it, we followed outbound links from a discussion board and kept the pages that had",
      "drawn at least 5 recommendations, as a rough sign that people found them worth reading. Each",
      "page was then dated by the year it was first linked, and pages with no date were set aside.",
    ],
    sentence: "The team kept only the pages that had drawn at least 5 recommendations.",
    quote: "we followed outbound links from a discussion board and kept the pages that had",
    states: ["drawn at least 5 recommendations"],
    ends: "found",
  },
  {
    name: "stops at a line's end inside its date",
    lines: [
      "The Quillon Strait Grain Corridor",
      "The agreement was signed by the Velmora Republic and the Tarsk Federation under the Corvel on 22",
      "July 2022, and the Corvel set up a joint centre in the port of Almer to watch the ships go by.",
      "The corridor carried grain and fertiliser, and it stayed open until the very end of the year.",
    ],
    sentence: "It was signed under the Corvel on 22 July 2022.",
    quote: "signed by the Velmora Republic and the Tarsk Federation under the Corvel on 22",
    states: ["22 July 2022"],
    ends: "found",
  },
  {
    name: "quotes the end of the sentence that holds its figures",
    lines: [
      "The corpus holds just over 5 million documents, some 23 GB of text, once repeats and pages",
      "whose text could not be extracted were removed. Table 1 gives the corpus by the year its pages",
      "were first linked, from the oldest to the newest.",
    ],
    sentence: "The result was just over 5 million documents, about 23 GB of text.",
    quote: "once repeats and pages whose text could not be extracted were removed",
    states: ["5 million documents", "23 GB"],
    ends: "found",
  },
  {
    name: "quotes the sentence before its claim",
    lines: [
      "Clause 20: Subsistence",
      "No single meal may cost more than £75 per person, excluding VAT and service. The limit applies",
      "to each person at each meeting, and it includes any food or drink a company pays for on the",
      "person's behalf before, during or after the meeting. Where a meeting lasts more than one day,",
      "the limit applies to each day of the meeting, and a company must keep a record of each day.",
    ],
    sentence: "Where a meeting runs for more than one day, the limit applies to each day.",
    quote:
      "The limit applies to each person at each meeting, and it includes any food or drink a company pays for on the person's behalf before, during or after the meeting.",
    states: ["more than one day"],
    ends: "not-checked",
  },
  {
    name: "cites a target for a year's figure",
    lines: [
      "Our target for our own operations is cutting Scope 1 and 2 emissions by 45% by 2032 against a",
      "2017 baseline, and we report progress against it in the data section of this report.",
    ],
    more: ["Data section", "Scope 1 and 2 emissions (2017 = 100)", "2021 74", "2022 70"],
    sentence: "Scope 1 and 2 emissions stood at 70 (2017 = 100) in 2022.",
    quote:
      "Our target for our own operations is cutting Scope 1 and 2 emissions by 45% by 2032 against a 2017 baseline",
    states: ["2022 70"],
    verdict: "unsupported",
    ends: "unsupported",
  },
  {
    name: "states a number another sentence holds",
    lines: [
      "The framework sets 17 goals for the year 2030.",
      "These goals have 169 targets in all, each with indicators of its own.",
    ],
    sentence: "The framework has 17 goals with 169 targets.",
    quote: "These goals have 169 targets in all",
    states: ["17 goals"],
    ends: "not-checked",
  },
  {
    name: "quotes another person's claim",
    lines: [
      "The method is usually credited to Ilsa Marrow, who first proposed it in 1847. Teodor Venn",
      "independently proposed a similar method in 1907, and Ada Quarle first studied how it converges",
      "on problems that are not linear in 1944.",
    ],
    sentence: "Teodor Venn independently proposed a similar method in 1907.",
    quote: "The method is usually credited to Ilsa Marrow, who first proposed it in 1847",
    states: ["Teodor Venn"],
    ends: "not-checked",
  },
  {
    name: "stops at a line's end before its second clause",
    lines: [
      "Clause 26: Delivery of items",
      "When a representative offers to drop items off, the reply card must say there is no duty to meet.",
      "It must also make clear that a refusal will not be held against the health professional",
      "and that the items can be returned without explanation, and that no reason need be given.",
    ],
    sentence:
      "It must also make clear that a refusal will not be held against them and that the items can be returned without explanation.",
    quote:
      "It must also make clear that a refusal will not be held against the health professional",
    states: ["returned without explanation"],
    ends: "found",
  },
  {
    name: "stops at a line's end before its last words",
    lines: [
      "To make the job clear, we place the cue TL;DR: after the article and read what follows as the",
      "summary of it. In our tests that one cue is usually enough to get a short and readable",
      "abstractive summary. Summarisation is harder to grade than translation, so we report the score.",
    ],
    sentence: "They say that one cue is usually enough to get a short abstractive summary.",
    quote: "In our tests that one cue is usually enough to get a short and readable",
    states: ["abstractive summary"],
    ends: "found",
  },
  {
    name: "states figures its quote doesn't hold",
    lines: [
      "The weights, shown as a matrix, show how the network shifts its focus with the context.",
      'Translating "je", 94% of the weight is on "I"; translating "t\'", 88% of it is on "you".',
    ],
    sentence: 'In the example, 94% of the weight is on "I" for "je", and 88% on "you" for "t\'".',
    quote: "The weights, shown as a matrix, show how the network shifts its focus with the context",
    states: ["94%", "88%"],
    ends: "not-checked",
  },
];

export const CHINESE: readonly Case[] = [
  {
    name: "stops at a comma before its number",
    lines: [
      "为了收集语料，我们沿着讨论区的外链抓取网页，只保留获得至少 5 次推",
      "荐的网页，以此粗略判断读者是否认为它们值得一读。",
    ],
    sentence: "团队只保留了获得至少 5 次推荐的网页。",
    quote: "我们沿着讨论区的外链抓取网页",
    states: ["至少 5 次推荐"],
    ends: "found",
  },
  {
    name: "stops at a comma before its date",
    lines: [
      "该协议由维尔莫拉共和国与塔尔斯克联邦在科尔维尔大会主持下签署，签署日",
      "期为 2022 年 7 月 22 日，大会随后在港口设立了联合中心。",
    ],
    sentence: "协议于 2022 年 7 月 22 日在科尔维尔大会主持下签署。",
    quote: "该协议由维尔莫拉共和国与塔尔斯克联邦在科尔维尔大会主持下签署",
    states: ["2022 年 7 月 22 日"],
    ends: "found",
  },
  {
    name: "quotes the end of the sentence that holds its figures",
    lines: [
      "语料库共收录 500 多万份文档，约 23 GB 文本，这是去除重复",
      "页面和无法提取文本的页面之后的结果。",
    ],
    sentence: "最终得到 500 多万份文档，约 23 GB 文本。",
    quote: "这是去除重复页面和无法提取文本的页面之后的结果",
    states: ["500 多万份文档", "23 GB"],
    ends: "found",
  },
  {
    name: "quotes the sentence before its claim",
    lines: [
      "上限适用于每次会议的每个人，包括公司在会前、会中或会后为其支付的任何",
      "饮食。会议持续一天以上的，上限按每天计算，公司须记录每天的费用。",
    ],
    sentence: "会议超过一天的，上限按每天适用。",
    quote: "上限适用于每次会议的每个人，包括公司在会前、会中或会后为其支付的任何饮食",
    states: ["按每天"],
    ends: "not-checked",
  },
  {
    name: "cites a target for a year's figure",
    lines: [
      "我们为自身运营设定的目标是：到 2032 年将范围一和范围二排放较 2017 年",
      "基准减少 45%，并在本报告的数据部分报告进展。",
    ],
    more: ["数据部分", "范围一和范围二排放（2017 = 100）", "2021 年 74", "2022 年 70"],
    sentence: "2022 年范围一和范围二排放为 70（2017 = 100）。",
    quote: "到 2032 年将范围一和范围二排放较 2017 年基准减少 45%",
    states: ["2022 年 70"],
    verdict: "unsupported",
    ends: "unsupported",
  },
  {
    name: "states a number another sentence holds",
    lines: ["该框架共设 17 项目标。", "这一系列目标共有 169 项细项目标，每项都有自己的指标。"],
    sentence: "该框架共有 17 个目标，下设 169 项细项目标。",
    quote: "这一系列目标共有 169 项细项目标",
    states: ["17 项目标"],
    ends: "not-checked",
  },
  {
    name: "quotes another person's claim",
    lines: [
      "该方法通常被认为是伊尔莎·马洛在 1847 年首次提出的。特奥多尔·文在 1907 年独立提出了一个类似的方法。",
    ],
    sentence: "特奥多尔·文在 1907 年独立提出了一个类似的方法。",
    quote: "该方法通常被认为是伊尔莎·马洛在 1847 年首次提出的",
    states: ["特奥多尔·文"],
    ends: "not-checked",
  },
  {
    name: "stops at a comma before its second clause",
    lines: [
      "代表提出送达物品时，回执卡必须说明对方没有义务在送达时接受会面，还必",
      "须写明拒绝不会对该医疗专业人员不利，并且物品可以无需解释地退回。",
    ],
    sentence: "回执卡还必须写明拒绝不会对其不利，并且物品可以无需解释地退回。",
    quote: "还必须写明拒绝不会对该医疗专业人员不利",
    states: ["无需解释地退回"],
    ends: "found",
  },
  {
    name: "stops before its last words",
    lines: [
      "只要在文章后面加上这个提示词，通常就足以得到一段简短的抽象式摘要。摘要比翻译更难评分。",
    ],
    sentence: "他们说这一个提示词通常足以得到简短的抽象式摘要。",
    quote: "通常就足以得到一段简短的",
    states: ["抽象式摘要"],
    ends: "found",
  },
  {
    name: "states figures its quote doesn't hold",
    lines: [
      "以矩阵展示的注意力权重表现了网络如何根据上下文调整其关注点。翻译“j",
      "e”时，94% 的权重在“I”上；翻译“t'”时，88% 的权重在“",
      "you”上。",
    ],
    sentence: "翻译“je”时 94% 的权重在“I”上，翻译“t'”时 88% 的权重在“you”上。",
    quote: "以矩阵展示的注意力权重表现了网络如何根据上下文调整其关注点",
    states: ["94%", "88%"],
    ends: "not-checked",
  },
];

/**
 * Held out from the ten: sentences their quotes already state, in other words, with a figure beside
 * another, or in the other language. Each must keep its green check. By the Document's language;
 * written before any live run of the judgement.
 */
export const STATED_ENGLISH: readonly Case[] = [
  {
    name: "states part of its sentence",
    lines: [
      "Timetable",
      "The ferry runs every 40 minutes on weekdays and every hour at weekends, from 6 am to 11 pm.",
    ],
    sentence: "On weekdays the ferry runs every 40 minutes.",
    quote: "The ferry runs every 40 minutes on weekdays",
    states: ["every 40 minutes on weekdays"],
    ends: "found",
  },
  {
    name: "says it in other words",
    lines: [
      "Applications received after 31 March are considered in the following year's round, with no",
      "exceptions for late post.",
    ],
    sentence: "Late applications, those after 31 March, go into the next year's round.",
    quote: "Applications received after 31 March are considered in the following year's round",
    states: ["after 31 March"],
    ends: "found",
  },
  {
    name: "is in Chinese",
    lines: ["Sales rose 12% in 2025, the fastest growth the company has had in five years."],
    sentence: "2025 年销售额增长了 12%。",
    quote: "Sales rose 12% in 2025",
    states: ["12%"],
    ends: "found",
  },
];

export const STATED_CHINESE: readonly Case[] = [
  {
    name: "states part of its sentence",
    lines: ["渡轮工作日每 40 分钟一班，周末每小时一班，运营时间为早 6 点至晚 11 点。"],
    sentence: "工作日渡轮每 40 分钟一班。",
    quote: "渡轮工作日每 40 分钟一班",
    states: ["每 40 分钟一班"],
    ends: "found",
  },
  {
    name: "is in English",
    lines: ["截止日期之后收到的申请，将在下一年度的评审中处理。"],
    sentence: "Applications received after the deadline are reviewed in the following year.",
    quote: "截止日期之后收到的申请，将在下一年度的评审中处理",
    states: ["下一年度"],
    ends: "found",
  },
  {
    name: "states one of two figures",
    lines: ["该厂 2025 年产量升至 4,200 吨，比上年增加 300 吨。"],
    sentence: "2025 年该厂的产量达到 4,200 吨。",
    quote: "该厂 2025 年产量升至 4,200 吨",
    states: ["4,200 吨"],
    ends: "found",
  },
];

/**
 * Held out too: a figure the whole sentence holds, given to the wrong thing. Its sentence must
 * never show a green check, though its number is in the quote shown.
 */
export const DECOY_ENGLISH: readonly Case[] = [
  {
    name: "gives the year's rise as its output",
    lines: ["The plant's output rose to 4,200 tonnes in 2025, up 300 tonnes on the year before."],
    sentence: "The plant's output was 300 tonnes in 2025.",
    quote: "The plant's output rose to 4,200 tonnes in 2025",
    states: ["output was 300 tonnes"],
    verdict: "unsupported",
    ends: "unsupported",
  },
];

export const DECOY_CHINESE: readonly Case[] = [
  {
    name: "gives the year's rise as its output",
    lines: ["该厂 2025 年产量升至 4,200 吨，比上年增加 300 吨。"],
    sentence: "该厂 2025 年的产量为 300 吨。",
    quote: "该厂 2025 年产量升至 4,200 吨",
    states: ["产量为 300 吨"],
    verdict: "unsupported",
    ends: "unsupported",
  },
];

const spaced = (text: string) => text.replace(/\s+/gu, " ").trim().toLowerCase();
const unspaced = (text: string) => text.replace(/\s+/gu, "");
export const holds = (text: string, words: string) => unspaced(text).includes(unspaced(words));

export const documentOf = (each: Case, chinese: boolean) => ({
  name: chinese ? "测试报告.pdf" : "Test report.pdf",
  contents: buildPdf(
    [each.lines, ...(each.more ? [each.more] : [])].map((lines) =>
      chinese ? { chineseLines: lines } : { lines },
    ),
  ),
});

/** An Answer that searches, cites `each.quote` in the Passage that holds it, and writes its sentence. */
export function answering(each: Case) {
  const marked = `${each.sentence.slice(0, -1)}[^1]${each.sentence.slice(-1)}`;
  return (call: ModelCall): ScriptedReply => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: each.quote } }] };
    }
    if (!call.results.some((result) => result.tool === "cite")) {
      const passage = shownPassages(searches.at(-1)?.text ?? "").find((shown) =>
        spaced(shown.text).includes(spaced(each.quote)),
      );
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: passage?.id, quote: each.quote }] },
          },
        ],
      };
    }
    return { text: marked };
  };
}
