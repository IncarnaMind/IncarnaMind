/**
 * A Question about the User's notes or what they selected ("notes", "selected",
 * 笔记, 选中), asked beside a Mind, gets an Answer that starts by saying what it
 * read of the Mind: its name and first line, and the selected text. One about
 * what someone changed ("change", 修订) lists the changes it read marked in
 * the Mind, with who made each (#734).
 *
 * In the assistant, with the Minds' Tools (#202, `mindsReply`): a request to
 * shorten (缩短, 改短), lengthen (长一点) or rewrite (改写), or to "replace X with Y", calls edit_mind with the request as its instruction,
 * which Edit with AI's scripted model carries out as Shorten, and so does one
 * "with a table" (加上表格), which it carries out by adding one (#961); one
 * for a new note (新笔记, 新建) calls create_mind, titled from what follows "called"
 * (叫), its content citing the Documents when there are any; and "add X to
 * <Mind>" (把 X 添加到 <Mind>) calls add_to_mind with X, and "add X" (添加 X)
 * adds X to the Mind in focus; "add X to <Mind> and make a new note called Y"
 * calls both. "Add a section on the risks" first lengthens the User's own
 * text with edit_mind, then adds the section, as a model sometimes does beyond
 * the request (#880). Each then replies with the first sentence of what its calls
 * came to; add_to_mind's and create_mind's input streams in word by word,
 * slowly for a Question asked "slowly", as does edit_mind's edit. "Write three
 * paragraphs" is `paragraphsReply`'s. "Write a summary page" (写一个总结页面)
 * calls create_mind with a short summary. "Write a summary of my leases"
 * (根据我的租约写一份总结) writes, naming the Documents in its scope, into a new
 * Mind, or the empty one it is asked from, so what it was written from shows (#1149).
 * "Make a bar chart of revenue by quarter" (画一个各季度收入的柱状图; "line chart",
 * 折线图) searches, cites each quarter's revenue, and adds them as a table with its
 * chart (#1091); "Make a bar chart of rent by lease" does the same with each unit's
 * monthly rent, so Use all can draw it again from every lease.
 * "Write a short summary of this agreement" (为这份协议写一份简短摘要) calls
 * add_to_mind with it, for the Mind in focus. "Write a short summary of this document"
 * (为这份文件写一份简短摘要) does too, "Written from" the first Document on screen (#1334).
 * "Write a brief summary" (写一份简要总结) adds one to the Mind in <mind>, but
 * answers that no Mind is open when that Mind has no name, as models did (#1212).
 * "Retell the summary" (重述总结) gives edit_mind the whole new text of the summary page, three
 * paragraphs for the two, as a model does to make it longer (#1335).
 * "Say you added the risks" (说你加了风险部分) claims a write and makes none.
 * "Write the tide report" (写一份潮汐报告) makes a report of eight paragraphs, and "Make the tide
 * report longer" (把潮汐报告写长一点) gives edit_mind its whole new text, four paragraphs changed and
 * one added, as a model does (#1488). "Write the packing list" makes a bulleted list, and "Update
 * the packing list" gives its new text, one item changed, one left out and one added.
 * "Summarise my leases without citing" (不加引用地总结我的租约) searches, then writes a summary
 * with no Citation into a new Mind, and again as it was once told it has none (#1415).
 */

import { answerReply, CITED_ANSWER } from "./answers";
import { ASSISTANT_REPLACES } from "./appliedEdits";
import { paragraphsReply } from "./paragraphs";
import { passagesIn } from "./passages";
import {
  lastQuestion,
  lastResult,
  lastUserText,
  type Prompt,
  type Reply,
  SHORTEN,
  systemOf,
  toolResults,
  userText,
} from "./prompt";

/** A Question about the User's notes or what they selected in them. */
const ABOUT_THE_MIND = /\bnotes?\b|\bselect(?:ed|ion)\b|笔记|选中/i;

