/**
 * Text that goes into a page stands on its own (#1172). Once it is whole, a
 * paragraph that is one sentence pointing to an earlier Answer and nothing
 * else goes, from a closed list of shapes. Everything else stays exactly as
 * written, and what points back is counted: losing what a page says is worse
 * than leaving a pointer in.
 */

const MY_EARLIER = `my (?:earlier|previous|prior|last|first|original) (?:answer|reply|response)s?`;
const EARLIER = `(?:${MY_EARLIER}|(?:the|that) (?:earlier|previous|prior|last|preceding) (?:answer|reply|response))`;
const CONVERSATION = `(?:earlier|above) in (?:this|our|the) (?:conversation|chat)`;
const THERE = `(?:in ${EARLIER}|above|${CONVERSATION})`;
const SET_OUT =
  "(?:covered|set out|described|explained|discussed|listed|given|summari[sz]ed|detailed|addressed|answered|outlined|shown|noted|mentioned|included|dealt with|stated)";
const SAID =
  "(?:said|mentioned|noted|explained|described|covered|set out|discussed|showed|shown|stated|outlined|listed)";
const I_SET_OUT =
  "I (?:have |['’]ve )?(?:already )?(?:covered|set out|described|explained|discussed|listed|gave|summari[sz]ed|detailed|addressed|answered|outlined|showed|noted|mentioned|went (?:over|through))";
// What a pointer may name without saying anything of it: "notice, holiday and home working".
const ITEM = String.raw`(?:(?:the|these|those|this|that|its|their|other|all|more|further|full) ){0,2}[\p{L}'’-]+(?: [\p{L}'’-]+)?`;
const TOPIC = `(?<topic>${ITEM}(?:(?:,| and| or|, and|, or) ${ITEM}){0,4})`;
const LEAD = String.raw`(?:(?:for (?:more|further|the full|the) (?:detail|details|information|list|breakdown|figures|rest)|for details|for more|as (?:discussed|mentioned|noted|explained)),\s*)?`;

const ANSWER_ZH =
  "(?:我的)?(?:(?:上一条|上条|前一条|上一个|上一次|之前|先前|前面|刚才|上面)的?回答|(?:上一条|上条|前一条|刚才)的?(?:回复|答复))";
const EARLIER_ZH = `(?:${ANSWER_ZH}|上文|前文)`;
const SET_OUT_ZH =
  "(?:说明|介绍|列出|提到|讲过|说过|讲|说|解释|列明|写明|给出|总结|回答|讨论|涵盖|概括|列举)";
const TOPIC_ZH = "(?<topic>[\\p{Script=Han}、]{1,16}?)";
const LEAD_ZH =
  "(?:(?:(?:更多|具体|详细|其余|其他|另外)(?:信息|详情|内容|情况|细节|条款)?|详情)[，,]?)?";
const SEE_ZH = `(?:可|请)?(?:见|参见|详见|请见|参阅|参考|查看)(?:我)?(?:在)?${EARLIER_ZH}(?:中|里)?`;

const PURE = [
  `${LEAD}(?:please )?(?:see|refer to|check)(?: also)? (?:${EARLIER}|above|${CONVERSATION})(?: for ${TOPIC})?`,
  `${TOPIC} (?:is|are|was|were|has been|have been)(?: already| all| both| also)? (?:${SET_OUT} ${THERE}|in ${EARLIER}|${CONVERSATION})`,
  `(?:as|like) (?:I )?${SAID} (?:earlier|above|before|previously|in ${EARLIER}|${CONVERSATION})`,
  `(?:already )?${SET_OUT} ${THERE}`,
  `(?:same as |as )(?:above|in ${EARLIER})`,
  `${I_SET_OUT}(?: ${TOPIC})? (?:in ${EARLIER}|above|earlier|before|${CONVERSATION})`,
  `${TOPIC} (?:is|are|remains?) (?:unchanged from|the same as in) ${EARLIER}`,
  `${LEAD_ZH}${TOPIC_ZH}?${SEE_ZH}`,
  `${TOPIC_ZH}?(?:我)?(?:已经?|都)?在${EARLIER_ZH}(?:中|里)?(?:已经?|都)?${SET_OUT_ZH}(?:了|过)?`,
  `${TOPIC_ZH}?${EARLIER_ZH}(?:中|里)?(?:已经?|都)${SET_OUT_ZH}(?:了|过)?`,
  `(?:正如|如)(?:我)?(?:在)?(?:${EARLIER_ZH}|上面|前面|之前|上|前)?(?:中|里)?(?:所述|所说|所列|提到的|说的|讲的|提到过的|说过的)|如上述|同上`,
  `${TOPIC_ZH}?(?:与|和|跟|同)(?:我)?${EARLIER_ZH}(?:一致|相同)?`,
].map((shape) => new RegExp(`^[(（]?(?:${shape})[.!。！]?[)）]?[.!。！]?$`, "iu"));
// A name that says something of what it names: "Pay rises yearly and the rest", "试用期为三个月", "年假十五天".
const CLAIMS =
  /\d|\b(?:is|are|was|were|be|been|has|have|had|will|would|can|could|may|might|must|shall|should|do|does|did|not|no|never|only)\b|[是为有将会应已不没了零〇一二三四五六七八九十百千万亿两半]/iu;
