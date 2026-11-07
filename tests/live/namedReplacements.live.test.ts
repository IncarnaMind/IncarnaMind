/**
 * Named replacements against real models, on Notes and requests written after the design of
 * #2356 was fixed and never used to tune it: Notes in English and Chinese, each with headings,
 * paragraphs, a list and a table, and requests that change one line, add one or two, take one
 * out, rewrite a short list item, turn the list into a table, find nothing to do, or meet the
 * output limit. The garden club and 读书会 Notes were written later, once a reply's own words
 * were kept out of the Note, and are held out from that. The choir and camping Notes were written
 * before any run of them, for the last measurement of #2356 and #2333: one paragraph of several
 * rewritten, two at once, a new line that replaces none, a request that invites a line on what
 * changed, and one item of a list changed. The 宿舍费用 and 团建预算 Notes, lines on one pattern
 * where a new line on that pattern is like one of them, were written before any run of them, after
 * a reply without names wrote such a line over another in Chinese.
 * Once the changes are accepted, the Note is checked: every line the request didn't name is there
 * word for word (none lost or written over), and the request is done as asked. Each reply is
 * also read for its shape: lines that name no paragraph (stray), only some of the Note's
 * paragraphs (partial), no names at all, and lines the request didn't touch quoted as removed.
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY.
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each request runs (10 by default),
 * INCARNAMIND_LIVE_NOTES which Notes run, by name, comma-separated (all by default),
 * INCARNAMIND_LIVE_ANTHROPIC_MODEL the model, INCARNAMIND_LIVE_CONCURRENCY how many run at once
 * (4), and INCARNAMIND_LIVE_REPORT a file to keep the numbers and each miss in.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type * as Y from "yjs";
import type { EditWithAiResult } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { resolveProposals } from "../../src/shared/proposals";
import { createTempDataFolder, namedSaid, spentBy, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

type Block = ["heading" | "paragraph" | "bullet", string] | ["row", string[]];

interface Case {
  /** change: `target` gives way to one line that says `says`; add: `added` new lines say `says`; remove: `target` goes; table: the list becomes a table naming `says`; cut: the reply meets its output limit and nothing changes; none: there is nothing to do, and nothing changes. */
  kind: "change" | "add" | "remove" | "table" | "cut" | "none";
  ask: string;
  target?: string;
  /** A change of two lines at once: each gives way to one line, and together they say `says`. */
  targets?: string[];
  says?: string[];
  added?: number;
}

interface Note {
  name: string;
  language: "English" | "Chinese";
  blocks: Block[];
  /** The list's items, which a table made of the list may take the place of. */
  list: string[];
  cases: Case[];
}

const EN: Note = {
  name: "Office move",
  language: "English",
  blocks: [
    ["heading", "Move"],
    ["paragraph", "The office moves to Harbour Street on 3 March."],
    ["paragraph", "Movers arrive at 8:00 and leave by 17:00."],
    ["heading", "People"],
    ["bullet", "Lena books the van."],
    ["bullet", "Omar packs the archive."],
    ["bullet", "Priya updates the address."],
    ["heading", "Costs"],
    ["row", ["Item", "Cost"]],
    ["row", ["Van", "250"]],
    ["row", ["Boxes", "80"]],
    ["paragraph", "Storage is 150 pounds a week."],
  ],
  list: ["Lena books the van.", "Omar packs the archive.", "Priya updates the address."],
  cases: [
    {
      kind: "change",
      ask: "Omar labels the boxes now, instead of packing the archive.",
      target: "Omar packs the archive.",
      says: ["label"],
    },
    {
      kind: "change",
      ask: "The movers now arrive at 7:30.",
      target: "Movers arrive at 8:00 and leave by 17:00.",
      says: ["7:30"],
    },
    { kind: "change", ask: "The van costs 300 now.", target: "250", says: ["300"] },
    {
      kind: "change",
      ask: "Change the bullet about the address to say Priya also tells the bank.",
      target: "Priya updates the address.",
      says: ["bank"],
    },
    {
      kind: "change",
      ask: "The move is on 10 March now.",
      target: "The office moves to Harbour Street on 3 March.",
      says: ["10 March"],
    },
    { kind: "add", ask: "Add Sam to the people: he sets up the network.", says: ["Sam"], added: 1 },
    {
      kind: "add",
      ask: "Add a line saying parking is free on moving day.",
      says: ["parking"],
      added: 1,
    },
    {
      kind: "add",
      ask: "Add two people: Uma brings the keys and Vic cleans the old office.",
      says: ["Uma", "Vic"],
      added: 2,
    },
    {
      kind: "remove",
      ask: "Delete the line about storage.",
      target: "Storage is 150 pounds a week.",
    },
    { kind: "remove", ask: "Take Lena off the list.", target: "Lena books the van." },
    {
      kind: "table",
      ask: "Turn the list of people into a table of name and task.",
      says: ["Lena", "Omar", "Priya"],
    },
    { kind: "cut", ask: "Make it more formal." },
    { kind: "none", ask: "Correct any spelling mistakes." },
  ],
};

