/**
 * With no Documents (no Tools offered), every Question gets the same short
 * Markdown Answer, streamed a few words at a time. With Documents, it does
 * what a Tool-calling model does: it searches for the Question, cites the line
 * of the first Passage that shares a word with the Question (on the page, or
 * at the Location, that line is on), then answers with a marker. A Question
 * with "misquote" in it gets a quote that isn't on the page; one with "no page"
 * names no page, as a small model often doesn't; one with "beyond its quote" (超出引文) says more
 * than its quote does, which the scripted check finds unsupported; one with "without citing" (不引用)
 * writes a marker and never calls cite, as a model sometimes does; one with "citing as text" (文字引用)
 * writes its records as text in a <cite> block instead of calling cite; one with "each"
 * cites the first Passage of each Document found, with a marker for each; one
 * with "rows" quotes two lines, so a sheet's Citation covers a range of rows; one with
 * "quotation marks" (引号) quotes the clause after a line's colon or comma, and writes
 * it in quotation marks with the word before it, which the page doesn't have (#483); one that
 * asks for it "as a table" gets a Markdown table with its markers in a cell; one that
 * asks "by quarter" (按季度) gets a table of quarterly figures, its marker in each cell
 * but the last, to chart (#436); "分季度" gets the same in Chinese, in 万元, and
 * "in millions" each figure as "$289.4 million"; one that asks for "four columns" gets a
 * table of four, wider than the assistant (#612); one that asks for "two tables" (两个表) gets
 * two small ones; one that asks for "nine rows" (九行) gets
 * three peers' figures in nine rows, with the first column's labels; one that asks to "compare the
 * two contracts" (比较两份合同) gets a table of three columns, its cells short if the instructions
 * ask for that and the quotes if not (#1382); one that asks for "narrow then wide" (先窄后宽) gets a
 * line, then a table whose first rows fit the assistant and whose last is wider than it; one that asks for
 * "long headings" (长标题) gets a table of four long headings and long rows, as a real model writes one;
 * one that asks for "forty citations" (四十条引用) gets forty sentences, each with a marker, one for
 * "four citations" (四条引用) four, and one that asks for "twelve in a row" (连续十二条) gets one
 * sentence with twelve markers side by side; one with "cited below" (or 引用在下) gets a
 * table whose one Citation stands in a paragraph under it, and one with "framed" (or 带说明)
 * gets a lead-in before its content and a closing note after it (#702); one that says "without
 * searching" (不用搜索) cites the Passages given with it, as a model does that is given a short
 * Document's whole text, and calls no search. One that turns the Mind "into a report" (整理成报告)
 * keeps each Citation it reads there by its id, with no search, as #1800 asks of a model.
 * One that says "边想边写" writes pages of working notes after its search, with no
 * marker (#1344). One that says "search twice" (搜两次) searches once more after its first
 * search, as a model does whose first Passages fall short. One that asks how much something
 * grew (增长) has the growth from the first two numbers of its quote calculated, and writes it
 * with its marker; one that also asks for a share (占比) gets the earlier number's share of the
 * later one as a second figure.
 * As models did (#1172), one for a "short summary" (简短的摘要) ends with a
 * paragraph pointing to an earlier Answer, and one about "home working"
 * (居家办公) asked beside a Mind ends by setting the Documents apart from it,
 * unless the instructions say that Mind is an example.
 * One that asks about the minutes (纪要) searches only the first listed Document whose name says
 * so, by that name, as a model that takes a name for one Document does (#1512).
 * Before its search it reasons, a line that quotes the Question, as a model
 * that thinks does; given the Question's search before its first call (#1633),
 * it answers from those Passages and reasons on that call. A Question asked
 * "slowly" waits a moment before each step and writes its Answer word by word,
 * so a test sees each step of the Answer.
 *
 * With Skills: a Question that names a listed Skill gets it loaded with
 * use_skill first. An Answer that follows a Skill (forced, or loaded) starts
 * by saying which.
 */

import { namesIn } from "./asks";
import { cellReply, isCell } from "./cells";
import {
  FORTY_CITATIONS,
  FOUR_CITATIONS,
  passagesIn,
  recordFor,
  recordsFor,
  TWELVE_IN_A_ROW,
} from "./passages";
import {
  calledSinceQuestion,
  lastQuestion,
  lastUserText,
  type Prompt,
  promptText,
  type Reply,
  type StreamPart,
  systemOf,
  toolResults,
  USAGE,
  userText,
} from "./prompt";

