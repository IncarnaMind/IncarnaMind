/**
 * A narrow safety net under the change log, which is what the Answer reports:
 * a reply that says it changed a Mind when none of its Tool calls did (or not
 * that Mind) is asked for once more, with the record of what the calls did
 * (./toolRecord), and one that still says so is flagged. It reads only the
 * plainest reports, in English and Chinese ("I've added…", "Shortened the
 * summary in “Q3 review”…", "The summary is now twice as long", "页面已创建"),
 * and misses a vague sentence rather than flag an honest one.
 */
import type { AnswerToolCall, ClaimedChange } from "../api";
import type { UnmadeFixes } from "./claimedFixes";
import { type ChangeStates, type MindNames, toolRecordLines } from "./toolRecord";

/** A change a sentence of the reply says was made, and the Mind it names, by its name; null for none. */
export interface Claim {
  kind: ClaimedChange;
  sentence: string;
  mind: string | null;
  /** It names the User's own Mind without its name: "your notes", "这篇笔记". */
  theirs: boolean;
}

const MADE = "made|created|started|set up";
const ADDED = "added|wrote|written|put|inserted|drafted|appended";
const CHANGED =
  "updated|changed|edited|revised|rewrote|rewritten|expanded|lengthened|extended|shortened|trimmed|condensed|tightened|fixed|corrected|translated|reworded|restructured|reorganized|reorganised|polished|improved|proposed|merged|moved";
const REMOVED = "removed|deleted|replaced|dropped|took out|taken out";
const VERBS = `${MADE}|${ADDED}|${CHANGED}|${REMOVED}`;
// "Proposed in 2017, the Transformer…": these start other sentences too.
const REPORT_VERBS = VERBS.replace(/\|(?:proposed|merged|moved|put|set up|started)\b/g, "");

const KIND_OF_VERB: [RegExp, ClaimedChange][] = [
  [new RegExp(`^(?:${MADE})$`, "i"), "made"],
  [new RegExp(`^(?:${ADDED})$`, "i"), "added"],
  [new RegExp(`^(?:${CHANGED})$`, "i"), "changed"],
  [new RegExp(`^(?:${REMOVED}|replaces)$`, "i"), "removed"],
];

// Only a Mind the sentence names, or plainly calls a page or a note: "the draft" or "this
// version" may be a Document's.
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
// A change still waiting is the User's to accept: saying so is no claim of a new one.
const WAITING = /\b(?:waiting|pending|proposed|proposal|proposals)\b/i;
// "I" opening a clause: "the summary I wrote" is about the summary, not a report of writing.
const CLAUSE_START =
  /(?:^|[,;:—–]\s*|\b(?:and|then|so|also|now|ok|okay|sure|done|yes|great)\b[,:!]?\s+)$/i;

const FIRST_PERSON = new RegExp(
  `\\bI(?:'ve|’ve| have|'d|’d| had)?(?:\\s+(?:just|also|now|then|already|quickly))*\\s+(${VERBS})\\b`,
  "gi",
);
const HEADING_LIKE = /^(?![-*•]\s)[^.!?。！？]*$/;
// "Added it to your notes" is about the Mind the User is in (#1109), not any Mind.
const THEIRS =
  /\b(?:your|this|my)\s+(?:own\s+)?(?:notes?|page|mind|notebook)\b|你的笔记|您的笔记|这篇笔记|这个笔记|当前笔记|你的页面/i;
const REPORT = new RegExp(`^(?:[-*•]\\s+)?(${REPORT_VERBS})\\b`, "i");
const PASSIVE = new RegExp(`\\b(?:has|have) been (${VERBS})\\b`, "i");
// "Summary page created in “X”", "The new page replaces the earlier version": a page or a Mind
// said to be made, which a Document's text rarely says of itself.
const STATED =
  /^(?:the\s+|a\s+|your\s+|this\s+)?(?:new\s+)?(?:summary\s+)?(?:page|mind)\s+(?:was\s+|has been\s+|is\s+|now\s+)?(made|created|replaces)\b/i;
// "The summary is now twice as long", "Your notes are ready".
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
// Only the User's notes: "我更新了我的理解" or "表 4 已经更新" are not.
const CHINESE_MIND = /笔记|页面|Mind|总结|摘要|章节|段落/;
// "总结已扩写", "页面已创建": a Mind's text said to be done, not the authors'.
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
    // "Expanded two-paper summary" on a line of its own is a heading, not a report.
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

const sentencesOf = (reply: string): string[] =>
  reply
    .replace(/\[\^\d+\]|\[=\d+\]/g, "")
    .split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");

const MAY_CLAIM = new RegExp(`\\bI\\b|\\b(?:now|been|${VERBS}|replaces)\\b|[“"«]|我|已`, "iu");
const REPORT_VERB_LIST = REPORT_VERBS.split("|");

/**
 * How much of a reply being written may show, as it grows: up to the first
 * sentence that may claim a change, which waits until the reply is checked.
 * Of the sentence still being written, all but its last word, unless it has
 * begun the way a claim does. Each finished sentence is read once; a reply
 * taken back, or that doesn't start as the last one did, is read afresh.
 */
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