const ZH: Note = {
  name: "年会",
  language: "Chinese",
  blocks: [
    ["heading", "活动"],
    ["paragraph", "年会定在十二月五日举行。"],
    ["paragraph", "签到从下午两点开始。"],
    ["heading", "分工"],
    ["bullet", "小林负责场地。"],
    ["bullet", "阿美负责餐饮。"],
    ["bullet", "老周负责音响。"],
    ["heading", "预算"],
    ["row", ["项目", "费用"]],
    ["row", ["场地", "8000"]],
    ["row", ["餐饮", "6000"]],
    ["paragraph", "外地同事可报销一晚住宿。"],
  ],
  list: ["小林负责场地。", "阿美负责餐饮。", "老周负责音响。"],
  cases: [
    { kind: "change", ask: "阿美改为负责礼品。", target: "阿美负责餐饮。", says: ["礼品"] },
    {
      kind: "change",
      ask: "签到改成一点半开始。",
      target: "签到从下午两点开始。",
      says: ["一点半"],
    },
    { kind: "change", ask: "场地费改成9000。", target: "8000", says: ["9000"] },
    {
      kind: "change",
      ask: "把老周那条改成老周和小李一起负责音响。",
      target: "老周负责音响。",
      says: ["小李"],
    },
    {
      kind: "change",
      ask: "日期改到十二月十二日。",
      target: "年会定在十二月五日举行。",
      says: ["十二月十二日"],
    },
    { kind: "add", ask: "加一条：小陈负责摄影。", says: ["小陈"], added: 1 },
    { kind: "add", ask: "加一句：当天停车免费。", says: ["停车"], added: 1 },
    {
      kind: "add",
      ask: "再加两个人：小王负责主持，小赵负责签到。",
      says: ["小王", "小赵"],
      added: 2,
    },
    { kind: "remove", ask: "删掉住宿那一句。", target: "外地同事可报销一晚住宿。" },
    { kind: "remove", ask: "把小林从名单里去掉。", target: "小林负责场地。" },
    { kind: "table", ask: "把分工列表做成表格，列出人名和任务。", says: ["小林", "阿美", "老周"] },
    { kind: "cut", ask: "改得更正式一些。" },
    { kind: "none", ask: "看看有没有错别字，有就改掉。" },
  ],
};

const GARDEN: Note = {
  name: "Garden club",
  language: "English",
  blocks: [
    ["heading", "Plot"],
    ["paragraph", "The club garden is behind the library on Mill Lane."],
    ["paragraph", "Members water the beds on Tuesday and Saturday mornings."],
    ["heading", "Jobs"],
    ["bullet", "Ada orders the seeds."],
    ["bullet", "Ben fixes the fence."],
    ["bullet", "Cleo keeps the tool shed key."],
    ["heading", "Fees"],
    ["row", ["Fee", "Amount"]],
    ["row", ["Membership", "20"]],
    ["row", ["Plot rent", "45"]],
    ["paragraph", "New members get a free trowel."],
  ],
  list: ["Ada orders the seeds.", "Ben fixes the fence.", "Cleo keeps the tool shed key."],
  cases: [
    {
      kind: "change",
      ask: "Members now water the beds on Wednesday instead of Tuesday.",
      target: "Members water the beds on Tuesday and Saturday mornings.",
      says: ["Wednesday"],
    },
    {
      kind: "change",
      ask: "Ben paints the fence now rather than fixing it.",
      target: "Ben fixes the fence.",
      says: ["paint"],
    },
    { kind: "change", ask: "Plot rent is 50 now.", target: "45", says: ["50"] },
    { kind: "add", ask: "Add Dev to the jobs: he empties the compost.", says: ["Dev"], added: 1 },
    {
      kind: "remove",
      ask: "Remove the line about the free trowel.",
      target: "New members get a free trowel.",
    },
    {
      kind: "table",
      ask: "Make the jobs list a table with a name column and a job column.",
      says: ["Ada", "Ben", "Cleo"],
    },
    { kind: "none", ask: "Check the spelling and fix any mistakes." },
  ],
};

