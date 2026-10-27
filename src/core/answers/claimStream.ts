/**
 * Only a streaming hint: a sentence that may claim a change waits for the
 * quick-model check. These patterns never decide whether a claim is backed;
 * claimedChanges.ts makes that decision from the verdict and the Tool record.
 */
import type { ClaimedChange } from "../api";

interface Claim {
  kind: ClaimedChange;
  sentence: string;
  mind: string | null;
  theirs: boolean;
}

const MADE = "made|created|started|set up";
const ADDED = "added|wrote|written|put|inserted|drafted|appended";
const CHANGED =
  "updated|changed|edited|revised|rewrote|rewritten|expanded|lengthened|extended|shortened|trimmed|condensed|tightened|fixed|corrected|translated|reworded|restructured|reorganized|reorganised|polished|improved|proposed|merged|moved";
const REMOVED = "removed|deleted|replaced|dropped|took out|taken out";
const VERBS = `${MADE}|${ADDED}|${CHANGED}|${REMOVED}`;
const REPORT_VERBS = VERBS.replace(/\|(?:proposed|merged|moved|put|set up|started)\b/g, "");
const KIND_OF_VERB: [RegExp, ClaimedChange][] = [
  [new RegExp(`^(?:${MADE})$`, "i"), "made"],
  [new RegExp(`^(?:${ADDED})$`, "i"), "added"],
  [new RegExp(`^(?:${CHANGED})$`, "i"), "changed"],
  [new RegExp(`^(?:${REMOVED}|replaces)$`, "i"), "removed"],
];
const MIND_REF =
  /\b(?:the|this|that|your|my|a|an)\s+(?:new\s+|separate\s+|summary\s+|short\s+|cited\s+)*(?:page|note|notes|mind|notebook|handout)\b/i;
