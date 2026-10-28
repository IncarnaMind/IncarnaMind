/**
 * The phrase rule for an unanswerable Question's Answer: does it say the
 * Documents don't answer the Question? It starts from how the app's answer
 * prompt tells the model to decline ("If the Documents don't cover the
 * Question, say so plainly"; "isn't in what you were given") and adds how
 * models word it. It is a first pass: a reviewer marks the declines it misses
 * on the sheet. A nearby fact cited without saying so isn't a decline.
 */

const ADVERBS =
  "(?:explicitly|directly|specifically|clearly|actually|even|anywhere|seem to|appear to)";
const SAYS =
  "(?:say|state|mention|specify|cover|contain|address|answer|discuss|report|give|provide|include|have|disclose|reveal|appear|exist)";
const DOCUMENT =
  "(?:documents?|docs?|passages?|sources?|files?|materials?|texts?|reports?|papers?|articles?|excerpts?|notes?|pdfs?)";
const WHERE =
  "(?:found|covered|included|mentioned|stated|specified|given|provided|addressed|available|present|reported|listed|contained|discussed|answered|documented|recorded)";

const ENGLISH = [
  // "the Documents don't say", "the report does not mention", "none of the Documents cover"
  new RegExp(
    `\\b${DOCUMENT}\\b[^.!?\\n]{0,60}?\\b(?:do(?:es)?n't|do(?:es)? not|never)\\s+(?:${ADVERBS}\\s+)*${SAYS}\\b`,
  ),
  new RegExp(`\\bnone of (?:the|your|these|those) (?:\\w+ ){0,2}${DOCUMENT}\\b`),
  // "was not specified"
  new RegExp(`\\b(?:is|are|was|were)(?:n't| not)\\s+(?:${ADVERBS}\\s+)*${WHERE}\\b`),
  // "isn't in your Documents", "is not in what you were given": not "was not in effect"
  new RegExp(
    `\\b(?:is|are|was|were)(?:n't| not)\\s+in\\s+(?:(?:\\w+\\s+){0,3}?${DOCUMENT}\\b|(?:what|anything) (?:you|i) (?:were|was|have been|had been) given)`,
  ),
  // "there is no information about…"
  /\bno (?:\w+ ){0,2}(?:information|mention|data|record|figures?|references?|details?|evidence|statement|indication|answer)\b/,
  // "I couldn't find", "can't be determined from"
  /\b(?:could(?:n't| not)|can(?:'t|not)|can not|did(?:n't| not)|was(?:n't| not) able to|unable to)\s+(?:\w+\s+){0,2}?(?:find|found|located?|determined?|answered?|confirmed?|tell|say|identified?|established?)\b/,
  /\bthe closest (?:they|it|that (?:they|it)) comes?\b/,
  /\b(?:lack(?:s|ed|ing)?|missing|absent|unavailable|without)\b/i,
  /\bi (?:don't|do not) (?:know|have)\b|\bi(?:'m| am) not (?:sure|certain)\b/,
];

const NEGATION = "(?:并没有|并未|并不|没有|没能|未能|未曾|未|没)";
const STRONG_ZH =
  "(?:明确|直接|具体|专门|任何)?(?:提到|提及|说明|涉及|记载|找到|发现|查到|讨论|说到|写明|涵盖|回答|相关|答案)";
const WEAK_ZH =
  "(?:明确|直接|具体|专门|任何)?(?:给出|提供|包含|披露|载明|描述|介绍|列出|显示|信息|数据)";
const DOCUMENT_ZH = "(?:文档|资料|文件|材料|所给|提供的内容)";
const OPENING = "(?:^|[。！？!?\\n])\\s*(?:我们|我)?";

// A negation says the Documents don't answer when a Document word comes just
// before it, or when it opens the Answer: elsewhere it may be a fact about the company.
const CHINESE = [
  // 文档中没有提到, 文档未说明, 资料里并未披露
  new RegExp(`${DOCUMENT_ZH}[^。！？!?\\n]{0,10}${NEGATION}(?:${STRONG_ZH}|${WEAK_ZH})`),
  // 未在“Doc”中找到 X
  /未在[^。！？!?\n]{0,60}中找到/,
  // 没有找到相关内容, 未说明
  new RegExp(`${OPENING}${NEGATION}${STRONG_ZH}`),
  // 找不到 has its negation inside: a Document word or 您/你 before it, or the Answer's opening
  new RegExp(
    `(?:${DOCUMENT_ZH}|您|你)[^。！？!?\\n]{0,10}(?:找不到|查不到)|${OPENING}(?:找不到|查不到)`,
  ),
  /无法(?:从[^，。,.]{0,15})?(?:确定|回答|得知|得出|判断|找到|提供|告诉|说明|确认)/,
  /不在(?:您|你)?(?:的|已添加的)?(?:文档|资料|文件)/,
  /最接近/,
  /缺少|缺失|不存在|未披露|未提及|未说明|未包含|不含|未曾|并未|没有/,
  /(?:我|本人)?(?:不知道|不确定|不清楚)/,
];

/** The text without citation markers ("[^1]"), with straight apostrophes, in lower case. */
function readable(text: string): string {
  return text
    .replace(/\[\^\d+\]/g, "")
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

/** Whether an Answer says the Documents don't answer the Question, by the phrase rule in English and Chinese. */
export function declines(text: string): boolean {
  const plain = readable(text);
  return [...ENGLISH, ...CHINESE].some((phrase) => phrase.test(plain));
}