/** A Question about what someone changed in the Mind. */
const ABOUT_THE_CHANGES = /\bchang(?:e|es|ed)\b|修订/i;

/** What the Answer says it read of the Mind a Question about it was asked beside, if any. */
export function mindRead(prompt: Prompt): string | null {
  const question = lastQuestion(prompt);
  const aboutChanges = ABOUT_THE_CHANGES.test(question);
  if (!ABOUT_THE_MIND.test(question) && !aboutChanges) return null;
  // The Mind starts the first user message, and the selection the last (#564).
  const text = lastUserText(prompt);
  const mind = /<mind name="([^"]*)">\n([\s\S]*?)<\/mind>/.exec(
    userText(prompt.find((message) => message.role === "user")),
  );
  if (!mind) return null;
  if (aboutChanges) {
    const changes = [...(mind[2] ?? "").matchAll(/\[(?:inserted|deleted) by [^\]]*\]/g)];
    return changes.length > 0
      ? `Changes in “${mind[1]}”: ${changes.map((each) => each[0]).join("; ")}`
      : `No changes are marked in “${mind[1]}”.`;
  }
  const first = (mind[2] ?? "")
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line !== "" && line !== "[…]")
    // A short Answer, however long the line.
    ?.slice(0, 80);
  const selection = /<selection>\n([\s\S]*?)\n<\/selection>/.exec(text)?.[1];
  return [
    first ? `Read “${mind[1]}”, which starts: ${first}` : `Read “${mind[1]}”, which is empty.`,
    ...(selection ? [`About what you selected: ${selection}`] : []),
  ].join("\n\n");
}

/**
 * The owner's two requests (#880): a summary page, then the same made longer (写一个总结页面, 再长一点);
 * and the owner's request for a written piece (#1109): 根据我现有的文件帮我写一份summary.
 */
const SUMMARY_PAGE =
  /\bwrite a summary page\b|写一个总结页面|\bwrite a summary of my documents\b|根据我现有的文件帮我写一份summary/i;
const LONGER = /\blonger\b|长一点|更长/i;
const RETELL = /\bretell the summary\b|重述总结/i;
const RETOLD = [
  "## Summary",
  "Spring tides come at new and full moon, when the Sun and the Moon line up.",
  "Neap tides come in between, at the quarter moons, when they pull apart.",
  "Both follow the Moon's cycle.",
].join("\n\n");
const REVENUE_CHART = /\bchart of revenue by quarter\b|各季度收入的(?:柱状图|折线图)/i;
const QUARTER_REVENUE = /Revenue in (Q\d+) was (€\d+ million)/g;
const RENT_CHART = /\bchart of rent by lease\b/i;
/** A table whose every cell is a claim, for the one check count (#1909). */
const CHECK_TABLE = /\brevenue table for checking\b|核对用的收入表格/iu;
const UNIT_RENT = /The monthly rent for (unit \d+) is (€[\d,]+)/g;
const LEASES_SUMMARY = /\bwrite a summary of my leases\b|根据我的租约写一份总结/i;
const BRIEF_SUMMARY = /\bbrief summary\b|简要总结/i;
/** A rewrite of the User's text (改写), which Edit with AI's scripted model writes anew. */
const REWRITE = /\brewrite\b|改写/i;
const SUMMARY = [
  "## Summary",
  "Spring tides come at new and full moon, when the Sun and the Moon pull together.",
  "Neap tides come in between, at the quarter moons.",
].join("\n\n");

const TIDE_REPORT = /\bthe tide report\b|潮汐报告/i;
const report = (title: string, paragraphs: readonly string[]) =>
  [`## ${title}`, ...paragraphs].join("\n\n");
