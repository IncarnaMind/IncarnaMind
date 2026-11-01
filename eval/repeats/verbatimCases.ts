/**
 * Sentences a Document states word for word (#2184), checked against All Documents as Check this
 * Mind does: each Note is one paragraph, as a User types a summary, and each verbatim sentence is
 * expected Supported. The decoys copy a sentence of the same Documents with one detail changed
 * (a figure, a place, a word swapped), so they must never be Supported.
 *
 * `en-walk` rebuilds the 2026-11-01 walk's Library around the repository's own Field Report:
 * the sentence its Results state came back "The model's reply couldn't be read", then Unsupported
 * against All Documents, and Supported only against the Field Report. The held-out sets
 * (`en-verbatim`, `zh-verbatim` and their decoys) are written before any change to the check, on
 * other subjects, in a .docx with headings and a short PDF that repeats one of its sentences.
 */
import type { LibraryDocument, RepeatSentence, RepeatSet } from "./cases";

const verbatim = (key: string, text: string): RepeatSentence => ({
  key,
  kind: "word-for-word",
  expected: "supported",
  text,
});

const decoy = (key: string, text: string): RepeatSentence => ({
  key,
  kind: "conflict",
  expected: "contradicted-or-unsupported",
  text,
});

export const VERBATIM_DOCUMENTS: readonly LibraryDocument[] = [
  {
    language: "en",
    file: "Field Report.docx",
    onlyFor: ["en-walk"],
    fixture: "tests/fixtures/formats/Field Report.docx",
  },
  {
    language: "en",
    file: "Harbour Survey Brief.pdf",
    onlyFor: ["en-walk"],
    pages: [
      {
        lines: [
          "Harbour Survey Brief",
          "The northern estuary survey ran from March to May 2026.",
          "The survey team measured a median sea-level rise of 4.1 mm per year at the harbour mouth.",
          "The project budget is 2.4 million pounds, approved by the steering group on 3 February 2026.",
          "Maya Lindqvist leads the survey team.",
        ],
      },
      {
        lines: [
          "Findings",
          "Raising the barrier crest by 40 centimetres halves the expected annual damage in the northern estuary.",
          "The central and southern estuaries gain less.",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Steering group notes.md",
    onlyFor: ["en-walk"],
    text: [
      "# Steering group notes",
      "",
      "14 October 2026",
      "",
      "- The project budget is raised to 2.6 million pounds.",
      "- Tom Okafor replaces Maya Lindqvist as survey lead from November 2026.",
      "",
    ].join("\n"),
  },
  {
    language: "en",
    file: "Quarterly Research Update.pptx",
    onlyFor: ["en-walk"],
    fixture: "tests/fixtures/formats/Quarterly Research Update.pptx",
  },
  {
    language: "en",
    file: "Orders.csv",
    onlyFor: ["en-walk"],
    fixture: "tests/fixtures/formats/Orders.csv",
  },
  {
    language: "en",
    file: "Marsh Monitoring Report.docx",
    onlyFor: ["en-verbatim", "en-verbatim-decoys"],
    docx: [
      { text: "Marsh Monitoring Report: Elden Flats", heading: 1 },
      {
        text: "This report gives the first year's results of the Elden Flats restoration. Its figures are provisional until the winter count is confirmed.",
      },
      { text: "1 Methods", heading: 2 },
      {
        text: "Birds were counted at high tide on the first Sunday of each month, from the two hides on the old sea wall.",
      },
      { text: "Vegetation was mapped along six transects from the creek edge to the upper marsh." },
      { text: "2 Results", heading: 2 },
      {
        text: "Breaching the sea wall at two points raised the count of wintering redshank at Elden Flats from 140 to 410 birds.",
      },
      {
        text: "Cordgrass now covers most of the lower marsh, while the upper marsh is still bare mud.",
      },
      { text: "Avocets nested on the new islands for the first time in 2026." },
      { text: "3 Costs", heading: 2 },
      { text: "The restoration cost 1.8 million pounds, paid by the regional water company." },
    ],
  },
  {
    language: "en",
    file: "Elden Flats briefing.pdf",
    onlyFor: ["en-verbatim", "en-verbatim-decoys"],
    pages: [
      {
        lines: [
          "Elden Flats: briefing for the parish council",
          "The sea wall at Elden Flats was breached in September 2024.",
          "Breaching the sea wall at two points raised the count of wintering redshank at Elden Flats from 140 to 410 birds.",
          "The new footpath along the northern bank opened to walkers on 4 May 2026.",
          "Questions about the site go to the estuary officer, Priya Raman.",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "灌区改造监测报告.docx",
    onlyFor: ["zh-verbatim", "zh-verbatim-decoys"],
    docx: [
      { text: "青石灌区改造监测报告", heading: 1 },
      { text: "本报告汇总灌区改造完成后第一年的监测结果，数据为初步数据，待秋收核定后更新。" },
      { text: "一、监测方法", heading: 2 },
      { text: "在灌区上、中、下游各选取十块样田，按季测产并记录用水量。" },
      { text: "二、监测结果", heading: 2 },
      { text: "新渠道通水后，灌区内水稻亩产由420公斤提高到510公斤。" },
      { text: "下游村庄的饮用水已改由新建水厂统一供应。" },
      { text: "泵站改造后，每年节约用电约35万千瓦时。" },
      { text: "三、投资情况", heading: 2 },
      { text: "项目总投资为人民币2,400万元，由省水利厅和县政府共同承担。" },
    ],
  },
  {
    language: "zh-CN",
    file: "青石灌区情况简报.pdf",
    onlyFor: ["zh-verbatim", "zh-verbatim-decoys"],
    pages: [
      {
        chineseLines: [
          "青石灌区情况简报",
          "灌区改造工程于2024年10月开工，2025年4月完工。",
          "新渠道通水后，灌区内水稻亩产由420公斤提高到510公斤。",
          "灌区管理站站长为周敏。",
        ],
      },
    ],
  },
];

export const VERBATIM_SETS: readonly RepeatSet[] = [
  {
    id: "en-walk",
    language: "en",
    mind: "Harbour project summary",
    inOneParagraph: " ",
    sentences: [
      verbatim("budget", "The project budget is 2.6 million pounds."),
      decoy("churn", "Customer churn fell to 6.1 per cent after the onboarding redesign."),
      verbatim(
        "barrier",
        "Raising the barrier crest by 40 centimetres halves the expected annual damage in the northern estuary.",
      ),
      {
        key: "boat",
        kind: "absent",
        expected: "absent",
        text: "The survey boat is booked for 2 December 2026.",
      },
    ],
  },
  {
    id: "en-verbatim",
    language: "en",
    mind: "Elden Flats summary",
    inOneParagraph: " ",
    sentences: [
      verbatim(
        "two-figures",
        "Breaching the sea wall at two points raised the count of wintering redshank at Elden Flats from 140 to 410 birds.",
      ),
      verbatim(
        "no-figure",
        "Cordgrass now covers most of the lower marsh, while the upper marsh is still bare mud.",
      ),
      verbatim("year", "Avocets nested on the new islands for the first time in 2026."),
    ],
  },
  {
    id: "en-verbatim-decoys",
    language: "en",
    mind: "Elden Flats notes",
    inOneParagraph: " ",
    sentences: [
      decoy(
        "two-figures",
        "Breaching the sea wall at two points raised the count of wintering redshank at Elden Flats from 140 to 460 birds.",
      ),
      decoy(
        "no-figure",
        "Cordgrass now covers most of the upper marsh, while the lower marsh is still bare mud.",
      ),
      decoy("year", "Little terns nested on the new islands for the first time in 2026."),
      decoy("cost", "The restoration cost 2.3 million pounds, paid by the regional water company."),
    ],
  },
  {
    id: "zh-verbatim",
    language: "zh-CN",
    mind: "青石灌区小结",
    inOneParagraph: "",
    sentences: [
      verbatim("two-figures", "新渠道通水后，灌区内水稻亩产由420公斤提高到510公斤。"),
      verbatim("no-figure", "下游村庄的饮用水已改由新建水厂统一供应。"),
      verbatim("unit", "泵站改造后，每年节约用电约35万千瓦时。"),
    ],
  },
  {
    id: "zh-verbatim-decoys",
    language: "zh-CN",
    mind: "青石灌区要点",
    inOneParagraph: "",
    sentences: [
      decoy("two-figures", "新渠道通水后，灌区内水稻亩产由420公斤提高到560公斤。"),
      decoy("no-figure", "上游村庄的饮用水已改由新建水厂统一供应。"),
      decoy("unit", "泵站改造后，每年节约用电约53万千瓦时。"),
      decoy("cost", "项目总投资为人民币3,100万元，由省水利厅和县政府共同承担。"),
    ],
  },
];