/** What the scripted model reasons before it searches: a line that quotes the Question. */
const reasoningFor = (question: string) => `Search the Documents for “${question}”.`;
/** What it reasons when the Question was searched before its first call (#1633). */
const reasoningOnFound = (question: string) => `Answer “${question}” from the Passages found.`;

/** The scripted Answer to a Question, when there are no Documents; it says which Skill it follows, if any. */
function fakeAnswer(question: string, skill: string | null = null): string {
  return [
    ...(skill ? [`Following the Skill ${skill}.`, ""] : []),
    `This is a **scripted** Answer to: ${question}`,
    "",
    "- It streams in a few words at a time",
    "- Math renders too: $E = mc^2$",
    "",
    "```js",
    'console.log("IncarnaMind");',
    "```",
    "",
    "That is all.",
  ].join("\n");
}

/**
 * What the scripted provider's web search finds, whatever the query: pages the
 * smoke tests' stand-in web serves (INCARNAMIND_TEST_WEB), as any host does there.
 */
const FOUND_PAGES = [
  { url: "http://encyclopedia.test/tea", title: "Tea - The Open Encyclopedia" },
  { url: "http://news.test/members", title: "Tea's history, for members" },
];

/** The scripted Answer when it cited something: one sentence with a marker. */
export const CITED_ANSWER = "Your Documents answer this [^1].\n\nThat is all.";

/**
 * The sentences the scripted Answers write beside a Citation, which say only what it quotes, as
 * an Answer must (#1073): the scripted check finds each supported by its quote (./checks, #2311).
 */
export const KEPT_TO_THE_QUOTE = new RegExp(
  `^(?:${[
    String.raw`Your Documents answer this\.`,
    "文档回答了这个问题。",
    String.raw`Your Documents say “[^”]+”\.`,
    "文档中写道“[^”]+”。",
    String.raw`Statement \d+ says the tide rises and falls twice a day, at hours that follow the moon\.`,
    String.raw`第\d+条说明潮水每天涨落两次，月亮的位置决定了涨落的时间。`,
    String.raw`The tide rises and falls twice a day\.`,
    "潮水每天涨落两次。",
    String.raw`What the Mind found, with its sources\.`,
    "Mind 里的发现，来源都在。",
  ].join("|")})$`,
  "u",
);

/** A Question whose Answer says more than its quote does: the scripted check finds it unsupported (#2311). */
const BEYOND_ITS_QUOTE = /\bbeyond its quote\b|超出引文/i;

/**
 * A Question whose model, after its search, runs on for pages of working notes instead of an
 * Answer (#1344): more than the backstop lets stand. The notes are Chinese, which has no spaces to
 * stream a word at a time at: they arrive in one piece.
 */
const THINKING_ALOUD = /边想边写/;

const WORKING_NOTES = "等一下，可能还有一份相同的文件。再搜一次确认一下。".repeat(600);

const WITHOUT_SEARCHING = /\bwithout searching\b|不用搜索/i;

/** A Question whose reply says the calculation Tool confirmed a figure, with no `calculate` call (#1796). */
const CLAIMS_CALCULATION = /\bclaims a calculation\b|声称已计算/i;
const CLAIMS_CALCULATION_ZH = /声称已计算/;
const claimAnswer = (said: string) =>
  CLAIMS_CALCULATION_ZH.test(said)
    ? "计算工具已确认：杠杆率为 3.26 倍。"
    : "The calculation tool confirmed 3.26x.";

const INTO_A_REPORT = /\binto a report\b|整理成报告/i;

/** A Question whose first Passages fall short: the model searches once more, in its own words. */
const SEARCH_TWICE = /\bsearch twice\b|搜两次/i;
const ownWords = (question: string) =>
  question
    .replace(SEARCH_TWICE, "")
    .replace(/[\s.?!。？！]+$/u, "")
    .toLowerCase();

/** A report of the Mind: each Citation it reads there recorded by its id, then a marker for each. */
function reportReply(prompt: Prompt, question: string): Reply {
  const read = prompt
    .filter((message) => message.role === "user")
    .map(userText)
    .join("\n");
  const ids = [...new Set([...read.matchAll(/· (C\d+)\]/g)].map((match) => match[1]))];
  if (toolResults(prompt, "cite").length === 0 && ids.length > 0) {
    const citations = ids.map((id, index) => ({ marker: index + 1, passage: id }));
    return { tool: "cite", input: { citations } };
  }
  const markers = ids.map((_, index) => `[^${index + 1}]`).join("");
  return {
    text: /\p{Script=Han}/u.test(question)
      ? `# 报告\n\nMind 里的发现，来源都在${markers}。`
      : `# Report\n\nWhat the Mind found, with its sources ${markers}.`,
  };
}