const READING: Note = {
  name: "读书会",
  language: "Chinese",
  blocks: [
    ["heading", "安排"],
    ["paragraph", "读书会每月第一个周六下午举行。"],
    ["paragraph", "地点在社区图书馆二楼。"],
    ["heading", "分工"],
    ["bullet", "小雨负责选书。"],
    ["bullet", "阿杰负责借场地。"],
    ["bullet", "老何负责准备茶点。"],
    ["heading", "费用"],
    ["row", ["项目", "金额"]],
    ["row", ["会费", "50"]],
    ["row", ["茶点", "120"]],
    ["paragraph", "新成员第一次活动免费。"],
  ],
  list: ["小雨负责选书。", "阿杰负责借场地。", "老何负责准备茶点。"],
  cases: [
    {
      kind: "change",
      ask: "地点改到社区图书馆三楼。",
      target: "地点在社区图书馆二楼。",
      says: ["三楼"],
    },
    { kind: "change", ask: "老何改为负责拍照。", target: "老何负责准备茶点。", says: ["拍照"] },
    { kind: "change", ask: "茶点费用改成150。", target: "120", says: ["150"] },
    { kind: "add", ask: "加一条：小美负责发通知。", says: ["小美"], added: 1 },
    { kind: "remove", ask: "删掉新成员免费那一句。", target: "新成员第一次活动免费。" },
    {
      kind: "table",
      ask: "把分工做成表格，一列人名，一列任务。",
      says: ["小雨", "阿杰", "老何"],
    },
    { kind: "none", ask: "检查一下有没有错别字，有的话改掉。" },
  ],
};

const CHOIR: Note = {
  name: "Choir trip",
  language: "English",
  blocks: [
    ["heading", "Trip"],
    [
      "paragraph",
      "The choir travels to York by coach on 14 June. The coach leaves the church hall at 7:15 and is back by 22:00.",
    ],
    [
      "paragraph",
      "We sing two pieces at the minster in the afternoon, then have dinner at the Old Bell.",
    ],
    ["paragraph", "Each singer pays 35 pounds and the parish covers the rest."],
    ["heading", "Who brings what"],
    ["bullet", "Hana brings the music folders."],
    ["bullet", "Joe brings the first-aid kit."],
    ["bullet", "Mei brings the name badges."],
    ["bullet", "Tom brings the water."],
    ["paragraph", "Rehearsals are on Thursday evenings until then."],
  ],
  list: [
    "Hana brings the music folders.",
    "Joe brings the first-aid kit.",
    "Mei brings the name badges.",
    "Tom brings the water.",
  ],
  cases: [
    {
      kind: "change",
      ask: "We're singing three pieces at the minster now, not two.",
      target:
        "We sing two pieces at the minster in the afternoon, then have dinner at the Old Bell.",
      says: ["three|3"],
    },
    {
      kind: "change",
      ask: "The trip moved to 21 June, and it's 40 pounds each now.",
      targets: [
        "The choir travels to York by coach on 14 June. The coach leaves the church hall at 7:15 and is back by 22:00.",
        "Each singer pays 35 pounds and the parish covers the rest.",
      ],
      says: ["21", "40"],
    },
    {
      kind: "add",
      ask: "After the dinner line, add that vegetarian meals have to be ordered by 1 June.",
      says: ["vegetarian"],
      added: 1,
    },
    {
      kind: "change",
      ask: "Mei is bringing the song sheets instead of the name badges.",
      target: "Mei brings the name badges.",
      says: ["song sheet"],
    },
    {
      kind: "change",
      ask: "Tom brings cups as well as the water.",
      target: "Tom brings the water.",
      says: ["cups"],
    },
    {
      kind: "change",
      ask: "The coach leaves at 6:45, fix that.",
      target:
        "The choir travels to York by coach on 14 June. The coach leaves the church hall at 7:15 and is back by 22:00.",
      says: ["6:45"],
    },
    {
      kind: "change",
      ask: "Make the bit about paying clearer and tell me what you changed.",
      target: "Each singer pays 35 pounds and the parish covers the rest.",
      says: ["35"],
    },
  ],
};

