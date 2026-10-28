/**
 * Which of the Documents in scope a Question is about, from its words, in
 * English and Chinese: a summary of each of them ("summarise these papers",
 * "总结这些文档"), or the main few ("the two main documents"). A summary of
 * more than `COVERED_AT_ONCE` covers the largest, and says so with an offer
 * of the rest; the main few are the largest, named, with an offer of others.
 */
import type { AnswerCoverage } from "../api";

export const COVERED_AT_ONCE = 8;

export interface SizedDocument {
  id: string;
  name: string;
  size: number;
}

const SUMMARY =
  /\b(?:summar(?:y|ies|i[sz]e[sd]?|i[sz]ing)|overview|digest|recap|synops[ie]s)\b|总结|概括|概述|摘要|综述|汇总/i;
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