const REPORT = {
  en: {
    title: "Tide report",
    written: [
      "Spring tides come at new and full moon.",
      "Neap tides come at the quarter moons.",
      "The harbour office posts the times each week.",
      "Boats rest on the mud at low water.",
      "Gulls wheel over the quay at dawn.",
      "The ferry runs twice a day in summer.",
      "Storms can raise the water by a metre.",
      "The lifeboat station opens on Sundays.",
    ],
    longer: [
      "Spring tides come at new and full moon, when the Sun and the Moon pull together.",
      "Twice a month, between the big tides, the range is smallest and the water barely turns.",
      "The harbour office posts the times each week.",
      "Boats rest on the soft mud at low water.",
      "Gulls wheel over the quay at dawn.",
      "Fishing boats leave on the first of the ebb.",
      "The ferry runs twice a day in summer.",
      "Storms from the west can raise the water by a metre.",
      "The lifeboat station opens on Sundays.",
    ],
  },
  zh: {
    title: "潮汐报告",
    written: [
      "大潮出现在新月和满月前后。",
      "小潮出现在上弦月和下弦月。",
      "港务处每周公布潮汐时间。",
      "退潮时船只停在泥滩上。",
      "黎明时海鸥在码头上空盘旋。",
      "夏季渡轮每天往返两次。",
      "风暴会让水位升高一米。",
      "救生艇站周日开放。",
    ],
    longer: [
      "大潮出现在新月和满月前后，这时太阳和月亮的引力叠加。",
      "每月有两次潮差最小的日子，海水几乎不涨不落。",
      "港务处每周公布潮汐时间。",
      "退潮时船只停在松软的泥滩上。",
      "黎明时海鸥在码头上空盘旋。",
      "渔船在退潮开始时出海。",
      "夏季渡轮每天往返两次。",
      "西来的风暴会让水位升高一米。",
      "救生艇站周日开放。",
    ],
  },
};
const PACKING_LIST = /\bthe packing list\b/i;
const PACKING = "## Packing list\n\n- A warm coat\n- Tide tables for May\n- A flask of tea";
const PACKING_UPDATED =
  "## Packing list\n\n- A warm coat with a hood\n- Tide tables for May\n- Spare socks";

/** The newcomer's first request (#1174): a short summary of "this agreement", written into the Mind in focus. */
const SUMMARY_HERE = /\bwrite a short summary of this agreement\b|为这份协议写一份简短摘要/i;

const SUMMARY_OF_THIS = /\bwrite a short summary of this document\b|为这份文件写一份简短摘要/i;
const ON_SCREEN = /^On screen now: "([^"]+)"/m;

/** A request to change the Mind so it has a table: "…, with a table" (加上表格). */
const WITH_A_TABLE = /\bwith a table\b|加上?表格/i;

/** A request for a new note, and its title after "called" (叫). */
const NEW_NOTE = /\bnew (?:note|mind)\b|新笔记|新建/i;
const CALLED = /\b(?:called|named|titled)\s+[“"]?(.+?)[”"]?[.。]?$|叫[“"]?(.+?)[”"]?的/iu;
/** A request to add something to a Mind by name: what, and to which. */
const ADD_TO =
  /^add\s+(.+?)\s+to\s+[“"]?(.+?)[”"]?[.。]?$|^把\s*(.+?)\s*添加到\s*[“"]?(.+?)[”"]?[。]?$/iu;
/** A request to add something to the Mind in focus: "add X" (添加 X). */
const ADD_HERE = /^add\s+(.+?)[.。]?$|^添加\s*(.+?)[。]?$/iu;
/** Both at once: "add X to <Mind> and make a new note called Y". */
const ADD_AND_NEW =
  /^add\s+(.+?)\s+to\s+[“"]?(.+?)[”"]?\s+and\s+(?:make|create)\s+a\s+new\s+note\s+called\s+[“"]?(.+?)[”"]?[.。]?$/iu;

const RISKS_AND_MORE = /^add a section on the risks[.。]?$/i;

/** The first sentence of what a call came to, as the scripted assistant's reply. */
const firstSentence = (result: string) => /^[^.。]*[.。]?/u.exec(result)?.[0] ?? result;