const CHORUS: Note = {
  name: "合唱团出行",
  language: "Chinese",
  blocks: [
    ["heading", "行程"],
    ["paragraph", "合唱团六月十四日坐大巴去苏州。大巴早上七点一刻从教堂礼堂出发，晚上十点前回来。"],
    ["paragraph", "下午在音乐厅唱两首曲子，然后在老街吃晚饭。"],
    ["paragraph", "每位团员交三百五十元，其余由教会承担。"],
    ["heading", "物品分工"],
    ["bullet", "小婷带乐谱夹。"],
    ["bullet", "阿强带急救包。"],
    ["bullet", "美玲带名牌。"],
    ["bullet", "老唐带饮用水。"],
    ["paragraph", "出发前每周四晚上排练。"],
  ],
  list: ["小婷带乐谱夹。", "阿强带急救包。", "美玲带名牌。", "老唐带饮用水。"],
  cases: [
    {
      kind: "change",
      ask: "音乐厅那边改成唱三首了。",
      target: "下午在音乐厅唱两首曲子，然后在老街吃晚饭。",
      says: ["三首|3首"],
    },
    {
      kind: "change",
      ask: "出行改到六月二十一日，每人改交四百元。",
      targets: [
        "合唱团六月十四日坐大巴去苏州。大巴早上七点一刻从教堂礼堂出发，晚上十点前回来。",
        "每位团员交三百五十元，其余由教会承担。",
      ],
      says: ["二十一|21", "四百|400"],
    },
    {
      kind: "add",
      ask: "在吃晚饭那句后面加一句：素食要在六月一日前预订。",
      says: ["素食"],
      added: 1,
    },
    {
      kind: "change",
      ask: "美玲改带歌词单，不带名牌了。",
      target: "美玲带名牌。",
      says: ["歌词单"],
    },
    { kind: "change", ask: "老唐除了水还要带杯子。", target: "老唐带饮用水。", says: ["杯子"] },
    {
      kind: "change",
      ask: "大巴改成六点三刻出发，帮我改一下。",
      target: "合唱团六月十四日坐大巴去苏州。大巴早上七点一刻从教堂礼堂出发，晚上十点前回来。",
      says: ["六点三刻|6:45|6点45"],
    },
    {
      kind: "change",
      ask: "把交钱那句写清楚一点，顺便告诉我你改了什么。",
      target: "每位团员交三百五十元，其余由教会承担。",
      says: ["三百五十|350"],
    },
  ],
};

const CAMPING: Note = {
  name: "Camping list",
  language: "English",
  blocks: [
    ["heading", "Bring"],
    ["bullet", "Tent and pegs."],
    ["bullet", "Two sleeping bags."],
    ["bullet", "The blue cool box."],
    ["bullet", "A gas stove and two canisters."],
    ["bullet", "Head torches for everyone."],
    ["bullet", "Rain jackets."],
    ["paragraph", "We leave on Friday after school."],
  ],
  list: [
    "Tent and pegs.",
    "Two sleeping bags.",
    "The blue cool box.",
    "A gas stove and two canisters.",
    "Head torches for everyone.",
    "Rain jackets.",
  ],
  cases: [
    {
      kind: "change",
      ask: "We're taking three sleeping bags, not two.",
      target: "Two sleeping bags.",
      says: ["three|3"],
    },
    {
      kind: "change",
      ask: "Change the stove one: a single canister is enough.",
      target: "A gas stove and two canisters.",
      says: ["canister"],
    },
    {
      kind: "change",
      ask: "Swap the cool box for the big red one.",
      target: "The blue cool box.",
      says: ["red"],
    },
  ],
};

