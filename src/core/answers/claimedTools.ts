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
import { FIGURE_MARKER } from "../../shared/figureMarkers";
import type { AnswerToolCall, ClaimedTool } from "../api";
import { DOCUMENT_TOOLS, SOURCE_TOOLS, WEB_TOOLS, WORKBOOK_TOOLS } from "../tools";
import { thisAnswersRecord, UNSEEN_REPLY } from "./claimedChanges";
import { sentencesOf } from "./claimStream";
import type { ChangeStates, MindNames } from "./toolRecord";

// What a Tool, IncarnaMind or the assistant is said to have done with the figures.
const ACT_WORD =
  "(?:confirm(?:s|ed)?|show(?:s|ed)?|give(?:s|n)?|gave|got|return(?:s|ed)?|produce[sd]?|yield(?:s|ed)?|calculate[sd]|compute[sd]|verif(?:y|ies|ied)|check(?:s|ed)|found|output(?:s|ted)?|results?|says|reports?|reported|agrees?|match(?:es|ed)?)";
const ACT = new RegExp(`\\b${ACT_WORD}\\b|=`, "i");
const CALCULATION_TOOL = new RegExp(
  [
    "\\b(?:calculat(?:ion|e|ing|or)|comput(?:ation|e|ing)|math|maths|arithmetic)\\s+(?:tool|function)s?\\b",
    "\\b(?:the|a|my|IncarnaMind['’]s)\\s+calculator\\b",
    "\\bIncarnaMind['’]s\\s+calculations?\\b(?!\\s+(?:tool|function)s?\\b)",
    // The Tool's own name, only as what a calculation used it for or as the subject of an act.
    "(?<=\\b(?:by|using|used|with|via|through|from|ran|run|running|called|according to|based on|per|into)\\s+(?:the\\s+|my\\s+|a\\s+)?(?:IncarnaMind['’]s\\s+)?)calculate\\b",
    `\\bcalculate\\b(?=\\s+${ACT_WORD}\\b)`,
  ].join("|"),
  "gi",
);
const USED_FOR =
  /(?:\b(?:using|used|with|via|through|by|from|ran|run|running|called|according to|based on|per|into)\s+(?:the\s+|my\s+|a\s+)?(?:IncarnaMind['’]s\s+)?|\(\s*)$/i;
// "Northbank's covenant calculator", "the vendor calculation tool": someone else's.
const NAMED_OWNER =
  /\b(?!(?:IncarnaMind|That|It|What|There|Here|Who|He|She|Let)['’]s)[A-Z][\w&.-]*['’]s\s+(?:[\w-]+\s+){0,3}$/;
const OWNER =
  /\b(?:their|its|his|her|the\s+(?:lenders?|banks?|borrowers?|vendors?|company|auditors?|agent|client|report|spreadsheet|model|workbook|agreement|document|firm|team)(?:['’]s)?)\s+(?:[\w-]+\s+){0,3}$/i;
const NEGATION =
  /\b(?:not|no|never|without|nor|cannot|unable|unavailable|instead of|rather than)\b|n['’]t\b/i;
// The Tool's own clause: a negation or an unavailability in another clause is no denial of it
// ("I didn't search the web, but the calculation tool confirms 3.26x").
const CLAUSE_BOUNDARY = /(?<!\d)[.;:,]|\b(?:but|though)\b/i;
const namingClause = (text: string): string => text.split(CLAUSE_BOUNDARY).at(-1) ?? text;
const TOOL_UNAVAILABLE =
  /\b(?:is|was|isn't|wasn't|not|never)\s+(?:available|supported|usable|accessible|installed)\b|\bunavailable\b|\bcan(?:not|['’]t)\s+(?:be\s+)?(?:used|called|run|invoked)\b|\bcould(?: not|n['’]t)\s+(?:be\s+)?(?:used|called|run)\b/i;
const UNREAL_BEFORE =
  /(?:\b(?:can|could|would|should|will|shall|might|may|must|if|whether|unless|please)\b|['’](?:ll|d)\b|\bto\s+(?:use|run|call|try)\b|\b(?:you|(?:the\s+)?[Uu]ser)\s+(?:asked|wanted|requested|mentioned)\b)[^.;:]{0,40}$/i;
const UNREAL_AFTER =
  /^(?:\W*(?:would|could|might|can|should|will|may|must)\b|\W*had\s+(?:it|they|this|that)\s+been\b)/i;
// "Earlier I said the calculation tool confirmed…", "my earlier claim that…": a correction.
const REPORTED_BEFORE =
  /\b(?:I|we)\s+(?:had\s+|have\s+)?(?:said|wrote|claimed|stated|told you|mentioned)\b|\b(?:my|the|an)\s+(?:earlier|previous|first|last)\s+(?:claim|answer|reply|statement|response)\b|\b(?:earlier|previously)\b/i;
const REPORTS_A_DOCUMENT =
  /\baccording to (?:the|its|their|this|that) (?:report|agreement|document|certificate|letter|memo|note|spreadsheet|workbook|draft|file|amendment|minutes)\b|\b(?:the|this|that|its|their) (?:report|agreement|document|certificate|letter|memo|note|spreadsheet|workbook|draft|file|amendment|minutes|auditors?|lenders?|agent|borrower|vendor)\s+(?:says|said|states|stated|shows|showed|notes|noted|describes|described|calculates|calculated|confirms|confirmed|reports|reported|records|recorded|sets out)\b|\b(?:described|set out|as stated|mentioned) in\b|\bper the (?:[\w-]+\s+){0,2}(?:report|agreement|document|certificate|letter|memo|note|spreadsheet|workbook|draft|file|amendment|minutes|schedule)\b|\bdescribes?\b|\brefers? to\b/i;
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
// "Let me re-calculate carefully:", "让我重新计算": the assistant says it works the figures out.
const LET_ME_CALCULATE =
  /\blet(?:\s+me|['’]s|\s+us)\s+(?:re-?)?(?:calculate|compute|recalculate|recompute)\b|(?:让我|我来|下面我)(?:重新)?(?:计算|算一下|核算)/i;
// Working said to be the assistant's own is what its instructions ask for, not a claim of a check.
const OWN_WORKING =
  /\b(?:my own (?:working|arithmetic|calculations?|maths?)|myself|mental(?:ly)?(?: arithmetic)?|in my head|by hand)\b|我自己|自己算|心算|手算|人工计算/i;
const INCARNAMIND_DID = new RegExp(
  `\\bIncarnaMind(?:\\s+(?:has|have|just|also))*\\s+(${CALCULATED}|${CHECKED}|worked out)\\b|\\b(${CALCULATED}|${CHECKED}|worked out)\\s+by\\s+IncarnaMind\\b`,
  "gi",
);
// Checking figures against their source is reading, which search and the Citation check back:
// only a check of arithmetic says a calculation ran.
const CHECKED_ARITHMETIC =
  /^\s+[\d(][^.;!?]*=|^\s+(?:(?:the|these|this|those|that|my|your|both|each|all|its|their)\s+)?(?:[\w-]+\s+){0,2}?(?:calculations?|arithmetic|maths?|computations?|ratios?|results?|headroom|leverage|totals?|sums?|differences?|percentages?)\b/i;
const AGAINST_A_SOURCE = /\b(?:against|from|match(?:es)?|come from|in the|in its)\b/i;
const RAN_CALCULATION =
  /^\s+(?:(?:the|these|a|my)\s+)?(?:numbers|calculations?|figures|maths?|math|arithmetic|calculate)\b/i;
const RAN_SEARCH = /^\s+(?:(?:a|the|another|my)\s+)?(?:\w+\s+)?search(?:es)?\b/i;
const SEARCH_DID =
  /\b(?:(?:the|my|a|IncarnaMind['’]s)\s+(?:document\s+|documents\s+|web\s+)?search(?:es)?|search results?)\s+(?:also\s+|only\s+)?(?:found|returned|turned up|showed|shows|show|gave|confirms?|confirmed|came back|surfaced|brought up)\b/i;

const ZH_TOOL = /计算工具|计算器|计算功能/g;
const ZH_ACT = /运行|确认|显示|得出|算出|计算|核实|核对|复核|核算|验证|给出|结果|表明|证实|=/;
const ZH_USED_FOR =
  /(?:经过?|使用|用|通过|借助|调用了?|利用|根据|按照|依据|[（(])\s*(?:IncarnaMind\s*的\s*)?$/;
const ZH_NEGATION = /不可用|用不了|无法|不能|没有|没|未|并未|尚未|不可|不支持|不是|并非/;
const ZH_NOT_BEFORE =
  /(?:没有|没|未|无法|不能|不可|并未|尚未|不是|并非|不用|不使用|未使用|无|不)[^，。！？；：]{0,16}$/;
const ZH_UNREAL_BEFORE =
  /(?:可以|可|能|将|会|如果|若|假如|需要|建议|请|是否|要不要|(?:您|你|用户)(?:要求|希望|让|请))[^，。！？；：]{0,8}$/;
const ZH_UNREAL_AFTER = /^[^，。！？；]{0,4}(?:可以|可|能|会|将|需要|应)/;
const ZH_REPORTED_BEFORE =
  /(?:说|称|写|表示|提到)(?:过|了)?[^，。！？；]{0,12}$|之前|此前|先前|上一条|上次/;
// "贷款方的计算工具": the 的 is the Tool's, not a figure's ("文中的数字已用计算工具…").
const ZH_OWNER = /([^\s，。！？；：、]{1,12})\s*的[^，。！？；：]{0,2}$/;
const ZH_OURS = /^(?:IncarnaMind|我|我们)$/;
const ZH_REPORTS =
  /(?:报告|协议|文件|文档|表格|模型|证书|草稿|修订函|备忘录|说明|附表|条款|供应商|审计师|贷款方|代理行|借款人)(?:中|里|上)?(?:显示|称|写明|写道|提到|指出|记载|确认|计算|核实|载明)/;
const ZH_CALCULATED = "重新计算|重算|计算|算出|算了|核算";
const ZH_CHECKED = "核对|核实|验证|确认|复核|校验";
const ZH_DID = new RegExp(
  `(?:^|[，,；;：:\\s（(])(?:我|经\\s*IncarnaMind\\s*|IncarnaMind\\s*)(?:已经?|刚刚?|刚才|也|又|还|先|再|重新|再次)*(?:(?:用|使用|通过)[^，。！？；：]{0,12}?)?(${ZH_CALCULATED}|${ZH_CHECKED}|搜索|检索|查找)`,
  "g",
);
const ZH_CHECKED_ARITHMETIC =
  /^[^，。！？；]{0,15}?(?:计算|结果|比率|杠杆率|余量|空间|算术|倍数|合计|总额|差额|百分比)/;
const ZH_AGAINST_A_SOURCE =
  /(?:报告|文档|协议|数据|表格|证书|原文|终版|草稿)(?:中|里|上)?|来自|一致|相符/;
const ZH_SEARCH_DID = /(?:搜索|检索)结果(?:显示|表明|确认|中)|经过?(?:搜索|检索)/;

const clauseAfter = (text: string, split: RegExp) => text.split(split)[0] ?? "";

// A negation before the act a Tool is said to have done ("isn't available", "不可用") is a
// denial, which is what the instructions ask a model without the Tool to write.
function claimsTheTool(
  before: string,
  after: string,
  { act, usedFor, negation }: { act: RegExp; usedFor: RegExp; negation: RegExp },
): boolean {
  const acted = act.exec(after);
  const upTo = acted ? after.slice(0, acted.index) : (after.split(/\d/)[0] ?? "");
  return (acted !== null || usedFor.test(before)) && !negation.test(upTo);
}

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

const oursInEnglish = (before: string, after: string) => {
  const clause = clauseAfter(after, /[.;!?\n]|,?\s+(?:but|so|though)\s+/i);
  const named = `${namingClause(before)}${clause}`;
  return (
    !NAMED_OWNER.test(before) &&
    !OWNER.test(before) &&
    !NEGATION.test(namingClause(before)) &&
    !TOOL_UNAVAILABLE.test(named) &&
    !UNREAL_BEFORE.test(before) &&
    !REPORTED_BEFORE.test(before) &&
    !UNREAL_AFTER.test(clause) &&
    claimsTheTool(before, clause, { act: ACT, usedFor: USED_FOR, negation: NEGATION })
  );
};

const oursInChinese = (before: string, after: string) => {
  const owner = ZH_OWNER.exec(before)?.[1];
  const clause = clauseAfter(after, /[。！？；\n]/);
  return (
    (owner === undefined || ZH_OURS.test(owner)) &&
    !/其\s*$/.test(before) &&
    !ZH_NOT_BEFORE.test(before) &&
    !ZH_UNREAL_BEFORE.test(before) &&
    !ZH_REPORTED_BEFORE.test(before) &&
    !ZH_UNREAL_AFTER.test(clause) &&
    claimsTheTool(before, clause, { act: ZH_ACT, usedFor: ZH_USED_FOR, negation: ZH_NEGATION })
  );
};

// Quoted words are someone else's: the User's request, a Document's heading or memo.
const QUOTED = /“[^”]*”|"[^"]*"|「[^」]*」|『[^』]*』|‘[^’]*’|«[^»]*»|(?<=^|[\s:：])'[^']*'/g;

function sentenceClaims(sentence: string): ClaimedTool[] {
  if (/[?？]\s*$/.test(sentence) || /^>/.test(sentence)) return [];
  const own = sentence.replace(QUOTED, "“”").replace(/`/g, "");
  const tools = new Set<ClaimedTool>();
  if (!REPORTS_A_DOCUMENT.test(own) && mentionsOurTool(own, CALCULATION_TOOL, oursInEnglish)) {
    tools.add("calculate");
  }
  if (!ZH_REPORTS.test(own) && mentionsOurTool(own, ZH_TOOL, oursInChinese)) tools.add("calculate");
  // "I calculated 3.37x earlier": the earlier Answer's own record holds it.
  const now = !EARLIER.test(own) && !OWN_WORKING.test(own);
  for (const pattern of now ? [FIRST_PERSON, INCARNAMIND_DID] : []) {
    for (const match of own.matchAll(pattern)) {
      const verb = (match[1] ?? match[2] ?? "").toLocaleLowerCase();
      const after = clauseAfter(own.slice(match.index + match[0].length), /[.;!?]/);
      if (/^(?:searched|looked\s+up)$/.test(verb)) tools.add("search");
      else if (/^(?:ran|re-ran|reran)$/.test(verb)) {
        if (RAN_CALCULATION.test(after)) tools.add("calculate");
        else if (RAN_SEARCH.test(after)) tools.add("search");
      } else if (new RegExp(`^(?:${CALCULATED}|worked out)$`).test(verb)) tools.add("calculate");
      else if (CHECKED_ARITHMETIC.test(after) && !AGAINST_A_SOURCE.test(after)) {
        tools.add("calculate");
      }
    }
  }
  if (now && !ZH_REPORTS.test(own)) {
    for (const match of own.matchAll(ZH_DID)) {
      const verb = match[1] ?? "";
      const after = clauseAfter(own.slice(match.index + match[0].length), /[。！？；]/);
      if (/^(?:搜索|检索|查找)$/.test(verb)) tools.add("search");
      else if (new RegExp(`^(?:${ZH_CALCULATED})$`).test(verb)) tools.add("calculate");
      else if (ZH_CHECKED_ARITHMETIC.test(after) && !ZH_AGAINST_A_SOURCE.test(after)) {
        tools.add("calculate");
      }
    }
  }
  if (now && LET_ME_CALCULATE.test(own)) tools.add("calculate");
  if (now && (SEARCH_DID.test(own) || ZH_SEARCH_DID.test(own))) tools.add("search");
  return [...tools];
}

/** The Tools a reply says ran, by what it says: a calculation or check of figures, or a search. Each once. */
export function toolClaimsIn(reply: string): ClaimedTool[] {
  return [...new Set(sentencesOf(reply).flatMap(sentenceClaims))];
}

const RAN: Record<ClaimedTool, (call: AnswerToolCall) => boolean> = {
  calculate: (call) =>
    call.source === "documents" &&
    (call.tool === DOCUMENT_TOOLS.calculate ||
      call.tool === WORKBOOK_TOOLS.trace ||
      call.tool === WORKBOOK_TOOLS.whatIf) &&
    (call.resultCount ?? 0) > 0,
  search: (call) =>
    call.status === "done" &&
    ((call.source === "documents" && call.tool === DOCUMENT_TOOLS.search) ||
      (call.source === "web" && call.tool === WEB_TOOLS.search) ||
      (call.source === "sources" && call.tool === SOURCE_TOOLS.find)),
};

/**
 * The Tools a reply says ran that none of `calls` backed: a figure is calculated only by
 * `calculate`, in a reply that shows the figure where the number goes, and a search by a
 * search of `earlier`, the Conversation's own, which a follow-up may be answered from.
 */
export function unrunToolClaims(
  reply: string,
  calls: readonly AnswerToolCall[],
  earlier: readonly AnswerToolCall[] = [],
): ClaimedTool[] {
  // A calculate call whose figure the reply doesn't show is dropped from the Answer's record
  // before the User reads it, so the figure is unchecked in what they see.
  const showsFigure = (reply.match(FIGURE_MARKER) ?? []).length > 0;
  const ran = (tool: ClaimedTool) =>
    calls.some(RAN[tool]) || (tool === "search" && earlier.some(RAN.search));
  return toolClaimsIn(reply).filter((tool) => {
    if (!ran(tool)) return true;
    return tool === "calculate" && !showsFigure;
  });
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