/**
 * The scripted assistant's choice with the Minds' Tools (see the top of this
 * file): a Tool call, the reply once it has returned, or null to answer.
 */
/** "Say you added the risks" (说你加了风险部分): a reply that claims a write no call made (#1559). */
const CLAIMS_A_WRITE = /^say you added the risks|^说你加了风险部分/i;
const UNCITED_SUMMARY = /\bsummari[sz]e my leases without citing\b|不加引用地总结我的租约/i;

export function mindsReply(prompt: Prompt, asked: string, names: readonly string[]): Reply | null {
  if (!names.includes("edit_mind")) return null;
  // Claims a write and makes none, asked again too, so the app then says nothing was written.
  const original = userText(
    prompt.findLast(
      (message) => message.role === "user" && !userText(message).includes("<tool-record>"),
    ),
  )
    .split("\n\n")
    .at(-1);
  if (original && CLAIMS_A_WRITE.test(original)) {
    return {
      text: /\p{Script=Han}/u.test(original)
        ? "我已经把风险部分加进了“Q3 review”。"
        : "I've added a risks section to “Q3 review”.",
    };
  }
  // Asked "slowly", only its pace changes.
  const question = asked.replace(/\s+slowly$/i, "");
  const paragraphs = paragraphsReply(prompt, question);
  if (paragraphs) return paragraphs;
  const both = ADD_AND_NEW.exec(question);
  if (both) {
    if (lastResult(prompt, "add_to_mind") === undefined) {
      return { tool: "add_to_mind", input: { mind: both[2], content: both[1] } };
    }
    const made = lastResult(prompt, "create_mind");
    if (made === undefined) {
      const content = "## Summary\n\nWritten by the scripted assistant.";
      return { tool: "create_mind", input: { title: both[3], content } };
    }
    return {
      text: `${firstSentence(lastResult(prompt, "add_to_mind") ?? "")} ${firstSentence(made)}`,
    };
  }
  if (RISKS_AND_MORE.test(question)) {
    if (lastResult(prompt, "edit_mind") === undefined)
      return { tool: "edit_mind", input: { instruction: "make it longer" } };
    const added = lastResult(prompt, "add_to_mind");
    if (added === undefined)
      return { tool: "add_to_mind", input: { content: "## Risks\n\nThe supplier is late." } };
    return { text: firstSentence(added) };
  }
  if (UNCITED_SUMMARY.test(question)) return uncitedSummary(prompt, question);
  if (REVENUE_CHART.test(question)) return revenueChart(prompt, question);
  if (RENT_CHART.test(question)) return tableChart(prompt, RENT);
  if (CHECK_TABLE.test(question)) return checkTable(prompt, question);
  if (LEASES_SUMMARY.test(question)) {
    const made = lastResult(prompt, "create_mind") ?? lastResult(prompt, "add_to_mind");
    if (made !== undefined) return { text: firstSentence(made) };
    const listed = /^Their names, newest first:\n((?:- .+\n?)+)/m.exec(systemOf(prompt))?.[1] ?? "";
    const names = [...listed.matchAll(/^- (.+)$/gm)].map((line) => line[1]).sort();
    const content = `Written from ${names.join(", ")}.`;
    // An empty Mind is filled; any other gets a new one beside it.
    return systemOf(prompt).includes("The Mind in <mind> is open and still empty")
      ? { tool: "add_to_mind", input: { content } }
      : { tool: "create_mind", input: { title: "Summary", content } };
  }
  if (BRIEF_SUMMARY.test(question)) {
    const mind = userText(prompt.find((message) => message.role === "user"));
    if (!/<mind name="[^"]+">/.test(mind)) {
      return {
        text: /\p{Script=Han}/u.test(question)
          ? "没有打开的笔记，所以没法写进去。"
          : "No Mind is open, so I can't write it there.",
      };
    }
    const added = lastResult(prompt, "add_to_mind");
    if (added === undefined) return { tool: "add_to_mind", input: { content: SUMMARY } };
    return { text: firstSentence(added) };
  }
  if (SUMMARY_PAGE.test(question)) {
    const made = lastResult(prompt, "create_mind");
    if (made === undefined)
      return { tool: "create_mind", input: { title: "Summary", content: SUMMARY } };
    return { text: firstSentence(made) };
  }
  if (SUMMARY_OF_THIS.test(question)) {
    const added = lastResult(prompt, "add_to_mind");
    if (added !== undefined) return { text: firstSentence(added) };
    const shown = ON_SCREEN.exec(lastUserText(prompt))?.[1];
    return shown
      ? { tool: "add_to_mind", input: { content: `Written from ${shown}.` } }
      : { text: "Which Document do you mean?" };
  }
  if (SUMMARY_HERE.test(question)) {
    const added = lastResult(prompt, "add_to_mind");
    if (added === undefined) return { tool: "add_to_mind", input: { content: SUMMARY } };
    return { text: firstSentence(added) };
  }
  if (TIDE_REPORT.test(question) || PACKING_LIST.test(question)) {
    const done = lastResult(prompt, "create_mind") ?? lastResult(prompt, "edit_mind");
    if (done !== undefined) return { text: firstSentence(done) };
    const { title, written, longer } = /\p{Script=Han}/u.test(question) ? REPORT.zh : REPORT.en;
    if (PACKING_LIST.test(question)) {
      return /^write\b/i.test(question)
        ? { tool: "create_mind", input: { title: "Packing list", content: PACKING } }
        : { tool: "edit_mind", input: { content: PACKING_UPDATED } };
    }
    return LONGER.test(question)
      ? { tool: "edit_mind", input: { content: report(title, longer) } }
      : { tool: "create_mind", input: { title, content: report(title, written) } };
  }
  if (RETELL.test(question)) {
    const result = lastResult(prompt, "edit_mind");
    if (result === undefined) return { tool: "edit_mind", input: { content: RETOLD } };
    return { text: firstSentence(result) };
  }
  if (
    SHORTEN.test(question) ||
    LONGER.test(question) ||
    REWRITE.test(question) ||
    ASSISTANT_REPLACES.test(question) ||
    WITH_A_TABLE.test(question)
  ) {
    const result = lastResult(prompt, "edit_mind");
    // Asked "slowly", the edit is written slowly too.
    if (result === undefined) return { tool: "edit_mind", input: { instruction: asked } };
    return { text: firstSentence(result) };
  }
  const add = ADD_TO.exec(question);
  if (add) {
    const result = lastResult(prompt, "add_to_mind");
    if (result === undefined) {
      return {
        tool: "add_to_mind",
        input: { mind: add[2] ?? add[4], content: add[1] ?? add[3] },
      };
    }
    return { text: firstSentence(result) };
  }
  const here = ADD_HERE.exec(question);
  if (here) {
    const result = lastResult(prompt, "add_to_mind");
    if (result === undefined)
      return { tool: "add_to_mind", input: { content: here[1] ?? here[2] } };
    return { text: firstSentence(result) };
  }
  if (!NEW_NOTE.test(question)) return null;
  const made = lastResult(prompt, "create_mind");
  if (made !== undefined) return { text: firstSentence(made) };
  const cited = toolResults(prompt, "cite").length > 0;
  if (names.includes("search_documents") && !cited) {
    const reply = answerReply(prompt, names);
    if ("tool" in reply) return reply;
  }
  const called = CALLED.exec(question);
  const title = called?.[1] ?? called?.[2] ?? "Scripted notes";
  const content = `## Summary\n\n${cited ? CITED_ANSWER : "Written by the scripted assistant."}`;
  return { tool: "create_mind", input: { title, content } };
}