/** A Question the model answers with a marker and no `cite` call. */
const WITHOUT_CITING = /\bwithout citing\b|不引用/i;

/** A Question the model answers with its records written as text, not a `cite` call. */
const CITING_AS_TEXT = /\bciting as text\b|文字引用/i;

/** The scripted Answer to such a Question: a sentence with a marker, then the records in a `<cite>` block. */
const citedAsText = (question: string, records: readonly unknown[]) =>
  `${uncitedAnswer(question)}\n\n<cite>\n${JSON.stringify(records)}\n</cite>`;

/** The scripted Answer to such a Question: a sentence with a marker no record backs. */
const uncitedAnswer = (question: string) =>
  /\p{Script=Han}/u.test(question)
    ? "文档回答了这个问题[^1]。\n\n以上。"
    : "Your Documents answer this [^1].\n\nThat is all.";

/** The scripted Answer, as a table, to a Question that asks for one: the markers in a cell. */
const tableAnswer = (markers: string) =>
  [
    "| Claim | Where |",
    "|:--|--:|",
    `| Your Documents answer this ${markers} | Documents |`,
    "| Nothing else <br> is claimed | — |",
    "",
    "That is all.",
  ].join("\n");

/** A Question that asks for its Answer as a table. */
const AS_A_TABLE = /\bas a table\b/i;

/** The scripted Answer to a Question that asks for "four columns": a table wider than the assistant. */
const wideTableAnswer = (marker: string) =>
  [
    "| Quarter | Revenue 2024 | Revenue 2025 | Change |",
    "|:--|--:|--:|--:|",
    `| Q1 | 289.4 ${marker} | 341.5 | +18.0% |`,
    "| Q2 | 301.2 | 362.0 | +20.2% |",
    "| Q3 | 309.8 | 377.9 | +22.0% |",
    "",
    "That is all.",
  ].join("\n");

const TWO_TABLES = /\btwo tables\b|两个表/i;

function twoTablesAnswer(question: string): string {
  const chinese = /\p{Script=Han}/u.test(question);
  return (
    chinese
      ? [
          "| 季度 | 收入 |",
          "|:--|--:|",
          "| 一季度 | 289.4 |",
          "| 二季度 | 301.2 |",
          "",
          "| 地区 | 占比 |",
          "|:--|--:|",
          "| 北方 | 41% |",
          "| 南方 | 59% |",
          "",
          "以上。",
        ]
      : [
          "| Quarter | Revenue |",
          "|:--|--:|",
          "| Q1 | 289.4 |",
          "| Q2 | 301.2 |",
          "",
          "| Region | Share |",
          "|:--|--:|",
          "| North | 41% |",
          "| South | 59% |",
          "",
          "That is all.",
        ]
  ).join("\n");
}

const NINE_ROWS = /\bnine rows\b|九行/i;

function nineRowsAnswer(question: string, marker: string): string {
  const chinese = /\p{Script=Han}/u.test(question);
  const rows = chinese
    ? [
        ["营业收入（近十二个月）", "128,460 百万元", "94,120 百万元", "21,050 百万元"],
        ["上半年利润率", "40.3%", "39.5%", "37.9%"],
        ["第三季度利润率", "38.4%", "37.1%", "36.8%"],
        ["变化", "−1.9 个百分点", "−2.4 个百分点", "−1.1 个百分点"],
        ["息税折旧摊销前利润（近十二个月）", "10,280 百万元", "6,110 百万元", "1,490 百万元"],
        ["净债务", "24,670 百万元", "20,770 百万元", "3,880 百万元"],
        ["净杠杆率", "2.4×", "3.4×", "2.6×"],
        ["契约上限", "3.5×", "3.5×", "3.25×"],
        ["余量", "1.1×", "0.1×", "0.65×"],
      ]
    : [
        ["Revenue, LTM", "£12,846m", "£9,412m", "£2,105m"],
        ["Margin, H1", "40.3%", "39.5%", "37.9%"],
        ["Margin, Q3", "38.4%", "37.1%", "36.8%"],
        ["Change", "−1.9 pts", "−2.4 pts", "−1.1 pts"],
        ["EBITDA, LTM", "£1,028m", "£611m", "£149m"],
        ["Net debt", "£2,467m", "£2,077m", "£388m"],
        ["Net leverage", "2.4×", "3.4×", "2.6×"],
        ["Covenant limit", "3.5×", "3.5×", "3.25×"],
        ["Headroom", "1.1×", "0.1×", "0.65×"],
      ];
  const head = chinese
    ? ["指标", "哈罗食品", "明智超市", "考尔德杂货"]
    : ["Figure", "Harrow Foods", "Brightmart", "Calder Grocers"];
  return [
    `| ${head.join(" | ")} |`,
    "|:--|--:|--:|--:|",
    ...rows.map(([label, ...cells], index) => {
      const cited = cells.map((cell, column) =>
        index === 0 && column === 0 ? `${cell} ${marker}` : cell,
      );
      return `| ${label} | ${cited.join(" | ")} |`;
    }),
    "",
    chinese ? "变化和余量为计算所得。" : "Change and headroom are calculated.",
  ].join("\n");
}

