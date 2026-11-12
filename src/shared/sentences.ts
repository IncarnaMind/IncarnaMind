/**
 * The sentences of a paragraph's text, as checks and note health count them
 * (#96): read by the core from the Mind's Yjs document and by the editor
 * from its own, the same way. In that text an inline node (a Citation, a
 * formula, a footnote) is one U+FFFC and a line break is "\n", so offsets
 * are the core's `TextPlace` offsets.
 */

import { recordCiteSpans } from "../core/recordCites/parser";
import { citedCases } from "./caseCitations";

/** An inline node in a paragraph's text. */
export const INLINE_NODE = "￼";

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/** Where a sentence is in its paragraph's text, without the spaces around it. */
export interface SentenceSpan {
  from: number;
  to: number;
}

const isSpace = (char: string | undefined) => char !== undefined && /\s/u.test(char);

/** Holds a letter or a digit: a stray mark or a lone Citation isn't a sentence. */
const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

/** A title or an abbreviation the segmenter takes for a sentence's end: "Mr. Smith", "Fig. 2". */
const ABBREVIATION = /(?:^|\s)(?:mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|fig|no|inc|ltd|co|corp)\.$/iu;

/**
 * A page reference the segmenter ends a sentence at: "at p. 4" is one
 * sentence, but "the plan was p." followed by "4" would not be.
 */
const PAGE_REFERENCE = /(?:^|\s)(?:p|pp)\.$/iu;

/** A company's abbreviation ends a sentence when a court decision's citation follows it: "…bought from Acme Co. Smith v. Jones, …". */
const COMPANY_ABBREVIATION = /(?:^|\s)(?:inc|ltd|co|corp)\.$/iu;

/** The words a brief puts before its cites: "See also Smith Dep. 45:3–12." */
const CITATION_SIGNAL =
  /\b(?:see|also|cf|accord|but|e\.g|compare|with|and|generally|contra)\b\.?,?/giu;

/** Whether a sentence holds record cites and nothing else ("Smith Dep. 45:3–12.", "Id."), the cites it holds being `cites`. */
function onlyRecordCites(text: string, from: number, to: number, cites: readonly SentenceSpan[]) {
  if (cites.length === 0) return false;
  let rest = "";
  let at = from;
  for (const cite of cites) {
    rest += text.slice(at, Math.max(at, cite.from));
    at = Math.max(at, cite.to);
  }
  rest += text.slice(at, to);
  return !hasWords(rest.replace(CITATION_SIGNAL, ""));
}

const CHINESE = /\p{Script=Han}/u;
const LETTER = /\p{L}/u;
const FULL_STOP = /[.!?。！？]/u;
const CHINESE_FULL_STOP = /[。！？]/u;
const ENGLISH_STOP_AT_END = /[.!?][^\p{L}\p{N}\n。！？]*$/u;
const QUOTATION_MARKS = new Map([
  ["“", "”"],
  ['"', '"'],
  ["「", "」"],
  ["『", "』"],
]);

function inChineseSentence(text: string, open: number, close: number | null): boolean {
  if (text[open] === "「" || text[open] === "『") return true;
  for (let at = open - 1; at >= 0; at--) {
    const char = text.charAt(at);
    if (LETTER.test(char)) return CHINESE.test(char);
    if (FULL_STOP.test(char)) break;
  }
  // A quotation that starts its sentence ("“…”是原话。") is in the language of what follows it.
  for (let at = (close ?? text.length) + 1; at < text.length; at++) {
    const char = text.charAt(at);
    if (LETTER.test(char)) return CHINESE.test(char);
    if (FULL_STOP.test(char)) return CHINESE_FULL_STOP.test(char);
  }
  return false;
}

function chineseQuotations(text: string): SentenceSpan[] {
  if (!CHINESE.test(text)) return [];
  const fullStops = /[。！？]/gu;
  const found: SentenceSpan[] = [];
  let sentenceEnd = -1;
  for (let at = 0; at < text.length; at++) {
    const mark = QUOTATION_MARKS.get(text.charAt(at));
    if (mark === undefined) continue;
    if (sentenceEnd <= at) {
      fullStops.lastIndex = at + 1;
      sentenceEnd = fullStops.exec(text)?.index ?? text.length;
    }
    // A mark not closed before its sentence's own full stop quotes up to it: a straight mark
    // would otherwise pair with the next sentence's.
    const close = text.indexOf(mark, at + 1);
    const closed = close !== -1 && close < sentenceEnd;
    if (inChineseSentence(text, at, closed ? close : null)) {
      found.push({ from: at, to: closed ? close : sentenceEnd });
      at = closed ? close : sentenceEnd;
    } else if (closed) at = close;
  }
  return found;
}

/**
 * The sentences of a paragraph's text, in order. A Citation's marker right
 * after a sentence's full stop ("…quarter.[1] Next") belongs to that
 * sentence, though the segmenter starts the next one at it. A court
 * decision's citation stays in one sentence: the segmenter ends one at the
 * "v." and at the "(Tex." inside it. So does a record cite, which the
 * segmenter ends at "Dep." or "Compl."; and a sentence of record cites alone
 * belongs to the sentence before it, the one it supports (#1709). A Chinese
 * sentence that quotes English ends at its own 。, not at a full stop inside
 * the quotation (#3009).
 */