function uncitedSummary(prompt: Prompt, question: string): Reply {
  if (lastResult(prompt, "search_documents") === undefined) {
    return { tool: "search_documents", input: { query: "monthly rent" } };
  }
  const made = lastResult(prompt, "create_mind");
  if (made !== undefined && !made.includes("content has no Citation")) {
    return { text: firstSentence(made) };
  }
  return /\p{Script=Han}/u.test(question)
    ? {
        tool: "create_mind",
        input: { title: "租约总结", content: "## 总结\n\n租约规定了每月的租金。" },
      }
    : {
        tool: "create_mind",
        input: {
          title: "Lease summary",
          content: "## Summary\n\nThe leases set the monthly rent.",
        },
      };
}

interface ChartedFigures {
  query: string;
  pattern: RegExp;
  header: string;
  title: string;
  kind: "bar" | "line";
}

const RENT: ChartedFigures = {
  query: "monthly rent",
  pattern: UNIT_RENT,
  header: "| Lease | Rent |",
  title: "Rent by lease",
  kind: "bar",
};

/** A table of the Document's revenue lines, each cell a claim that cites the line (#1909). */
function checkTable(prompt: Prompt, question: string): Reply {
  const added = lastResult(prompt, "add_to_mind");
  if (added !== undefined) return { text: firstSentence(added) };
  const [searched] = toolResults(prompt, "search_documents");
  if (searched === undefined) {
    return { tool: "search_documents", input: { query: "revenue by quarter" } };
  }
  const found = passagesIn(searched)
    .flatMap((passage) =>
      [...passage.text.matchAll(QUARTER_REVENUE)].map((match) => ({
        passage: passage.id,
        label: match[1] ?? "",
        figure: match[2] ?? "",
        quote: match[0],
      })),
    )
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  if (toolResults(prompt, "cite").length === 0) {
    return {
      tool: "cite",
      input: {
        citations: found.map((each, index) => ({
          marker: index + 1,
          passage: each.passage,
          quote: each.quote,
        })),
      },
    };
  }
  const chinese = /\p{Script=Han}/u.test(question);
  const table = [
    chinese ? "| 季度 | 收入 |" : "| Quarter | Revenue |",
    "|---|---|",
    ...found.map(
      (each, index) =>
        `| ${each.label} | Revenue in ${each.label} was ${each.figure} [^${index + 1}] |`,
    ),
  ].join("\n");
  return { tool: "add_to_mind", input: { content: table } };
}