const CONTRACT_COMPARISON = /\bcompare the two contracts\b|比较两份合同/i;

const SHORT_CELLS = "about eight words";

const CONTRACT_CELLS = {
  en: {
    head: ["Term", "Alder", "Birch"],
    short: [
      ["Notice", "30 days", "60 days"],
      ["Law", "England", "New York"],
      ["Cap", "12 months' fees", "None"],
    ],
    long: [
      [
        "Notice",
        "Either party may end the agreement by giving thirty days' written notice to the other party",
        "Either party may end the agreement by giving sixty days' written notice to the other party",
      ],
      [
        "Law",
        "This agreement is governed by the laws of England and Wales and the courts of England",
        "This agreement is governed by the laws of the State of New York and the courts of that State",
      ],
      [
        "Cap",
        "Liability under this agreement is limited to the fees paid in the twelve months before the claim",
        "Liability under this agreement is not limited to any amount, whatever the cause of the claim",
      ],
    ],
  },
  zh: {
    head: ["条款", "阿尔德", "伯奇"],
    short: [
      ["通知期", "30 天", "60 天"],
      ["法律", "英国法", "纽约州法"],
      ["上限", "12 个月费用", "无上限"],
    ],
    long: [
      [
        "通知期",
        "任何一方均可提前三十日书面通知对方终止本协议，无需说明任何理由",
        "任何一方均可提前六十日书面通知对方终止本协议，无需说明任何理由",
      ],
      [
        "法律",
        "本协议受英格兰和威尔士法律管辖，并由英格兰的法院专属管辖",
        "本协议受纽约州法律管辖，并由纽约州的法院专属管辖",
      ],
      [
        "上限",
        "本协议项下的责任以索赔前十二个月内已支付的费用为限",
        "本协议项下的责任不设金额上限，无论索赔因何而起",
      ],
    ],
  },
} as const;

function contractComparisonAnswer(prompt: Prompt, question: string, marker: string): string {
  const { head, short, long } = CONTRACT_CELLS[/\p{Script=Han}/u.test(question) ? "zh" : "en"];
  // Short only if the instructions ask for it, so a test that passes proves they reach the model.
  const rows = systemOf(prompt).includes(SHORT_CELLS) ? short : long;
  return [
    `| ${head.join(" | ")} |`,
    "|:--|:--|:--|",
    ...rows.map(([term, alder, birch], index) => {
      const cited = index === 0 ? `${alder} ${marker}` : alder;
      return `| ${term} | ${cited} | ${birch} |`;
    }),
  ].join("\n");
}

const NARROW_THEN_WIDE = /\bnarrow then wide\b|先窄后宽/i;