export function sentenceSpans(text: string, figures: readonly number[] = []): SentenceSpan[] {
  if (figures.length > 0) {
    const characters = text.split("");
    for (const at of figures) if (characters[at] === INLINE_NODE) characters[at] = "0";
    return sentenceSpans(characters.join(""));
  }
  const decisions = citedCases(text);
  const records = recordCiteSpans(text);
  // The cites come in order, so each segment looks at the one place they have reached, not at all
  // of them (#2523).
  const unbrokenCitations: SentenceSpan[] = [...decisions, ...records].sort(
    (a, b) => a.from - b.from,
  );
  const decisionStarts = new Set(decisions.map((each) => each.from));
  const spans: SentenceSpan[] = [];
  let citationAt = 0;
  const overlapsCitation = (previousTo: number, from: number): boolean => {
    while ((unbrokenCitations[citationAt]?.to ?? Number.POSITIVE_INFINITY) <= from) citationAt++;
    const citation = unbrokenCitations[citationAt];
    return citation !== undefined && citation.from < previousTo;
  };
  const quotations = chineseQuotations(text);
  let quotationAt = 0;
  const quoted = (at: number): boolean => {
    while ((quotations[quotationAt]?.to ?? Number.POSITIVE_INFINITY) <= at) quotationAt++;
    const quotation = quotations[quotationAt];
    return quotation !== undefined && quotation.from < at;
  };
  let englishStop: number | null = null;
  for (const { segment, index } of segmenter.segment(text)) {
    let from = index;
    let to = index + segment.length;
    const previous = spans.at(-1);
    while (from < to && (text[from] === INLINE_NODE || isSpace(text[from]))) {
      if (text[from] === INLINE_NODE && previous) previous.to = from + 1;
      from++;
    }
    while (to > from && isSpace(text[to - 1])) to--;
    const before = previous && text.slice(previous.from, previous.to);
    const startsDecision = decisionStarts.has(from);
    const joined =
      before !== undefined &&
      ((ABBREVIATION.test(before) && !(startsDecision && COMPANY_ABBREVIATION.test(before))) ||
        (PAGE_REFERENCE.test(before) && /^\d/u.test(text.slice(from, to))) ||
        (englishStop !== null && quoted(englishStop)));
    if (previous && joined && from < to) previous.to = to;
    else if (previous && overlapsCitation(previous.to, from)) {
      previous.to = to;
    } else if (from < to && hasWords(text.slice(from, to))) spans.push({ from, to });
    else if (previous && from < to) previous.to = to;
    const stop = ENGLISH_STOP_AT_END.exec(segment);
    englishStop = stop ? index + stop.index : null;
  }
  const kept: SentenceSpan[] = [];
  let recordAt = 0;
  for (const span of spans) {
    while ((records[recordAt]?.from ?? Number.POSITIVE_INFINITY) < span.from) recordAt++;
    const inside: SentenceSpan[] = [];
    let scan = recordAt;
    let after: number | null = null;
    while ((records[scan]?.from ?? Number.POSITIVE_INFINITY) <= span.to) {
      const record = records[scan];
      if (!record) break;
      if (record.to <= span.to) inside.push(record);
      // A cite that starts where this sentence ends may be inside the next one, which starts there
      // too when no space stands between them.
      else if (record.from === span.to && after === null) after = scan;
      scan++;
    }
    recordAt = after ?? scan;
    const previous = kept.at(-1);
    if (previous && onlyRecordCites(text, span.from, span.to, inside)) previous.to = span.to;
    else kept.push(span);
  }
  return kept;
}

const SENTENCE_END = new RegExp(`[.!?。！？]["'”’)）\\]】${INLINE_NODE}\\s]*$`, "u");

/**
 * Whether the text of an Analysis table's caption line only names its table, as a heading does
 * (#2378): one sentence at most, none ended ("Sales vs. budget" ends none), and no number typed
 * beside the marker. A sentence or a figure the User types into the line is read, checked and
 * counted as any is.
 */
export function onlyNamesItsTable(text: string): boolean {
  if (/\p{N}/u.test(text)) return false;
  const spans = sentenceSpans(text);
  return (
    spans.length <= 1 && !spans.some((span) => SENTENCE_END.test(text.slice(span.from, span.to)))
  );
}

/** The text of a sentence as checks compare it: without inline nodes, spaces collapsed. */
export const comparableSentence = (text: string): string =>
  text.replaceAll(INLINE_NODE, "").replace(/\s+/gu, " ").trim();

/** The longest sentence Cite… starts with: a paragraph without a full stop gives its last words. */
const LONGEST_START = 400;

/**
 * The sentence being written (#281): the last of the text before the caret,
 * which may not have its full stop yet; empty when nothing is written. Inline
 * nodes are left out, as the words around them are what is searched.
 */
export function lastSentence(text: string): string {
  const spans = sentenceSpans(text);
  const last = spans.at(-1);
  if (!last) return "";
  const sentence = text.slice(last.from, last.to).replaceAll(INLINE_NODE, "").trim();
  if (sentence.length <= LONGEST_START) return sentence;
  const tail = sentence.slice(-LONGEST_START);
  const word = tail.search(/\s/u);
  return word === -1 ? tail : tail.slice(word + 1).trim();
}

/**
 * A sentence as a check's own "edited" comparison reads it. Tidy's changes alone — a space
 * between Chinese and Latin, and a comma's width — are not an edit; the sentence it shows
 * keeps the text as written.
 */
export const comparableCheckSentence = (text: string): string =>
  comparableSentence(text)
    .replace(/(?<=\p{Script=Han})\s+(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])\s+(?=\p{Script=Han})/gu, "")
    .replace(/，/g, ",");

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.,-]*/gu;

/**
 * Whether a sentence makes a claim worth a Citation, for note health: at
 * least three words, or four characters of Chinese, Japanese or Korean. A
 * word or two ("Thanks!", "Next steps") claims nothing.
 */
export function isClaim(text: string): boolean {
  const plain = comparableSentence(text);
  const cjk = plain.match(CJK)?.length ?? 0;
  if (cjk >= 4) return true;
  const words = plain.replace(CJK, " ").match(WORD)?.length ?? 0;
  return words + cjk >= 3;
}