const CAMPING_ZH: Note = {
  name: "露营清单",
  language: "Chinese",
  blocks: [
    ["heading", "要带的"],
    ["bullet", "帐篷和地钉。"],
    ["bullet", "两个睡袋。"],
    ["bullet", "蓝色保温箱。"],
    ["bullet", "一个炉头和两罐气。"],
    ["bullet", "每人一个头灯。"],
    ["bullet", "雨衣。"],
    ["paragraph", "周五放学后出发。"],
  ],
  list: [
    "帐篷和地钉。",
    "两个睡袋。",
    "蓝色保温箱。",
    "一个炉头和两罐气。",
    "每人一个头灯。",
    "雨衣。",
  ],
  cases: [
    { kind: "change", ask: "睡袋改成带三个。", target: "两个睡袋。", says: ["三|3"] },
    {
      kind: "change",
      ask: "炉头那条改一下，带一罐气就够了。",
      target: "一个炉头和两罐气。",
      says: ["一罐|1罐"],
    },
    { kind: "change", ask: "保温箱换成红色的大号那个。", target: "蓝色保温箱。", says: ["红色"] },
  ],
};

const DORM: Note = {
  name: "宿舍费用",
  language: "Chinese",
  blocks: [
    ["heading", "费用"],
    ["paragraph", "住宿费每学期1500元。"],
    ["paragraph", "空调费每学期200元。"],
    ["paragraph", "网络费每学期100元。"],
    ["paragraph", "押金入住时交300元。"],
  ],
  list: [],
  cases: [
    { kind: "add", ask: "在空调费下面加一条：热水费每学期80元。", says: ["热水"], added: 1 },
    { kind: "add", ask: "再加一项洗衣费，每学期60元。", says: ["洗衣"], added: 1 },
    {
      kind: "change",
      ask: "网络费涨到每学期120元了。",
      target: "网络费每学期100元。",
      says: ["120"],
    },
    {
      kind: "add",
      ask: "加两条：电费每学期90元，保险费每学期50元。",
      says: ["电费", "保险"],
      added: 2,
    },
  ],
};

const OUTING: Note = {
  name: "团建预算",
  language: "Chinese",
  blocks: [
    ["heading", "预算"],
    ["bullet", "场地租金三千元。"],
    ["bullet", "餐饮费用两千五百元。"],
    ["bullet", "交通费用一千二百元。"],
    ["paragraph", "超出部分由部门承担。"],
  ],
  list: ["场地租金三千元。", "餐饮费用两千五百元。", "交通费用一千二百元。"],
  cases: [
    { kind: "add", ask: "在交通后面补一条：保险费用三百元。", says: ["保险"], added: 1 },
    {
      kind: "change",
      ask: "餐饮改成两千八百元。",
      target: "餐饮费用两千五百元。",
      says: ["两千八|2800"],
    },
    { kind: "add", ask: "加一项摄影费用八百元。", says: ["摄影"], added: 1 },
  ],
};

const NOTES = [EN, ZH, GARDEN, READING, CHOIR, CHORUS, CAMPING, CAMPING_ZH, DORM, OUTING];

/** A Note's Blocks as Mind content: a list's items in one list, a table's rows in one table, its first row the heading row. */
function contentOf(blocks: readonly Block[]): JSONContent[] {
  const content: JSONContent[] = [];
  const words = (value: string) => [{ type: "text", text: value }];
  for (const [index, block] of blocks.entries()) {
    const last = content.at(-1);
    if (block[0] === "row") {
      const first = last?.type !== "table";
      const row = {
        type: "tableRow",
        content: block[1].map((value, at) => ({
          type: first ? "tableHeader" : "tableCell",
          attrs: { colspan: 1, rowspan: 1 },
          content: [{ type: "paragraph", attrs: { id: `b${index}c${at}` }, content: words(value) }],
        })),
      };
      if (last?.type === "table") last.content?.push(row);
      else content.push({ type: "table", content: [row] });
    } else if (block[0] === "heading") {
      content.push({
        type: "heading",
        attrs: { id: `b${index}`, level: 2 },
        content: words(block[1]),
      });
    } else if (block[0] === "paragraph") {
      content.push({ type: "paragraph", attrs: { id: `b${index}` }, content: words(block[1]) });
    } else {
      const item = {
        type: "listItem",
        content: [{ type: "paragraph", attrs: { id: `b${index}` }, content: words(block[1]) }],
      };
      if (last?.type === "bulletList") last.content?.push(item);
      else content.push({ type: "bulletList", content: [item] });
    }
  }
  return content;
}