function narrowThenWideAnswer(question: string, marker: string): string {
  if (/\p{Script=Han}/u.test(question)) {
    return [
      "对比如下。",
      "",
      "| 条款 | 阿尔德公司 | 伯奇公司 |",
      "|:--|:--|:--|",
      "| 法律 | 英国普通法 | 纽约州法律 |",
      "| 上限 | 十二个月费用 | 无上限责任 |",
      `| 通知期 | 三十日 | 提前三十日书面通知 ${marker} |`,
      "| 费用 | 按月 | 按季 |",
      "| 期限 | 三年 | 两年 |",
      "| 续约 | 自动 | 手动 |",
      "| 数据 | 欧盟 | 美国 |",
    ].join("\n");
  }
  return [
    "Here is the comparison.",
    "",
    "| Term | Alder Ltd | Birch Inc |",
    "|:--|:--|:--|",
    "| Law | England | New York |",
    "| Cap | 12 months | Unlimited |",
    `| Notice | 30 days | Thirty days' written notice ${marker} |`,
    "| Fees | Monthly | Quarterly |",
    "| Years | 3 years | 2 years |",
    "| Renewal | Auto | Manual |",
    "| Data | EU | US |",
  ].join("\n");
}

const LONG_HEADINGS = /\blong headings\b|长标题/i;

function longHeadingsAnswer(question: string, marker: string): string {
  if (/\p{Script=Han}/u.test(question)) {
    return [
      "| 条款 | 阿尔德供货协议 | 伯奇供货协议 | 港湾包装补充说明 |",
      "|:--|:--|:--|:--|",
      `| 期限 | 自 2026 年 3 月 1 日起三年，之后每年续期 ${marker} | 自 2026 年 6 月 1 日起两年，期满终止，除非书面延长 | 两份协议均在港湾框架内履行 |`,
      "| 通知 | 任何一方须提前 30 天书面通知对方 | 任何一方须提前 60 天书面通知对方 | 通知送交港湾包装的联系人 |",
      "| 付款 | 收到发票后 30 天内付款，逾期按基准利率加 4% 计息 | 收到发票后 45 天内付款，逾期按每月 1.5% 计息 | 逾期费用按各自协议执行 |",
    ].join("\n");
  }
  return [
    "| Term | Alder Supply Agreement | Birch Supply Agreement | Harbour Packaging notes |",
    "|:--|:--|:--|:--|",
    `| Duration | Three years from 1 March 2026, then renews yearly ${marker} | Two years from 1 June 2026, then ends unless extended in writing | Both run beside the Harbour framework |`,
    "| Notice | Either party gives 30 days' written notice to the other | Either party gives 60 days' written notice to the other | Notice goes to the Harbour Packaging contact |",
    "| Payment | Invoices paid within 30 days, late payments at 4% above base rate | Invoices paid within 45 days, late payments at 1.5% a month | Late fees follow each agreement |",
  ].join("\n");
}

function citedSentencesAnswer(question: string, count: number): string {
  const chinese = /\p{Script=Han}/u.test(question);
  const sentences = Array.from({ length: count }, (_, index) =>
    chinese
      ? `第${index + 1}条说明潮水每天涨落两次，月亮的位置决定了涨落的时间[^${index + 1}]。`
      : `Statement ${index + 1} says the tide rises and falls twice a day, at hours that follow the moon [^${index + 1}].`,
  );
  const paragraphs: string[] = [];
  for (let at = 0; at < sentences.length; at += 8)
    paragraphs.push(sentences.slice(at, at + 8).join(chinese ? "" : " "));
  return paragraphs.join("\n\n");
}

const twelveInARowAnswer = (question: string) => {
  const markers = Array.from({ length: 12 }, (_, index) => `[^${index + 1}]`).join("");
  return /\p{Script=Han}/u.test(question)
    ? `潮水每天涨落两次${markers}。`
    : `The tide rises and falls twice a day ${markers}.`;
};

/** A Question whose table is cited under it, and one that is framed by a lead-in and a closing note (#702). */
const CITED_BELOW = /\bcited below\b|引用在下/i;
const FRAMED = /\bframed\b|带说明/i;

/** The table whose one Citation stands under it, in Chinese or English, with the framing if asked. */
function citedBelowAnswer(question: string, marker: string): string {
  const chinese = /\p{Script=Han}/u.test(question);
  const table = chinese
    ? ["| 季度 | 收入 |", "|:--|--:|", "| 一季度 | 289.4 |", "| 二季度 | 301.2 |"]
    : ["| Quarter | Revenue |", "|:--|--:|", "| Q1 | 289.4 |", "| Q2 | 301.2 |"];
  const framed = FRAMED.test(question);
  return [
    ...(framed ? [chinese ? "以下是草稿：" : "Here is a draft:", ""] : []),
    ...table,
    "",
    ...(CITED_BELOW.test(question) ? [marker, ""] : []),
    ...(framed ? [chinese ? "注：以上仅为草稿。" : "Note: this is only a draft."] : []),
  ].join("\n");
}

