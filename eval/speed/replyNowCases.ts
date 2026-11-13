/**
 * The requests `INCARNAMIND_EVAL_SPEED_REPLY_NOW=1` asks (#2830), written and committed before any
 * run of it. Each asks the assistant to write a piece from the sample reports (eval/data/,
 * eval/data/real/) into a Note: a new one, or the Note it is asked from, which holds one line of
 * the User's. Five are in English and five in Chinese; the first in each language is the request
 * #2830 was seen on, a summary of every Document.
 */
export interface ReplyNowCase {
  id: string;
  language: "en" | "zh-CN";
  text: string;
}

/**
 * #1635's box, asked only by its id: an eight-paragraph write, whose first paragraph shows within
 * 8 s and whose reply ends within 25 s on Claude Sonnet 5.5. Written after the ten below were run.
 */
export const EIGHT_PARAGRAPHS: ReplyNowCase = {
  id: "en-eight-paragraphs",
  language: "en",
  text: "Write eight paragraphs into my notes on the Vantrell Financial Group 2022 ESG Report.",
};

export const REPLY_NOW_CASES: readonly ReplyNowCase[] = [
  {
    id: "en-every-document",
    language: "en",
    text: "Summarise my documents in a new note, a paragraph for each.",
  },
  {
    id: "en-esg-briefing",
    language: "en",
    text: "Write a briefing on the Vantrell Financial Group 2022 ESG Report into my notes: its targets, its financing and its risks.",
  },
  {
    id: "en-norvath-summary",
    language: "en",
    text: "Make a new note summarising the Norvath Assembly Annual Report 2022, with a paragraph for each programme.",
  },
  {
    id: "en-risk-register",
    language: "en",
    text: "Add a summary of the National Risk Register 2023's main risks to my notes, a paragraph for each kind of risk.",
  },
  {
    id: "en-code-gifts",
    language: "en",
    text: "Write a short report in a new note on what the MPMA Code of Practice 2021 says about gifts, hospitality and meetings with health professionals.",
  },
  {
    id: "zh-every-document",
    language: "zh-CN",
    text: "把我的每个文档各写一段总结，放进一篇新笔记。",
  },
  {
    id: "zh-statistics",
    language: "zh-CN",
    text: "根据《中华人民共和国2023年国民经济和社会发展统计公报》写一份经济概况，加到我的笔记里。",
  },
  {
    id: "zh-esg-targets",
    language: "zh-CN",
    text: "新建一篇笔记，概括 Vantrell 2022 年 ESG 报告的减排目标和可持续金融目标。",
  },
  {
    id: "zh-world-development",
    language: "zh-CN",
    text: "把 World Development Report 2023 Overview 的要点整理成几段，写进我的笔记。",
  },
  {
    id: "zh-norvath-briefing",
    language: "zh-CN",
    text: "根据 Norvath Assembly 2022 年度报告，新建一篇简报笔记，写它的项目和资金。",
  },
];