const MADE_THING =
  /^\s+(?:(?:a|an|the|your|this|that|one)\s+)?(?:(?:new|separate|fresh|short|shorter|longer|cited|brief|full|summary)\s+)*(?:minds?\b|notes?\b|pages?\b|handout\b|notebook\b|[“"«])/i;
const MADE_INTO =
  /^\s+(?:it|this|that|them|the\s+(?:summary|section|page|note|notes)|your\s+(?:summary|section|page|note|notes))\s+(?:longer|shorter|clearer|simpler|tighter|more\s+\w+|less\s+\w+)/i;
const NOT_A_CHANGE =
  /^\s+(?:(?:no|nothing|none|any)\b|(?:(?:a|the|my|your|some|each|every|all|several|many|more|\d+)\s+)?(?:new\s+)?(?:citations?|sources?|references?|markers?|quotes?|footnotes?)\b|(?:my|the|this)\s+(?:answer|reply|response)\b|(?:sure|a mistake|an error|that clear)\b)/i;
const IN_THE_REPLY =
  /\b(?:below|above|here)[\s.:!]*$|\bin (?:this|my) (?:reply|answer|message)\b|下面|如下|以下|本回答/;
const NEGATION = /\b(?:not|nothing|never|no|none|yet to)\b|n['’]t\b|\bcannot\b/i;
const WAITING = /\b(?:waiting|pending|proposed|proposal|proposals)\b/i;
const CLAUSE_START =
  /(?:^|[,;:—–]\s*|\b(?:and|then|so|also|now|ok|okay|sure|done|yes|great)\b[,:!]?\s+)$/i;
const FIRST_PERSON = new RegExp(
  `\\bI(?:'ve|’ve| have|'d|’d| had)?(?:\\s+(?:just|also|now|then|already|quickly))*\\s+(${VERBS})\\b`,
  "gi",
);
const HEADING_LIKE = /^(?![-*•]\s)[^.!?。！？]*$/;
const THEIRS =
  /\b(?:your|this|my)\s+(?:own\s+)?(?:notes?|page|mind|notebook)\b|你的笔记|您的笔记|这篇笔记|这个笔记|当前笔记|你的页面/i;
const REPORT = new RegExp(`^(?:[-*•]\\s+)?(${REPORT_VERBS})\\b`, "i");
const PASSIVE = new RegExp(`\\b(?:has|have) been (${VERBS})\\b`, "i");
const STATED =
  /^(?:the\s+|a\s+|your\s+|this\s+)?(?:new\s+)?(?:summary\s+)?(?:page|mind)\s+(?:was\s+|has been\s+|is\s+|now\s+)?(made|created|replaces)\b/i;
const NOW_LONGER =
  /^(?:the|your|this|my)\s+(?:summary|section|page|note|notes|handout)\s+(?:is|are)\s+(?:now\s+(?:about\s+|roughly\s+|almost\s+)?(?:twice|three times|\d+(?:\.\d+)?\s+times|longer|shorter|much longer|much shorter)|(?:longer|shorter)\s+now)\b/i;
const READY =
  /^(?:the|your|this|my)\s+(?:new\s+)?(?:summary page|page|note|notes|handout)\s+(?:is|are)\s+(?:now\s+)?ready\b/i;
const CHINESE_KINDS = [
  ["新建|创建|建立|生成", "made"],
  ["添加|加入|加进|加到|放进|放入|放到|写入|写进|写到|插入|补充|追加|写好|写了|新增", "added"],
  [
    "修改|改写|更新|扩写|扩展|扩充|缩短|精简|压缩|翻译|调整|重写|润色|修正|改正|改短|改长|改成|加长|写长|写短|完善",
    "changed",
  ],
  ["删除|删去|删掉|替换|去掉|移除", "removed"],
] as const;
const CHINESE: [RegExp, ClaimedChange][] = CHINESE_KINDS.map(([verbs, kind]) => [
  new RegExp(
    `(?:^|[，,；;：:、\\s])(?:我(?:已经?|刚刚?|也|还|先)?|已经?)(?:为你|帮你|替你)?(?:在(?:[“"][^”"]{1,40}[”"]|[^，。！？“”"]{1,20}?)(?:中|里|上)?|(?:把|将)[^。！？]{1,40}?)?(?:${verbs})`,
  ),
  kind,
]);
const CHINESE_MIND = /笔记|页面|Mind|总结|摘要|章节|段落/;
const CHINESE_STATED: [RegExp, ClaimedChange][] = CHINESE_KINDS.map(([verbs, kind]) => [
  new RegExp(
    `^(?:这份|这个|你的)?(?:总结|页面|笔记|Mind|[“"][^”"]{1,40}[”"])(?:已经?|都已经?|均已)(?:被)?(?:${verbs}|完成)`,
  ),
  kind,
]);
const CHINESE_LONGER = /^(?:这份|这个|你的)?(?:总结|摘要|页面|笔记)现在(?:更长|更短|长了|短了)/;
const CHINESE_NOT = /没有|没|未能|未|无法|不能|尚未|并未/;
const CHINESE_WAITING = /待确认|待你|等你|等待/;
const CHINESE_REPORTED = /(?:说|称|声称|讲)$/;

const kindOf = (verb: string): ClaimedChange =>
  KIND_OF_VERB.find(([pattern]) => pattern.test(verb.replace(/\s+/g, " ")))?.[1] ?? "changed";
const nameKey = (name: string) => name.replace(/\s+/g, " ").trim().toLocaleLowerCase();

function sentenceClaims(sentence: string, minds: ReadonlyMap<string, string>): Claim[] {
  if (IN_THE_REPLY.test(sentence)) return [];
  const named =
    [...sentence.matchAll(/[“"«]([^”"»]{1,120})[”"»]/g)]
      .map((quote) => minds.get(nameKey(quote[1] ?? "")))
      .find((name) => name !== undefined) ?? null;
  const kinds: ClaimedChange[] = [];
  const trimmed = sentence.trim();
  if (!NEGATION.test(sentence) && !WAITING.test(sentence)) {
    for (const match of sentence.matchAll(FIRST_PERSON)) {
      if (!CLAUSE_START.test(sentence.slice(0, match.index))) continue;
      const after = sentence.slice(match.index + match[0].length);
      if (NOT_A_CHANGE.test(after)) continue;
      const kind = kindOf(match[1] ?? "");
      if (kind === "made" && MADE_INTO.test(after)) kinds.push("changed");
      else if (kind === "made") {
        if (MADE_THING.test(after)) kinds.push("made");
      } else if (named !== null || MIND_REF.test(after)) kinds.push(kind);
    }
    const report = HEADING_LIKE.test(trimmed) ? null : REPORT.exec(trimmed);
    if (report?.[1] && named !== null && !NOT_A_CHANGE.test(trimmed.slice(report[0].length))) {
      kinds.push(kindOf(report[1]));
    }
    const passive = PASSIVE.exec(sentence);
    if (passive?.[1] && (named !== null || MIND_REF.test(sentence))) kinds.push(kindOf(passive[1]));
    const stated = STATED.exec(trimmed);
    if (stated?.[1]) kinds.push(kindOf(stated[1]));
    if (NOW_LONGER.test(trimmed)) kinds.push("changed");
    if (READY.test(trimmed)) kinds.push("added");
  }
  if (!CHINESE_WAITING.test(sentence) && !CHINESE_NOT.test(sentence)) {
    const ofMind = named !== null || CHINESE_MIND.test(sentence);
    for (const [pattern, kind] of CHINESE) {
      const match = pattern.exec(trimmed);
      if (match && ofMind && !CHINESE_REPORTED.test(trimmed.slice(0, match.index + 1))) {
        kinds.push(kind);
      }
    }
    for (const [pattern, kind] of CHINESE_STATED) if (pattern.test(trimmed)) kinds.push(kind);
    if (CHINESE_LONGER.test(trimmed)) kinds.push("changed");
  }
  const theirs = named === null && THEIRS.test(sentence);
  return [...new Set(kinds)].map((kind) => ({ kind, sentence, mind: named, theirs }));
}

const MAY_CLAIM = new RegExp(`\\bI\\b|\\b(?:now|been|${VERBS}|replaces)\\b|[“"«]|我|已`, "iu");
const REPORT_VERB_LIST = REPORT_VERBS.split("|");

export function holdBack(minds: () => readonly string[]): (text: string) => number {
  let seen = "";
  let held = false;
  let length = 0;
  return (text) => {
    if (text.length < length || !text.startsWith(seen)) {
      seen = "";
      held = false;
    }
    length = text.length;
    let start = seen.length;
    if (held) return start;
    const names = new Map(minds().map((name) => [nameKey(name), name]));
    const boundary = /(?<=[.!?])\s+|(?<=[。！？])|\n+/g;
    boundary.lastIndex = start;
    for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
      if (match[0] === "") boundary.lastIndex++;
      const sentence = text
        .slice(start, match.index)
        .replace(/\[\^\d+\]|\[=\d+\]/g, "")
        .trim();
      if (sentence && sentenceClaims(sentence, names).length > 0) {
        held = true;
        break;
      }
      start = match.index + match[0].length;
    }
    seen = text.slice(0, start);
    if (held) return start;
    const rest = text.slice(start);
    if (MAY_CLAIM.test(rest)) return start;
    const word = /^\s*(\p{L}+)$/u.exec(rest)?.[1]?.toLocaleLowerCase();
    if (word && REPORT_VERB_LIST.some((verb) => verb.startsWith(word))) return start;
    const lastWord = /[\p{Script=Latin}\p{N}'’]+$/u.exec(rest);
    return lastWord ? start + lastWord.index : text.length;
  };
}

export const shownUpTo = (text: string, minds: readonly string[]): number =>
  holdBack(() => minds)(text);
