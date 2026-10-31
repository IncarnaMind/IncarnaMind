/**
 * Which of the Documents in scope a Question is about, from its words, in
 * English and Chinese: a summary of each of them ("summarise these papers",
 * "总结这些文档"), or the main few ("the two main documents"). A summary of
 * more than `COVERED_AT_ONCE` covers the largest, and says so with an offer
 * of the rest; the main few are the largest, named, with an offer of others.
 * A Document the Question names that it read, when the name fits others too,
 * is named with an offer of those others.
 */
import { displayName } from "../../shared/documentNames";
import type { AnswerCoverage } from "../api";
import { keywordTerms, keywordText } from "../documents/keywords";

export const COVERED_AT_ONCE = 8;

export interface SizedDocument {
  id: string;
  name: string;
  size: number;
}

const SUMMARY =
  /\b(?:summar(?:y|ies|i[sz]e[sd]?|i[sz]ing)|overview|digest|recap|synops[ie]s)\b|总结|概括|概述|摘要|综述|汇总/i;

/** More ways a call is summed up ("past 5 minutes", "key takeaways", "回顾"), beside `SUMMARY`. */
/** More ways a call is summed up ("past 5 minutes", "key takeaways", "回顾"), beside `SUMMARY`. */
const RECAP =
  /\b(?:sum up|gist|run[- ]?through|walk (?:me )?through|go over|catch (?:me )?up|(?:bring|get) me up to speed|fill (?:me )?in|what happened|where (?:are|were) we|tl;?dr|takeaways?|highlights?|key points?|decisions?|(?:covered|discussed|said|agreed|decided) so far)\b|\bwhat (?:we(?:'ve| have)?|did we|has been|was) (?:cover(?:ed)?|discuss(?:ed)?|say|said|talk(?:ed)? about|agree|agreed|decide|decided)\b|\bwhere we (?:are|left off|got to)\b|\bwhere (?:did )?we (?:leave|left) off\b|回顾|复盘|小结|梳理|归纳|聊到哪|说到哪|讲到哪|(?:刚才|刚刚).{0,8}(?:讲了什么|说了什么|聊了什么)|(?:到目前为止|到今天为止|目前为止|到现在).{0,8}(?:讲|说|聊)了?(?:什么|哪些|些什么)|错过了?什么|要点|重点/i;

/** What a summary has to be about to be a recap of the call: the call, its span, or what was said. */
const ABOUT_THE_CALL =
  /\b(?:(?:call|conversation|meeting|discussion)|so far|up to (?:now|here)|(?:last|past|previous) (?:\d+|two|three|four|five|six|seven|eight|nine|ten|few|several) minutes|we(?:'ve| have) (?:covered|discussed|said|talked|agreed|decided)|what (?:we(?:'ve| have)?|did we|has been|was) (?:cover(?:ed)?|discuss(?:ed)?|say|said|talk(?:ed)? about|agree|agreed|decide|decided)|(?:bring|get) me up to speed|fill (?:me )?in|what (?:i missed|did i miss)|what happened|where (?:are|were) we|catch (?:me )?up|tl;?dr|takeaways?|highlights?|key points?|decisions?|what \p{Lu}[\p{L}'-]* said)\b|(?:通话|会议|对话|讨论|到目前为止|目前为止|目前(?:为止)?的?(?:通话|会议|讨论|情况|进展)|最近(?:\s*\d+\s*分钟|几分钟|的通话|的会议|的讨论)|刚才|刚刚|至今|到现在|聊到|说到|讲到|错过|要点|重点)/iu;

/** Polite ways a Question asks for something: they are no reference to the assistant's earlier words. */
const REQUEST_FRAME =
  /\b(?:can|could|would|will)\s+you\b|\byou\s+please\b|\bplease\b|(?:你|您)能|(?:你|您)可以|能不能|能否|麻烦(?:你|您)?|请问|请帮(?:我|忙)?|请你|请您|请|你帮我|您帮我|你给我(?=(?:回顾|总结|概括|梳理|讲|说|看|读|念|复盘))|您给我(?=(?:回顾|总结|概括|梳理|讲|说|看|读|念|复盘))/gi;

/** A phrase about someone else's answer, not the assistant's: "the previous answer from the client". */
const NOT_THE_ASSISTANT =
  /\b(?:the\s+)?(?:(?:earlier|previous|last|prior|preceding)\s+)?(?:answers?|repl(?:y|ies)|responses?)\s+(?:from|by|of)\s+(?:the\s+)?(?:participants?|attendees?|people|others?|team|members?|speakers?|user|clients?|customers?|candidates?|interviewees?)\b|(?:客户|对方|参与者|面试者|团队成员)(?:之前|刚才|上面|前面)的?(?:回答|回复|答复)/g;

/** A call's own span, not a reference to the assistant: "the previous 10 minutes". */
const CALL_SPAN =
  /\b(?:last|past|previous)\s+(?:\d+|few|several|two|three|four|five|six|seven|eight|nine|ten)\s+minutes\b/g;

/**
 * What points at the assistant's own earlier words once request frames and other people's
 * answers are taken out: a second-person word, or a back-reference. Its test errs toward
 * keeping the turns: a wrong drop loses a reply the User asked about, while a wrong keep is
 * only the old recap context (#1319).
 */
const REFERS_TO_AN_EARLIER_REPLY =
  /\b(?:you|your|yours)\b|\b(?:from before|earlier|above|previous)\b|\b(?:those|these)\b|\b(?:that|this)\s+(?:list|message|answer|reply|response)\b|\blast\s+(?:message|answer|reply|response)\b|\bcall[ -]help\b|[你您]|前面|上面|之前|(?:刚才|刚刚)的?(?:回答|回复|答复|消息|清单|建议|提示|问题)|那几|那条|这几/iu;

const refersToTheAssistant = (question: string): boolean =>
  REFERS_TO_AN_EARLIER_REPLY.test(
    question.replace(REQUEST_FRAME, " ").replace(NOT_THE_ASSISTANT, " ").replace(CALL_SPAN, " "),
  );

/**
 * Whether a Question asks for a recap of the live call ("recap the last 5 minutes",
 * "回顾最近 5 分钟"): summary words and a reference to the call or its span, but not a
 * Question about the assistant's own earlier words, which keeps the turns it asks about (#1319).
 */
export const asksForCallRecap = (question: string): boolean =>
  (SUMMARY.test(question) || RECAP.test(question)) &&
  ABOUT_THE_CALL.test(question) &&
  !refersToTheAssistant(question);
const DOCUMENT_WORDS = "(?:documents|docs|papers|files|reports)";
const ZH_DOCUMENT_WORDS = "(?:文档|论文|文件|报告)";
const THE_SET = new RegExp(
  `\\b(?:these|those|the|all(?: of)?(?: the| my)?|both|my|each of the|every one of the)\\s+(?:\\d+\\s+|two\\s+|three\\s+|four\\s+|five\\s+|six\\s+|seven\\s+|eight\\s+|nine\\s+|ten\\s+)?${DOCUMENT_WORDS}\\b|\\b(?:each|every)\\s+(?:document|doc|paper|file|report)\\b|这些${ZH_DOCUMENT_WORDS}|这(?:两|几|[二三四五六七八九十]|\\d+)(?:份|篇|个)${ZH_DOCUMENT_WORDS}|(?:所有|全部)的?${ZH_DOCUMENT_WORDS}|每一?(?:份|篇|个)${ZH_DOCUMENT_WORDS}`,
  "i",
);
// "What the documents say about leverage" asks about a topic, which every Document is searched for;
// "a summary about these 2 papers" and "关于这些文档的总结" are about the Documents themselves.
const TOPIC_WORD = /\b(?:about|on|regarding|concerning)\s+|关于|有关|对于/giu;
const SET_FIRST = new RegExp(`^(?:${THE_SET.source})`, "i");
const PLACE_FIRST = /^(?:a|the|my)?\s*(?:new\s+)?(?:page|note|mind)\b/i;

function asksAboutATopic(question: string, names: () => readonly string[]): boolean {
  for (const match of question.matchAll(TOPIC_WORD)) {
    const after = question.slice(match.index + match[0].length).trimStart();
    if (PLACE_FIRST.test(after) || SET_FIRST.test(after)) continue;
    const lower = after.toLocaleLowerCase();
    if (names().some((name) => lower.startsWith(name.toLocaleLowerCase()))) continue;
    return true;
  }
  return false;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
};
const MAIN = new RegExp(
  `\\b(?:the\\s+)?(\\d|one|two|three|four|five)\\s+(?:main|most important|key|principal|core)\\s+${DOCUMENT_WORDS}\\b`,
  "i",
);
const THE_MAIN =
  /\bthe\s+(?:main|most important|key|principal)\s+(?:document|doc|paper|file|report)\b/i;
const ZH_MAIN =
  /(\d|[一两二三四五])(?:份|篇|个)(?:最)?(?:主要|重要|核心)的?(?:文档|论文|文件|报告)|(?:主要|最重要|核心)的(\d|[一两二三四五])(?:份|篇|个)/;

/** What a Question asks of the Documents in scope, `names` theirs: each of them, the main `main`, or neither. */
export function documentsAsked(
  question: string,
  names: () => readonly string[] = () => [],
): { each: boolean; main: number | null } {
  const main = MAIN.exec(question) ?? ZH_MAIN.exec(question);
  const count = main ? (main[1] ?? main[2] ?? "") : "";
  const parsed = Number.parseInt(count, 10);
  const asked = Number.isNaN(parsed) ? (NUMBER_WORDS[count.toLowerCase()] ?? null) : parsed;
  return {
    each: SUMMARY.test(question) && THE_SET.test(question) && !asksAboutATopic(question, names),
    main: asked ?? (THE_MAIN.test(question) ? 1 : null),
  };
}

/**
 * What an Answer covers of `documents` (the Documents in scope, the most text
 * first): the main few or the largest `COVERED_AT_ONCE`, with the rest; null
 * when it covers them all as they are.
 */
export function coverageOf(
  asked: { each: boolean; main: number | null },
  documents: readonly SizedDocument[],
): AnswerCoverage | null {
  const named = (each: SizedDocument) => ({ id: each.id, name: each.name });
  if (asked.main !== null && documents.length > asked.main) {
    return {
      kind: "main",
      used: documents.slice(0, asked.main).map(named),
      rest: documents.slice(asked.main).map((each) => each.id),
    };
  }
  if (asked.each && documents.length > COVERED_AT_ONCE) {
    return {
      kind: "largest",
      used: documents.slice(0, COVERED_AT_ONCE).map(named),
      rest: documents.slice(COVERED_AT_ONCE).map((each) => each.id),
    };
  }
  return null;
}

export interface TitledDocument {
  id: string;
  name: string;
  /** Its own title (see ../documents/title), which may name it where its file name doesn't. */
  title?: string | null;
}

const HAN = /\p{Script=Han}/u;
// "The document" and "这个文件" name no one Document; what "this document" means is #1334's.
const ANY_DOCUMENT = /^(?:documents?|docs?|files?|pdfs?|文档|文件)$/;

const compact = (text: string) => text.replaceAll(" ", "");

const has = (fields: readonly string[], term: string) =>
  fields.some((words) =>
    HAN.test(term)
      ? compact(words).includes(compact(term))
      : words.split(" ").some((word) => word === term || word === `${term}'s`),
  );

const canName = (term: string) =>
  /\p{L}/u.test(term) && compact(term).length >= (HAN.test(term) ? 2 : 3);

/**
 * A Document the Answer used that the Question's words name, when they name others of `documents`
 * (those in scope) too (#1512): the first of `used` (the Documents it cited, or those its Passages
 * came from when it cited none, in order) whose name or title has the Question's words that some
 * other Document's has as well, named as the User sees it, with those others in `excluded` — every
 * Document it used or searched by name — left out; null when there is none.
 */
export function namedCoverage(
  question: string,
  used: readonly string[],
  excluded: readonly string[],
  documents: readonly TitledDocument[],
): AnswerCoverage | null {
  const terms = keywordTerms(question).filter(
    (term) => compact(term).length > 1 && !ANY_DOCUMENT.test(term),
  );
  const words = new Map<string, string[]>();
  const namedBy = (document: TitledDocument, term: string) => {
    let fields = words.get(document.id);
    if (!fields) {
      fields = [document.name, document.title].flatMap((field) =>
        field ? [keywordText(field)] : [],
      );
      words.set(document.id, fields);
    }
    return has(fields, term);
  };
  for (const id of used) {
    const document = documents.find((each) => each.id === id);
    if (!document) continue;
    const said = terms.filter((term) => namedBy(document, term));
    if (!said.some(canName)) continue;
    const rest = documents.filter(
      (each) => !excluded.includes(each.id) && said.every((term) => namedBy(each, term)),
    );
    if (rest.length > 0) {
      return {
        kind: "named",
        used: [{ id: document.id, name: displayName(document) }],
        rest: rest.map((each) => each.id),
      };
    }
  }
  return null;
}

const quotedList = (names: readonly string[]) =>
  names.length < 2
    ? `“${names[0] ?? ""}”`
    : `${names
        .slice(0, -1)
        .map((name) => `“${name}”`)
        .join(", ")} and “${names.at(-1)}”`;

/** What the model is told of the Documents a Question asks about; "" when nothing. */
export function coverageInstructions(
  coverage: AnswerCoverage | null,
  each: boolean,
  documents: number,
): string {
  const covered = coverage?.used.map((document) => document.name) ?? [];
  const searchEach =
    "Search each one (search_documents with its document), cite each at least once, and say in your reply which, if any, you couldn't cover. Nothing about your searching goes into a Note.";
  if (coverage?.kind === "main") {
    return `The User asked about the main Documents: IncarnaMind took ${quotedList(covered)}, the largest, and says so above your reply, with an offer of others. Answer from ${covered.length === 1 ? "it" : "these"}; don't ask which.`;
  }
  if (coverage?.kind === "largest") {
    return `This Answer covers the ${covered.length} largest of ${covered.length + coverage.rest.length} Documents: ${quotedList(covered)}. IncarnaMind says so above your reply and offers the rest, so don't name or apologise for the others. ${searchEach}`;
  }
  return each && documents > 1
    ? `The User asked about each of the ${documents} Documents. ${searchEach}`
    : "";
}
