/**
 * Beside the net for claimed changes (./claimedChanges): a reply that says a
 * figure was calculated or checked, or that a search ran, when none of its
 * Tool calls did (#1796). Only a sentence that gives the act to a Tool, to
 * IncarnaMind or to the assistant itself counts ("The calculation tool
 * confirms…", "I recalculated…", "我用计算工具核对了…"); one that reports what
 * a Document says ("the auditor confirmed", "报告中计算得出") never does, nor
 * the assistant's word on an earlier Answer ("the 3.37x I calculated
 * earlier"), which that Answer's own record holds. It reads the reply
 * alone, in English and Chinese, and misses a vague sentence rather than flag
 * an honest one.
 */
import type { AnswerToolCall, ClaimedTool } from "../api";
import { DOCUMENT_TOOLS, SOURCE_TOOLS, WEB_TOOLS } from "../tools";
import { sentencesOf, thisAnswersRecord, UNSEEN_REPLY } from "./claimedChanges";
import type { ChangeStates, MindNames } from "./toolRecord";

const CALCULATION_TOOL =
  /\b(?:calculat(?:ion|e|ing|or)|comput(?:ation|e|ing)|math|maths|arithmetic)\s+(?:tool|function)s?\b|\b(?:the|a|my|IncarnaMind['’]s)\s+calculator\b|\bIncarnaMind['’]s\s+calculations?\b/gi;
// "Northbank's covenant calculator", "the vendor calculation tool": someone else's.
const NAMED_OWNER =
  /\b(?!(?:IncarnaMind|That|It|What|There|Here|Who|He|She|Let)['’]s)[A-Z][\w&.-]*['’]s\s+(?:[\w-]+\s+){0,3}$/;
const OWNER =
  /\b(?:their|its|his|her|the\s+(?:lenders?|banks?|borrowers?|vendors?|company|auditors?|agent|client|report|spreadsheet|model|workbook|agreement|document|firm|team)(?:['’]s)?)\s+(?:[\w-]+\s+){0,3}$/i;
const NOT_BEFORE =
  /(?:\b(?:not|no|never|without|nor|cannot|unable|instead of|rather than)\b|n['’]t\b)[^.;:,]{0,30}$/i;
const NOT_AFTER =
  /^\s*(?:(?:is|was|are|were|has|had|does|did|do|can|could)\s+(?:not|never)\b|(?:isn|wasn|aren|weren|doesn|didn|can|couldn|hasn)['’]t\b|cannot\b|(?:is|was|are|were)\s+(?:unavailable|not available)\b)/i;
const UNREAL_BEFORE =
  /(?:\b(?:can|could|would|should|will|shall|might|may|must|if|whether|unless|please)\b|['’](?:ll|d)\b|\bto\s+(?:use|run|call|try)\b|\byou\s+(?:asked|wanted|requested|mentioned)\b)[^.;:]{0,40}$/i;
const REPORTS_A_DOCUMENT =
  /\baccording to (?:the|its|their|this|that) (?:report|agreement|document|certificate|letter|memo|spreadsheet|workbook|draft|file|amendment|minutes)\b|\b(?:the|this|that|its|their) (?:report|agreement|document|certificate|letter|memo|spreadsheet|workbook|draft|file|amendment|minutes|auditors?|lenders?|agent|borrower)\s+(?:says|said|states|stated|shows|showed|notes|noted|describes|described|calculates|calculated|confirms|confirmed|reports|reported|records|recorded|sets out)\b|\b(?:described|set out|as stated) in\b/i;
const EARLIER =
  /\b(?:earlier|previously|previous|last time|first answer)\b|之前|此前|先前|上次|上一条|前面/i;

const CALCULATED = "calculated|computed|recalculated|recomputed|re-calculated|re-computed";
const CHECKED =
  "checked|verified|confirmed|double-checked|re-checked|rechecked|cross-checked|validated";
// "I", opening a clause: "the ratio I calculated was wrong" is about the ratio.
const FIRST_PERSON = new RegExp(
  `(?:^(?:[-*•]\\s+)?|[,;:—–(]\\s*|\\b(?:and|then|so|now|ok|okay|sure|done|yes|here)\\b[,:!]?\\s+)I(?:['’]ve|\\s+have|['’]d|\\s+had)?(?:\\s+(?:just|also|now|then|already|carefully|again|quickly|first|independently))*\\s+(${CALCULATED}|${CHECKED}|ran|re-ran|reran|searched|looked\\s+up)\\b`,
  "gi",
);
const INCARNAMIND_DID = new RegExp(
  `\\bIncarnaMind(?:\\s+(?:has|have|just|also))*\\s+(${CALCULATED}|${CHECKED}|worked out)\\b|\\b(${CALCULATED}|${CHECKED}|worked out)\\s+by\\s+IncarnaMind\\b`,
  "gi",
);
const FIGURES =
  /^\s+[\d£$€¥(]|^\s+(?:(?:the|these|this|those|that|your|my|both|each|all|its|their)\s+)?(?:[\w-]+\s+){0,3}?(?:figures?|numbers?|calculations?|arithmetic|maths?|ratios?|headroom|results?|sums?|totals?|amounts?|values?|computations?|leverage|percentages?|differences?)\b/i;
const RAN_CALCULATION =
  /^\s+(?:(?:the|these|a|my)\s+)?(?:numbers|calculations?|figures|maths?|math|arithmetic|calculate)\b/i;
const RAN_SEARCH = /^\s+(?:(?:a|the|another|my)\s+)?(?:\w+\s+)?search(?:es)?\b/i;
const SEARCH_DID =
  /\b(?:(?:the|my|a|IncarnaMind['’]s)\s+(?:document\s+|documents\s+|web\s+)?search(?:es)?|search results?)\s+(?:also\s+|only\s+)?(?:found|returned|turned up|showed|shows|show|gave|confirms?|confirmed|came back|surfaced|brought up)\b/i;

const ZH_TOOL = /计算工具|计算器|计算功能/g;
const ZH_NOT_BEFORE =
  /(?:没有|没|未|无法|不能|不可|并未|尚未|不是|不用|不使用|未使用|无|不)[^，。！？；：]{0,16}$/;
const ZH_NOT_AFTER = /^(?:不可用|暂不可用|无法|不能|未|没有|并未|尚未|不可)/;
const ZH_UNREAL_BEFORE =
  /(?:可以|可|能|将|会|如果|若|需要|建议|请|是否|要不要|你(?:要求|希望|让|请))[^，。！？；：]{0,8}$/;
const ZH_OWNER = /([^\s，。！？；：、]{1,12})\s*的[^，。！？；：]{0,6}$/;
const ZH_OURS = /^(?:IncarnaMind|我|我们)$/;
const ZH_REPORTS =
  /(?:报告|协议|文件|文档|表格|模型|证书|草稿|修订函|审计师|贷款方|代理行|借款人)(?:中|里|上)?(?:显示|称|写明|写道|指出|记载|确认|计算|核实|载明)/;
const ZH_CALCULATED = "重新计算|重算|计算|算出|算了|核算";
const ZH_CHECKED = "核对|核实|验证|确认|复核|校验";
const ZH_DID = new RegExp(
  `(?:^|[，,；;：:\\s（(])(?:我|经\\s*IncarnaMind\\s*|IncarnaMind\\s*)(?:已经?|刚刚?|刚才|也|又|还|先|再|重新|再次)*(?:(?:用|使用|通过)[^，。！？；：]{0,12}?)?(${ZH_CALCULATED}|${ZH_CHECKED}|搜索|检索|查找)`,
  "g",
);
const ZH_FIGURES =
  /^[^，。！？；]{0,15}?(?:数字|数据|计算|结果|比率|杠杆率|余量|空间|金额|算术|数值|倍数)/;
const ZH_SEARCH_DID = /(?:搜索|检索)结果(?:显示|表明|确认|中)|经过?(?:搜索|检索)/;

function mentionsOurTool(
  sentence: string,
  pattern: RegExp,
  isOurs: (before: string, after: string) => boolean,
): boolean {
  for (const match of sentence.matchAll(pattern)) {
    const before = sentence.slice(0, match.index);
    const after = sentence.slice(match.index + match[0].length);
    if (isOurs(before, after)) return true;
  }
  return false;
}

const oursInEnglish = (before: string, after: string) =>
  !NAMED_OWNER.test(before) &&
  !OWNER.test(before) &&
  !NOT_BEFORE.test(before) &&
  !NOT_AFTER.test(after) &&
  !UNREAL_BEFORE.test(before);

const oursInChinese = (before: string, after: string) => {
  const owner = ZH_OWNER.exec(before)?.[1];
  return (
    (owner === undefined || ZH_OURS.test(owner)) &&
    !ZH_NOT_BEFORE.test(before) &&
    !ZH_NOT_AFTER.test(after) &&
    !ZH_UNREAL_BEFORE.test(before)
  );
};

function sentenceClaims(sentence: string): ClaimedTool[] {
  if (/[?？]\s*$/.test(sentence)) return [];
  // Quoted words are someone else's: the User's request, a Document's heading.
  const own = sentence.replace(/“[^”]*”|"[^"]*"|「[^」]*」/g, "“”").replace(/`/g, "");
  const tools = new Set<ClaimedTool>();
  if (!REPORTS_A_DOCUMENT.test(own) && mentionsOurTool(own, CALCULATION_TOOL, oursInEnglish)) {
    tools.add("calculate");
  }
  if (!ZH_REPORTS.test(own) && mentionsOurTool(own, ZH_TOOL, oursInChinese)) tools.add("calculate");
  // "I calculated 3.37x earlier": the earlier Answer's own record holds it.
  const now = !EARLIER.test(own);
  for (const pattern of now ? [FIRST_PERSON, INCARNAMIND_DID] : []) {
    for (const match of own.matchAll(pattern)) {
      const verb = (match[1] ?? match[2] ?? "").toLocaleLowerCase();
      const after = own.slice(match.index + match[0].length);
      if (/^(?:searched|looked\s+up)$/.test(verb)) tools.add("search");
      else if (/^(?:ran|re-ran|reran)$/.test(verb)) {
        if (RAN_CALCULATION.test(after)) tools.add("calculate");
        else if (RAN_SEARCH.test(after)) tools.add("search");
      } else if (new RegExp(`^(?:${CALCULATED}|worked out)$`).test(verb) || FIGURES.test(after)) {
        tools.add("calculate");
      }
    }
  }
  if (now && !ZH_REPORTS.test(own)) {
    for (const match of own.matchAll(ZH_DID)) {
      const verb = match[1] ?? "";
      const after = own.slice(match.index + match[0].length);
      if (/^(?:搜索|检索|查找)$/.test(verb)) tools.add("search");
      else if (new RegExp(`^(?:${ZH_CALCULATED})$`).test(verb) || ZH_FIGURES.test(after)) {
        tools.add("calculate");
      }
    }
  }
  if (SEARCH_DID.test(own) || ZH_SEARCH_DID.test(own)) tools.add("search");
  return [...tools];
}

/** The Tools a reply says ran, by what it says: a calculation or check of figures, or a search. Each once. */
export function toolClaimsIn(reply: string): ClaimedTool[] {
  return [...new Set(sentencesOf(reply).flatMap(sentenceClaims))];
}

const RAN: Record<ClaimedTool, (call: AnswerToolCall) => boolean> = {
  calculate: (call) =>
    call.source === "documents" &&
    call.tool === DOCUMENT_TOOLS.calculate &&
    (call.resultCount ?? 0) > 0,
  search: (call) =>
    call.status === "done" &&
    ((call.source === "documents" && call.tool === DOCUMENT_TOOLS.search) ||
      (call.source === "web" && call.tool === WEB_TOOLS.search) ||
      (call.source === "sources" && call.tool === SOURCE_TOOLS.find)),
};

/** The Tools a reply says ran that none of `calls` ran: a figure is calculated only by `calculate`. */
export function unrunToolClaims(reply: string, calls: readonly AnswerToolCall[]): ClaimedTool[] {
  return toolClaimsIn(reply).filter((tool) => !calls.some(RAN[tool]));
}

const CLAIMED_WORDS: Record<ClaimedTool, string> = {
  calculate: "that a Tool, IncarnaMind or you calculated, checked or confirmed a figure",
  search: "that a search ran or found something",
};

/**
 * The record of what the calls did, then to write the reply again: with
 * `calculate` offered (`calculates`), using it for the figures first.
 */
export function unrunToolsNote(
  tools: readonly ClaimedTool[],
  calls: readonly AnswerToolCall[],
  names: MindNames,
  calculates: boolean,
  states?: ChangeStates,
): string {
  const said = tools.map((tool) => CLAIMED_WORDS[tool]).join(", and ");
  return [
    thisAnswersRecord(calls, names, states),
    `Your reply says ${said}, but no call in the record did.`,
    ...(tools.includes("calculate")
      ? [
          calculates
            ? "Call calculate now for each number you work out from numbers in the Passages, and write its marker where the number goes. Then write your reply again from its start, saying a figure was calculated only where calculate gave it."
            : "IncarnaMind has no calculation Tool for this model. Write your reply again from its start without saying that a Tool, IncarnaMind or you calculated, checked or confirmed a figure; give a number you work out as your own working. If the User asked for a calculation by a Tool, say in one sentence that this model can't use IncarnaMind's calculation Tool.",
        ]
      : []),
    ...(tools.includes("search")
      ? [
          "If the User's Documents may answer the Question and you can search them, search them now. Then write your reply again from its start, saying a search ran only where one did.",
        ]
      : []),
    UNSEEN_REPLY,
  ].join("\n");
}