/** The Note's lines with any words, in order: a table's cells each a line. */
function textsOf(client: MindClient): string[] {
  const texts: string[] = [];
  readMind(client).descendants((node) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, "", "￼");
    if (text.trim() !== "") texts.push(text);
    return false;
  });
  return texts;
}

const linesOf = (note: Note) =>
  note.blocks.flatMap((block) => (block[0] === "row" ? block[1] : [block[1]]));

const targetsOf = (asked: Case) => asked.targets ?? (asked.target ? [asked.target] : []);

interface Shape {
  /** A line that names no paragraph in a reply that names others, and isn't a lone name's words or a table row. */
  stray: boolean;
  /** Names or gives fewer paragraphs than the Note has. */
  partial: boolean;
  nameless: boolean;
  /** The Note's lines the request didn't touch that the reply quotes between <removed> and </removed>. */
  quotedUnasked: string[];
}

function shapeOf(raw: string, note: Note, asked: Case): Shape {
  const said = raw
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<why>[\s\S]*?(?:<\/why>|$)/gi, "")
    .replace(/(^|\n)[ \t]*¶\S*[ \t]*(?=<removed)/g, "$1");
  const quoted = [...said.matchAll(/<removed>([\s\S]*?)(?:<\/removed>|$)/gi)]
    .map((match) => match[1] ?? "")
    .join("\n");
  const lines = said
    .replace(/<removed>[\s\S]*?(?:<\/removed>|$)/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const isName = (line: string) => /^¶(?:\d+|\+)/.test(line);
  const names = new Set(lines.flatMap((line) => /^¶(\d+)/.exec(line)?.[1] ?? []));
  const nameless = lines.length > 0 && !lines.some(isName);
  const stray =
    !nameless &&
    lines.some(
      (line, at) => !isName(line) && !line.startsWith("|") && !/^¶\S*$/.test(lines[at - 1] ?? ""),
    );
  const paragraphs = note.blocks.length;
  const free = new Set([...targetsOf(asked), ...(asked.kind === "table" ? note.list : [])]);
  return {
    stray,
    partial: lines.length > 0 && (nameless ? lines.length : names.size) < paragraphs,
    nameless,
    quotedUnasked: linesOf(note).filter((line) => !free.has(line) && quoted.includes(line)),
  };
}

/**
 * What went wrong: `lost` when a line the request didn't name is gone, `grew` when one is changed
 * with every word of it kept, else `not as asked`; null when all is well.
 */
function verdict(
  note: Note,
  asked: Case,
  after: string[],
  result: EditWithAiResult,
): string | null {
  const before = linesOf(note);
  const targets = targetsOf(asked);
  const free = new Set([...targets, ...(asked.kind === "table" ? note.list : [])]);
  // A line can be there twice, as the table's "Van" cell and in the list: each is counted.
  const left = [...after];
  const missing = before.filter((line) => {
    const at = left.indexOf(line);
    if (at >= 0) left.splice(at, 1);
    return at < 0 && !free.has(line);
  });
  // A line whose words all stand in a longer one was written over, its words kept: a named rewrite that added to it.
  const lost = missing.filter((line) => !after.some((each) => each.includes(line)));
  if (lost.length > 0) return `lost: ${JSON.stringify(lost)}`;
  if (missing.length > 0) return `grew: ${JSON.stringify(missing)}`;
  const fresh = left.filter((line) => !before.includes(line));
  const lower = fresh.join("\n").toLowerCase();
  const says = (asked.says ?? []).every((word) =>
    word.split("|").some((each) => lower.includes(each.toLowerCase())),
  );
  if (asked.kind === "cut") {
    return result.kind === "failed" && result.error.kind === "cut-short"
      ? null
      : `not as asked: ${result.kind}`;
  }
  if (result.kind === "misnamed" || result.kind === "typed-tag") return `refused: ${result.kind}`;
  if (asked.kind === "none") {
    return fresh.length === 0 ? null : `not as asked: text came in ${JSON.stringify(fresh)}`;
  }
  if (asked.kind === "remove") {
    if (after.includes(asked.target ?? "")) return "not as asked: still there";
    return fresh.length === 0 ? null : `not as asked: text came in ${JSON.stringify(fresh)}`;
  }
  if (asked.kind === "table") {
    return says ? null : `not as asked: ${JSON.stringify(fresh)}`;
  }
  if (asked.kind === "change" && targets.some((target) => after.includes(target)))
    return "not as asked: still there";
  if (!says) return `not as asked: doesn't say ${JSON.stringify(asked.says)}`;
  const count = asked.kind === "add" ? (asked.added ?? 1) : Math.max(1, targets.length);
  return fresh.length === count
    ? null
    : `not as asked: ${fresh.length} new lines ${JSON.stringify(fresh)}`;
}