/** A Question that asks for four columns. */
const FOUR_COLUMNS = /\bfour columns\b/i;

/** The scripted Answer to a Question that asks for figures by quarter: a table of them, each cited but the last. */
const figuresAnswer = (marker: string, written = (figure: string) => figure) =>
  [
    "| Quarter | 2024 | 2025 |",
    "|:--|--:|--:|",
    `| Q1 | ${written("289.4")} ${marker} | ${written("341.5")} ${marker} |`,
    `| Q2 | ${written("301.2")} ${marker} | ${written("362.0")} ${marker} |`,
    `| Q3 | ${written("309.8")} ${marker} | ${written("377.9")} ${marker} |`,
    `| Q4 | ${written("330.6")} ${marker} | ${written("401.2")} |`,
    "",
    "That is all.",
  ].join("\n");

/** The same, in Chinese, in 万元. */
const chineseFiguresAnswer = (marker: string) =>
  [
    "| 季度 | 2024 | 2025 |",
    "|:--|--:|--:|",
    `| 一季度 | 28,410.55 ${marker} | 35,120.08 ${marker} |`,
    `| 二季度 | 29,876.31 ${marker} | 37,005.62 ${marker} |`,
    `| 三季度 | 30,615.90 ${marker} | 38,770.43 ${marker} |`,
    `| 四季度 | 32,980.44 ${marker} | 41,444.43 |`,
    "",
    "以上。",
  ].join("\n");

/** A Question that asks for figures by quarter. */
const BY_QUARTER = /\bby quarter\b|按季度/i;
const BY_QUARTER_CHINESE = /分季度/;
const IN_MILLIONS = /\bin millions\b/i;

const MINUTES = /\bminutes\b|纪要/i;

function minutesNamed(prompt: Prompt, question: string): string | undefined {
  if (!MINUTES.test(question)) return undefined;
  return namesIn(systemOf(prompt)).find((name) => MINUTES.test(name.replace(/ \(“[^”]*”\)$/, "")));
}

const SHORT_SUMMARY = /\bshort summary\b|简短的摘要/i;
const HOME_WORKING = /\bhome working\b|居家办公/i;

function withAsides(prompt: Prompt, question: string, answer: string): string {
  const chinese = /\p{Script=Han}/u.test(question);
  if (SHORT_SUMMARY.test(question)) {
    return `${answer}\n\n${chinese ? "居家办公的规定见上一条回答。" : "Notice, holiday and home working are covered in my earlier answer."}`;
  }
  const beside = /<mind name="([^"]*)">/.exec(
    userText(prompt.find((message) => message.role === "user")),
  )?.[1];
  if (!HOME_WORKING.test(question) || !beside) return answer;
  if (systemOf(prompt).includes("is an example IncarnaMind made")) return answer;
  return `${answer}\n\n${chinese ? `这与“${beside}”无关。` : `This has nothing to do with “${beside}”.`}`;
}

/** The Skill the Answer follows: the one the Question forces, or one loaded with use_skill. */
function skillFollowed(prompt: Prompt): string | null {
  const forced = /the User chose the Skill "([^"]+)"/.exec(systemOf(prompt))?.[1];
  if (forced) return forced;
  const loaded = toolResults(prompt, "use_skill").at(-1);
  return (loaded && /<skill name="([^"]+)">/.exec(loaded)?.[1]) || null;
}

/** A listed Skill the Question names, to load before answering. */
export function skillNamed(prompt: Prompt, question: string): string | null {
  const listed = [...systemOf(prompt).matchAll(/<skill name="([^"]+)">/g)].map((match) => match[1]);
  return listed.find((name) => name && question.toLowerCase().includes(name)) ?? null;
}

