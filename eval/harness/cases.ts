/**
 * The bake-off's requests (README.md): 30, 15 in English and 15 in Chinese,
 * each asked with no Mind open, since an outside harness has none. Most are
 * everyday requests as `eval/everyday` has them, held to the same guards;
 * the others are two-turn requests (#1172) and drafts with wrong figures.
 * Each is tagged with the persona it stands in for.
 */
import type { AskedRequest } from "../everyday/asking";
import { CASES } from "../everyday/cases";
import type { Expected } from "../everyday/checks";

/** The Documents a request is asked over (./libraries). */
export type HarnessLibrary = "papers" | "reports" | "dated" | "credit";

export type Persona = "analyst" | "litigator" | "student";

/** A figure a draft gets wrong, and the Documents' figure a reply must give to catch it. */
export interface WrongFigure {
  wrong: string;
  right: string;
  /** How the Documents' figure may be written: "38.6%", "38.6 %". */
  written: RegExp;
}

export interface HarnessCase extends AskedRequest {
  library: HarnessLibrary;
  persona: Persona;
  group: "everyday" | "research" | "dated" | "turns" | "wrong-figures";
  wrongFigures?: readonly WrongFigure[];
}

const EVERYDAY: readonly [string, Persona][] = [
  ["ask-tutorial", "student"],
  ["ask-tutorial-zh", "student"],
  ["ask-compare", "student"],
  ["ask-summarise-zh", "student"],
  ["ask-datasets-zh", "student"],
  ["no-mind-add", "student"],
  ["research-attention-long", "student"],
  ["research-gpt3-few-shot", "student"],
  ["research-jpm-target", "analyst"],
  ["research-un-hunger", "analyst"],
  ["research-abpi-gifts", "litigator"],
  ["research-attention-long-zh", "student"],
  ["research-gpt3-few-shot-zh", "student"],
  ["research-jpm-target-zh", "analyst"],
  ["research-un-hunger-zh", "analyst"],
  ["research-abpi-gifts-zh", "litigator"],
  ["dates-contract-summary", "litigator"],
  ["dates-contract-signed", "litigator"],
  ["dates-nda-effective", "litigator"],
  ["dates-contract-summary-zh", "litigator"],
  ["dates-contract-signed-zh", "litigator"],
  ["dates-minutes-zh", "litigator"],
];

function fromEveryday([id, persona]: readonly [string, Persona]): HarnessCase {
  const found = CASES.find((each) => each.id === id);
  if (!found) throw new Error(`No everyday request "${id}".`);
  const { library } = found;
  if (
    library === "reserves" ||
    library === "filings" ||
    library === "cedar" ||
    library === "cedar-zh"
  )
    throw new Error(`"${id}" needs a Document library the bake-off doesn't have.`);
  return {
    ...found,
    library,
    mind: null,
    persona,
    group: found.research ? "research" : found.library === "dated" ? "dated" : "everyday",
  };
}

/** Asked after an earlier turn: the reply says nothing of it (#1172). */
const AFTER_A_TURN: Expected = { write: false, cite: true, coverAll: false, noEarlier: true };
const CHECK_FIGURES: Expected = { write: false, cite: true, coverAll: false };

const MARGIN: WrongFigure = { wrong: "36.8%", right: "38.6%", written: /(?<![\d.])38\.6\s?%/ };
const LEVERAGE: readonly WrongFigure[] = [
  { wrong: "3.4", right: "3.1", written: /(?<![\d.])3\.1(?![\d])/ },
  { wrong: "4.0", right: "3.5", written: /(?<![\d.])3\.5(?![\d])/ },
];

/** The credit example's own draft (src/core/exampleSets.ts), whose margin is wrong. */
const DRAFT_EN = [
  "## Recommendation",
  "",
  "Hold the facility at its current limit and ask Northwind for a monthly margin report.",
  "",
  "## Why",
  "",
  "Gross margin fell to 36.8% in Q3, mostly in online. The facilities run to February 2029, so refinancing is not this year’s risk.",
].join("\n");
const DRAFT_ZH = [
  "## 建议",
  "",
  "维持现有授信额度，并要求 Northwind 每月提供毛利率报告。",
  "",
  "## 理由",
  "",
  "第三季度毛利率降至 36.8%，主要拖累来自线上业务。贷款于 2029 年 2 月到期，因此再融资不是今年的风险。",
].join("\n");