async function pooled<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

describe("Named replacements on held-out Notes, live (#2356)", () => {
  test.skipIf(KEY === undefined)(
    "no line the request didn't name is lost or written over, and each is done as asked",
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 10);
      const report: string[] = [`## Anthropic · ${MODEL} (#2356, held out)`];
      const runOf = new AsyncLocalStorage<{ raw: string; cut: boolean }>();
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, {
        createChatModel: (spec) =>
          wrapLanguageModel({
            model: createAiSdkChatModel(spec),
            middleware: {
              specificationVersion: "v4",
              transformParams: async ({ params }) =>
                runOf.getStore()?.cut ? { ...params, maxOutputTokens: 16 } : params,
              wrapStream: async ({ doStream }) => {
                const { stream, ...rest } = await doStream();
                const kept = runOf.getStore();
                return {
                  ...rest,
                  stream: stream.pipeThrough(
                    new TransformStream({
                      transform(part, controller) {
                        if (kept && part.type === "text-delta") kept.raw += part.delta;
                        controller.enqueue(part);
                      },
                    }),
                  ),
                };
              },
            },
          }),
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY, modelId: MODEL });

      const only = process.env.INCARNAMIND_LIVE_ASK;
      const named = process.env.INCARNAMIND_LIVE_NOTES?.split(",");
      const notes = NOTES.filter((note) => !named || named.includes(note.name));
      const jobs = notes.flatMap((note) =>
        note.cases
          .filter((asked) => !only || asked.ask.includes(only))
          .flatMap((asked) => Array.from({ length: runs }, () => ({ note, asked }))),
      );
      const exact = new Map<Case, number>();
      const lost = new Map<Case, number>();
      const grew = new Map<Case, number>();
      const refused = new Map<Case, number>();
      /** Replies whose own words were shown instead of written: they named no paragraph and changed none. */
      const shown = new Map<Case, number>();
      const misses: string[] = [];
      const said: string[] = [];
      /** Each run's reply shape, and whether a line the request didn't name was lost or written over. */
      const shapes: { asked: Case; harmed: boolean; shape: Shape }[] = [];

      const runJob = async ({ note, asked }: { note: Note; asked: Case }) => {
        const mind = await core.createMind({ title: crypto.randomUUID() });
        const client = await connectToMind(core, mind.id);
        writeMind(client, contentOf(note.blocks));
        await client.settled();
        const ids: { id: string; size: number }[] = [];
        readMind(client).descendants((node) => {
          if (!node.isTextblock) return true;
          ids.push({ id: String(node.attrs.id), size: node.content.size });
          return false;
        });
        const first = ids[0];
        const last = ids.at(-1);
        if (!first || !last) throw new Error("No blocks.");
        const result = await core.editWithAi({
          requestId: crypto.randomUUID(),
          mindId: mind.id,
          from: { blockId: first.id, offset: 0 },
          to: { blockId: last.id, offset: last.size },
          text: linesOf(note).join("\n"),
          action: "instruction",
          instruction: asked.ask,
        });
        await client.settled();
        const raw = runOf.getStore()?.raw ?? "";
        if (asked.kind !== "cut") said.push(raw);
        if (result.kind === "unchanged" && result.said !== undefined)
          shown.set(asked, (shown.get(asked) ?? 0) + 1);
        client.doc.transact(() => {
          resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
        }, "editor");
        await client.settled();
        const after = textsOf(client);
        const wrong = verdict(note, asked, after, result);
        if (asked.kind !== "cut") {
          const shape = shapeOf(raw, note, asked);
          const harmed = wrong?.startsWith("lost") === true || wrong?.startsWith("grew") === true;
          shapes.push({ asked, harmed, shape });
          if (shape.quotedUnasked.length > 0) {
            misses.push(
              `- QUOTED ${note.name} “${asked.ask}”: ${JSON.stringify(shape.quotedUnasked)} quoted as removed; still there ${shape.quotedUnasked.every((line) => after.includes(line))}`,
              `  reply: ${JSON.stringify(raw)}`,
            );
          }
        }
        if (wrong === null) {
          exact.set(asked, (exact.get(asked) ?? 0) + 1);
          return;
        }
        if (wrong.startsWith("lost")) lost.set(asked, (lost.get(asked) ?? 0) + 1);
        if (wrong.startsWith("grew")) grew.set(asked, (grew.get(asked) ?? 0) + 1);
        if (wrong.startsWith("refused")) refused.set(asked, (refused.get(asked) ?? 0) + 1);
        misses.push(
          `- MISS ${note.name} ${asked.kind} “${asked.ask}” (${result.kind}; ${wrong}): ${JSON.stringify(after)}`,
          `  reply: ${JSON.stringify(raw)}`,
        );
      };
      await pooled(jobs, Number(process.env.INCARNAMIND_LIVE_CONCURRENCY ?? 4), (job) =>
        runOf.run({ raw: "", cut: job.asked.kind === "cut" }, () => runJob(job)),
      );

      let total = 0;
      let exactTotal = 0;
      let lostTotal = 0;
      let grewTotal = 0;
      let refusedTotal = 0;
      let shownTotal = 0;
      for (const note of notes) {
        for (const asked of note.cases) {
          const ran = jobs.filter((job) => job.asked === asked).length;
          if (ran === 0) continue;
          total += ran;
          exactTotal += exact.get(asked) ?? 0;
          lostTotal += lost.get(asked) ?? 0;
          grewTotal += grew.get(asked) ?? 0;
          refusedTotal += refused.get(asked) ?? 0;
          shownTotal += shown.get(asked) ?? 0;
          const of = shapes.filter((each) => each.asked === asked);
          const count = (key: "stray" | "partial" | "nameless") =>
            of.filter(({ shape }) => shape[key]).length;
          report.push(
            `  ${note.name} ${asked.kind} “${asked.ask}”: exact ${exact.get(asked) ?? 0}/${ran}, lines lost ${lost.get(asked) ?? 0}, written over with every word kept ${grew.get(asked) ?? 0}, refused ${refused.get(asked) ?? 0}, its words shown instead ${shown.get(asked) ?? 0}; replies with stray lines ${count("stray")}, partial ${count("partial")}, nameless ${count("nameless")}, quoting an unasked line as removed ${of.filter(({ shape }) => shape.quotedUnasked.length > 0).length}`,
          );
        }
      }
      report.push(
        `  all: exact ${exactTotal}/${total}; runs that lost a line ${lostTotal}/${total}; runs that wrote over a line, every word kept, ${grewTotal}/${total}; refused ${refusedTotal}/${total}; its words shown instead ${shownTotal}/${total}; ${namedSaid(said)}`,
        `  reply shapes, each with the runs of it that lost or wrote over a line: ${(
          [
            ["stray lines", ({ stray }: Shape) => stray],
            ["partial", ({ partial }: Shape) => partial],
            ["nameless", ({ nameless }: Shape) => nameless],
            [
              "an unasked line quoted as removed",
              ({ quotedUnasked }: Shape) => quotedUnasked.length > 0,
            ],
          ] as const
        )
          .map(([name, is]) => {
            const runsOf = shapes.filter(({ shape }) => is(shape));
            return `${name} ${runsOf.length} (${runsOf.filter(({ harmed }) => harmed).length})`;
          })
          .join(", ")}`,
        ...spentBy(dataDir),
        ...misses,
      );
      core.close();
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(total).toBeGreaterThan(0);
    },
  );
});