/** `holdBack` of a whole reply at once. */
export const shownUpTo = (text: string, minds: readonly string[]): number =>
  holdBack(() => minds)(text);

/** `minds`: the names of the User's Minds, so a quoted name counts as a Mind's only when it is one. */
export function claimsIn(reply: string, minds: readonly string[] = []): Claim[] {
  const names = new Map(minds.map((name) => [nameKey(name), name]));
  return sentencesOf(reply).flatMap((sentence) => sentenceClaims(sentence, names));
}

/** The Minds each kind of change was made in, by id. */
export interface ChangeLog {
  made: Set<string>;
  /** Anything written: added, rewritten, revised, or made with text. */
  changed: Set<string>;
  /** Text already there rewritten, so some may be gone. */
  edited: Set<string>;
}

export function changeLogOf(calls: readonly AnswerToolCall[]): ChangeLog {
  const log: ChangeLog = { made: new Set(), changed: new Set(), edited: new Set() };
  for (const call of calls) {
    const change = call.mindChange;
    if (call.source !== "minds" || !change) continue;
    if (change.created) log.made.add(change.mindId);
    if (change.proposals > 0 || change.revised) log.changed.add(change.mindId);
    if (call.tool === "edit_mind" && (change.proposals > 0 || change.revised)) {
      log.edited.add(change.mindId);
    }
  }
  return log;
}

function backs(log: ChangeLog, kind: ClaimedChange, mindIds: readonly string[] | null): boolean {
  const done =
    kind === "made"
      ? log.made
      : kind === "removed"
        ? log.edited
        : new Set([...log.changed, ...log.made]);
  return mindIds === null ? done.size > 0 : mindIds.some((id) => done.has(id));
}

/**
 * The kinds of change a reply claims that none of `calls` made, in the Mind
 * a claim names (by its name, among `minds`, or as the User's own, `focused`),
 * else in any. Each kind once.
 */
export function unbackedClaims(
  reply: string,
  calls: readonly AnswerToolCall[],
  minds: readonly { id: string; name: string }[] = [],
  focused: string | null = null,
): ClaimedChange[] {
  const log = changeLogOf(calls);
  const idsOf = (claim: Claim) =>
    claim.mind !== null
      ? minds
          .filter((mind) => nameKey(mind.name) === nameKey(claim.mind ?? ""))
          .map((mind) => mind.id)
      : claim.theirs && focused !== null
        ? [focused]
        : null;
  const unbacked = claimsIn(
    reply,
    minds.map((mind) => mind.name),
  ).filter((claim) => !backs(log, claim.kind, idsOf(claim)));
  return [...new Set(unbacked.map((claim) => claim.kind))];
}

const CLAIMED_WORDS: Record<ClaimedChange, string> = {
  made: "made a Mind",
  added: "added text to a Mind",
  changed: "changed a Mind",
  removed: "removed or replaced text in a Mind",
};

const UNSEEN_REPLY =
  "The User will not read your earlier reply and does not know you were asked again. Write your reply as if for the first time: don't mention, apologise for or correct an earlier reply.";

/** The record of what the calls did, then to write the reply again from it. */
export function askAgainNote(
  claims: readonly ClaimedChange[],
  calls: readonly AnswerToolCall[],
  names: MindNames,
  states?: ChangeStates,
): string {
  const said = claims.map((claim) => CLAIMED_WORDS[claim]).join(", and ");
  return [
    thisAnswersRecord(calls, names, states),
    `Your reply says you ${said}, but no Tool did that. Write your reply again from its start, without saying what you changed: IncarnaMind lists each change under your reply. Say plainly what wasn't done and why. If the User's request still needs a change you can make now, make it with the Tools first.`,
    UNSEEN_REPLY,
  ].join("\n");
}

/** The record of what the calls did, then what the reply says its edits fixed that they didn't (./claimedFixes). */
export function unmadeFixesNote(
  unmade: UnmadeFixes,
  calls: readonly AnswerToolCall[],
  names: MindNames,
  states?: ChangeStates,
): string {
  const said = [
    ...(unmade.words.length > 0
      ? [
          `that you fixed ${unmade.words.map((word) => `“${word}”`).join(", ")}, but your edits left ${unmade.words.length === 1 ? "it" : "them"} in the Mind as before`,
        ]
      : []),
    ...(unmade.count
      ? [
          `${unmade.count.claimed} ${unmade.count.of === "places" ? "fixes" : "paragraphs changed"}, but your edits made ${unmade.count.made}`,
        ]
      : []),
  ];
  return [
    thisAnswersRecord(calls, names, states),
    `Your reply says ${said.join(", and ")}. If the User's request still needs that change, make it now with edit_mind. Then write your reply again from its start, saying only what your edits did.`,
    UNSEEN_REPLY,
  ].join("\n");
}

function thisAnswersRecord(
  calls: readonly AnswerToolCall[],
  names: MindNames,
  states?: ChangeStates,
): string {
  const lines = toolRecordLines(calls, names, states);
  return [
    "<tool-record>",
    "What the Tools of this Answer really did, as IncarnaMind recorded it:",
    ...(lines.length > 0 ? lines : ["- No Tool was called."]),
    "</tool-record>",
  ].join("\n");
}