const OWN: readonly HarnessCase[] = [
  {
    id: "turns-summary",
    language: "en",
    library: "dated",
    persona: "litigator",
    group: "turns",
    mind: null,
    before: ["What does the employment contract say about notice and leave?"],
    request: "Write a short summary of this agreement.",
    expected: { ...AFTER_A_TURN, textDates: true },
  },
  {
    id: "turns-summary-zh",
    language: "zh-CN",
    library: "dated",
    persona: "litigator",
    group: "turns",
    mind: null,
    before: ["这份劳动合同里关于解除通知和年休假是怎么规定的？"],
    request: "请为这份合同写一个简短的摘要。",
    expected: { ...AFTER_A_TURN, textDates: true },
  },
  {
    id: "turns-example",
    language: "en",
    library: "credit",
    persona: "student",
    group: "turns",
    mind: null,
    before: ["Is Northwind inside its leverage covenant?"],
    request: "What does the GraphST paper claim?",
    expected: AFTER_A_TURN,
  },
  {
    id: "turns-example-zh",
    language: "zh-CN",
    library: "credit",
    persona: "student",
    group: "turns",
    mind: null,
    before: ["Northwind 的杠杆率还在贷款协议的上限之内吗？"],
    request: "GraphST 这篇论文的主要主张是什么？",
    expected: AFTER_A_TURN,
  },
  {
    id: "figures-draft",
    language: "en",
    library: "credit",
    persona: "analyst",
    group: "wrong-figures",
    mind: null,
    request: `Check the figures in my draft against my documents:\n\n${DRAFT_EN}`,
    expected: CHECK_FIGURES,
    wrongFigures: [MARGIN],
  },
  {
    id: "figures-draft-zh",
    language: "zh-CN",
    library: "credit",
    persona: "analyst",
    group: "wrong-figures",
    mind: null,
    request: `对照我的文档，检查这份草稿里的数字：\n\n${DRAFT_ZH}`,
    expected: CHECK_FIGURES,
    wrongFigures: [MARGIN],
  },
  {
    id: "figures-leverage",
    language: "en",
    library: "credit",
    persona: "analyst",
    group: "wrong-figures",
    mind: null,
    request:
      "Are the figures in this paragraph right?\n\nAt the end of Q3, Northwind's net debt to EBITDA was 3.4 times, well inside the 4.0 times limit in its facilities agreement.",
    expected: CHECK_FIGURES,
    wrongFigures: LEVERAGE,
  },
  {
    id: "figures-leverage-zh",
    language: "zh-CN",
    library: "credit",
    persona: "analyst",
    group: "wrong-figures",
    mind: null,
    request:
      "这段话里的数字对吗？\n\n第三季度末，Northwind 的净债务与 EBITDA 之比为 3.4 倍，远低于贷款协议规定的 4.0 倍上限。",
    expected: CHECK_FIGURES,
    wrongFigures: LEVERAGE,
  },
];

export const HARNESS_CASES: readonly HarnessCase[] = [...EVERYDAY.map(fromEveryday), ...OWN];

/** The figures a reply caught: those whose Documents' figure it gives. */
export function caughtFigures(reply: string, figures: readonly WrongFigure[]): boolean[] {
  return figures.map((figure) => figure.written.test(reply));
}

/**
 * Pointers to an earlier turn that #1172 names beside those `checks.ts`
 * already catches: text for a page must stand on its own.
 */
export const POINTS_BACK =
  /\b(?:as (?:noted|mentioned|shown|discussed|set out|covered) above|see above|as above)\b|上一条(?:回答|回复)|见上文|如上所述|上文(?:提到|所述)/i;