const CITED = /\[[\^=]\d{1,4}\]/;

const POINTS_BACK = new RegExp(
  [
    MY_EARLIER,
    String.raw`\b(?:the|that) (?:earlier|previous) (?:answer|reply)\b`,
    CONVERSATION,
    String.raw`\b(?:see|as) above\b`,
    String.raw`\b${SAID} (?:earlier|before|previously|above)\b`,
    ANSWER_ZH,
    "(?:见|参见|详见|参考|参阅)(?:上文|前文)",
    "如(?:上|前)(?:文)?所?述",
  ].join("|"),
  "iu",
);

const ASKS_ABOUT_EARLIER = new RegExp(
  [
    String.raw`\b(?:my|your|the|that) (?:earlier|previous|prior|last|above|preceding) (?:answer|reply|response)s?\b`,
    CONVERSATION,
    String.raw`\byou (?:said|wrote|mentioned|told|listed|gave|answered)\b|\bdid you (?:say|write|mention|tell|list|give)\b`,
    EARLIER_ZH,
    "(?:你|您)(?:刚才|之前|上面|前面|上次)(?:说|写|提到|列|讲|回答)",
  ].join("|"),
  "i",
);

/** Whether a Question asks about an earlier Answer, so what is written for it may point to one. */
export const asksAboutEarlier = (question: string): boolean => ASKS_ABOUT_EARLIER.test(question);

const onlyAPointer = (paragraph: string) =>
  !CITED.test(paragraph) &&
  PURE.some((shape) => {
    const match = shape.exec(paragraph);
    return match !== null && !CLAIMS.test(match.groups?.topic ?? "");
  });

const FENCE = /^\s*(?:```|~~~)/;
const NOT_A_PARAGRAPH = /^\s*(?:#|[-*+]\s|\d{1,3}[.)]\s|\||>|```|~~~)|^ {4}/;

function blocksIn(markdown: string): string[] {
  const blocks: string[] = [];
  let block: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || line.trim() !== "") {
      block.push(line);
      continue;
    }
    if (block.length > 0) blocks.push(block.join("\n"));
    block = [];
  }
  if (block.length > 0) blocks.push(block.join("\n"));
  return blocks;
}

/**
 * Markdown, once whole, without its paragraphs that are only a pointer to an
 * earlier Answer: `removed` counts them, `left` the Blocks that point back and
 * stay as written. With nothing else in it, the Markdown is given back as it was.
 */
export function withoutPointersBack(markdown: string): {
  markdown: string;
  removed: number;
  left: number;
} {
  const blocks = blocksIn(markdown);
  const pure = (block: string) =>
    !block.includes("\n") && !NOT_A_PARAGRAPH.test(block) && onlyAPointer(block.trim());
  const kept = blocks.filter((block) => !pure(block));
  const pointing = blocks.filter(
    (block) => pure(block) || (!FENCE.test(block) && POINTS_BACK.test(block)),
  ).length;
  const removed = blocks.length - kept.length;
  if (removed === 0 || kept.length === 0) return { markdown, removed: 0, left: pointing };
  return { markdown: kept.join("\n\n"), removed, left: pointing - removed };
}

export const forPage = (markdown: string, question: string): string =>
  asksAboutEarlier(question) ? markdown : withoutPointersBack(markdown).markdown;