function revenueChart(prompt: Prompt, question: string): Reply {
  const chinese = /\p{Script=Han}/u.test(question);
  return tableChart(prompt, {
    query: "revenue by quarter",
    pattern: QUARTER_REVENUE,
    header: chinese ? "| 季度 | 收入 |" : "| Quarter | Revenue |",
    title: chinese ? "各季度收入" : "Revenue by quarter",
    kind: /\bline chart\b|折线图/i.test(question) ? "line" : "bar",
  });
}

function tableChart(prompt: Prompt, figures: ChartedFigures): Reply {
  const added = lastResult(prompt, "add_to_mind");
  if (added !== undefined) return { text: firstSentence(added) };
  const [searched] = toolResults(prompt, "search_documents");
  if (searched === undefined) return { tool: "search_documents", input: { query: figures.query } };
  const found = passagesIn(searched)
    .flatMap((passage) =>
      [...passage.text.matchAll(figures.pattern)].map((match) => ({
        passage: passage.id,
        label: match[1] ?? "",
        figure: match[2] ?? "",
        quote: match[0],
      })),
    )
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  if (toolResults(prompt, "cite").length === 0) {
    const citations = found.map((each, index) => ({
      marker: index + 1,
      passage: each.passage,
      quote: each.quote,
    }));
    return { tool: "cite", input: { citations } };
  }
  const table = [
    figures.header,
    "|---|---|",
    ...found.map((each, index) => `| ${each.label} | ${each.figure} [^${index + 1}] |`),
  ].join("\n");
  return {
    tool: "add_to_mind",
    input: { chart: { kind: figures.kind, title: figures.title }, content: table },
  };
}