/** The scripted provider's web search: it searches once and finds `FOUND_PAGES`, as Anthropic reports them. */
export function searchParts(tool: string, query: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "fake-web-search",
      toolName: tool,
      input: JSON.stringify({ query }),
      providerExecuted: true,
    },
    {
      type: "tool-result",
      toolCallId: "fake-web-search",
      toolName: tool,
      result: FOUND_PAGES.map((page) => ({
        type: "web_search_result",
        url: page.url,
        title: page.title,
        pageAge: null,
        encryptedContent: "",
      })),
    },
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "done" },
    { type: "text-end", id: "answer" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

const BY_REGION = /\bby region\b|按地区/i;
const WITH_MANAGERS = /\bmanager|负责人/i;

function analysisReply(prompt: Prompt, question: string, searched: string): Reply | null {
  const ran = toolResults(prompt, "run_analysis");
  const chinese = /\p{Script=Han}/u.test(question);
  if (ran.length > 0) {
    return {
      text: chinese
        ? "各地区收入如下：\n\n[=table 1]\n\n合计 [=1]。"
        : "Revenue by region:\n\n[=table 1]\n\nIn total, [=1].",
    };
  }
  const passages = passagesIn(searched);
  const sales = passages.find((passage) => /sales|销售/i.test(passage.document));
  if (!sales) return null;
  const regions = passages.find((passage) => /regions|地区/i.test(passage.document));
  const joining = WITH_MANAGERS.test(question) && regions;
  const code = [
    'sales = step("Read the sales", inputs["sales"])',
    'sales["Revenue"] = pd.to_numeric(sales["Revenue"], errors="coerce")',
    'totals = sales.groupby("Region", sort=True)["Revenue"].sum()',
    'result("by_region", totals, "Revenue by region")',
    'result("total", totals.sum(), "Total revenue")',
    ...(joining ? ['merged = sales.merge(inputs["regions"], on="Region", how="left")'] : []),
  ].join("\n");
  return {
    tool: "run_analysis",
    input: {
      title: chinese ? "各地区收入" : "Revenue by region",
      inputs: [
        { name: "sales", passage: sales.id },
        ...(joining ? [{ name: "regions", passage: regions.id }] : []),
      ],
      code,
    },
  };
}

/** What the model does next, apart from Connector Tools: call a Tool, or stream its Answer. */
export function answerReply(prompt: Prompt, tools: readonly string[]): Reply {
  const question = lastQuestion(prompt);
  if (tools.includes("search_documents") && isCell(prompt)) return cellReply(prompt);
  if (tools.includes("use_skill") && toolResults(prompt, "use_skill").length === 0) {
    const named = skillNamed(prompt, question);
    if (named) return { tool: "use_skill", input: { name: named } };
  }
  const skill = skillFollowed(prompt);
  if (!tools.includes("search_documents")) return { text: fakeAnswer(question, skill) };
  if (INTO_A_REPORT.test(question)) return reportReply(prompt, question);
  if (tools.includes("read_document") && /read (?:the )?(?:results )?page/i.test(question)) {
    const pages = /page (\d+)/i.exec(question)?.[1];
    const document = /“([^”]+)”/.exec(question)?.[1];
    if (pages && document && toolResults(prompt, "read_document").length === 0) {
      return { tool: "read_document", input: { document, pages } };
    }
  }
  const given = passagesIn(lastUserText(prompt)).length > 0 && WITHOUT_SEARCHING.test(question);
  const searches = given
    ? [lastUserText(prompt)]
    : [...toolResults(prompt, "search_documents"), ...toolResults(prompt, "read_document")];
  if (searches.length === 0) {
    const minutes = minutesNamed(prompt, question);
    return {
      tool: "search_documents",
      input: { query: question, ...(minutes && { document: minutes }) },
      reasoning: reasoningFor(question),
    };
  }
  const reply: Reply =
    SEARCH_TWICE.test(question) && searches.length === 1
      ? { tool: "search_documents", input: { query: ownWords(question) } }
      : answerFrom(prompt, question, tools, searches, skill);
  // Searched before its first call, the model thinks on the first call it makes itself.
  return given || calledSinceQuestion(prompt)
    ? reply
    : { ...reply, reasoning: reasoningOnFound(question) };
}

/** What the model does once it has Passages to answer from. */
function answerFrom(
  prompt: Prompt,
  question: string,
  tools: readonly string[],
  searches: readonly string[],
  skill: string | null,
): Reply {
  if (tools.includes("run_analysis") && BY_REGION.test(question)) {
    const reply = analysisReply(prompt, question, searches.at(-1) ?? "");
    if (reply) return reply;
  }
  const claimed = prompt
    .filter((message) => message.role === "user")
    .map((message) => promptText([message]))
    .find((text) => CLAIMS_CALCULATION.test(text));
  if (claimed !== undefined) return { text: claimAnswer(claimed) };
  if (THINKING_ALOUD.test(question)) return { text: WORKING_NOTES };
  if (WITHOUT_CITING.test(question)) return { text: uncitedAnswer(question) };
  if (CITING_AS_TEXT.test(question)) {
    return { text: citedAsText(question, recordsFor(searches.at(-1) ?? "", question)) };
  }
  const cites = toolResults(prompt, "cite");
  if (cites.length === 0) {
    const records = recordsFor(searches.at(-1) ?? "", question);
    if (records.length > 0) return { tool: "cite", input: { citations: records } };
    return { text: fakeAnswer(question, skill) };
  }
  if (tools.includes("calculate") && /\bgrow|增长/i.test(question)) {
    const calculated = toolResults(prompt, "calculate");
    const share = /\bshare\b|占比/i.test(question);
    if (calculated.length === 0) {
      const inputs = [1, 2].map((position) => ({
        name: `n${position}`,
        label: position === 1 ? "Later" : "Earlier",
        citation: 1,
        position,
      }));
      return {
        tool: "calculate",
        input: {
          figures: [
            { marker: 1, label: "Growth", inputs, formula: "n1 / n2 - 1", as: "percent" },
            ...(share
              ? [{ marker: 2, label: "Share", inputs, formula: "n2 / n1", as: "percent" }]
              : []),
          ],
        },
      };
    }
    if (calculated.at(-1)?.startsWith("Recorded [=1]")) {
      const chinese = /增长/.test(question);
      if (share)
        return {
          text: chinese
            ? "增长了[=1][^1]，上年为本年的[=2][^1]。"
            : "It grew [=1] [^1], and the earlier year was [=2] of the later one [^1].",
        };
      return { text: chinese ? "增长了[=1][^1]。" : "It grew [=1] [^1].\n\nThat is all." };
    }
  }
  if (BEYOND_ITS_QUOTE.test(question)) {
    return {
      text: /\p{Script=Han}/u.test(question)
        ? "文档说这件事已经完成[^1]。"
        : "Your Documents say it is already done [^1].",
    };
  }
  const firstPassage = passagesIn(searches.at(-1) ?? "")[0];
  const quoted = firstPassage && recordFor(firstPassage, question, 1)?.quoted;
  if (quoted) {
    return {
      text: /\p{Script=Han}/u.test(question)
        ? `文档中写道“${quoted}”[^1]。`
        : `Your Documents say “${quoted}” [^1].`,
    };
  }
  // The markers the last cite call recorded: "Recorded [^1], [^2]." and then any problems.
  const recordedLine = /^Recorded ([^.]*)\./.exec(cites.at(-1) ?? "")?.[1] ?? "";
  const recorded = [...new Set([...recordedLine.matchAll(/\[\^\d+\]/g)].map((match) => match[0]))];
  const answer = BY_QUARTER_CHINESE.test(question)
    ? chineseFiguresAnswer(recorded[0] ?? "")
    : BY_QUARTER.test(question)
      ? figuresAnswer(
          recorded[0] ?? "",
          IN_MILLIONS.test(question) ? (figure) => `$${figure} million` : undefined,
        )
      : FOUR_COLUMNS.test(question)
        ? wideTableAnswer(recorded[0] ?? "")
        : TWO_TABLES.test(question)
          ? twoTablesAnswer(question)
          : NINE_ROWS.test(question)
            ? nineRowsAnswer(question, recorded[0] ?? "")
            : FORTY_CITATIONS.test(question) || FOUR_CITATIONS.test(question)
              ? citedSentencesAnswer(question, FORTY_CITATIONS.test(question) ? 40 : 4)
              : TWELVE_IN_A_ROW.test(question)
                ? twelveInARowAnswer(question)
                : CITED_BELOW.test(question) || FRAMED.test(question)
                  ? citedBelowAnswer(question, recorded[0] ?? "")
                  : AS_A_TABLE.test(question)
                    ? tableAnswer(recorded.join(" "))
                    : CONTRACT_COMPARISON.test(question)
                      ? contractComparisonAnswer(prompt, question, recorded[0] ?? "")
                      : NARROW_THEN_WIDE.test(question)
                        ? narrowThenWideAnswer(question, recorded[0] ?? "")
                        : LONG_HEADINGS.test(question)
                          ? longHeadingsAnswer(question, recorded[0] ?? "")
                          : recorded.length > 1
                            ? `Your Documents answer this ${recorded.join(" ")}.\n\nThat is all.`
                            : CITED_ANSWER;
  const said = withAsides(prompt, question, answer);
  return { text: skill ? `Following the Skill ${skill}.\n\n${said}` : said };
}
