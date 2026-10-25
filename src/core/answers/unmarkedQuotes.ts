/**
 * Citations for what an Answer quotes without markers (#760; the decision is
 * in ADR-0007). Some models read Passages, then quote them word for word, or
 * nearly, and give no Citation for it: the Answer looks uncited, though
 * everything in it can be checked. So once an Answer is written and its own
 * records placed, each of its sentences that no Citation is on (no marker,
 * or only markers the model gave no record for) is matched to the Passages
 * it read:
 *
 * 1. a quotation starting in it ("…", “…”, 「…」), of at least three words,
 *    that the Citation check finds in a Passage, word for word;
 * 2. else the Passage sentence it is a near-duplicate of: they share at
 *    least five words and 60% of their words (Dice), give the same numbers
 *    (as a multiset, "739,800" read as one) and as many negations ("not",
 *    "no", "never", "n't", 不, 没, 未, 无, 非), and the check finds it there.
 *
 * Each match becomes a Citation record, taken as structured output's are,
 * and its marker goes after the sentence (see ./markerPlacement). A marker
 * the model wrote with no record goes to the first sentence that holds it
 * and matches; in another sentence it becomes that sentence's own Citation's
 * marker, or goes, as a marker with no record always did. Only a quote the
 * check finds is taken, so nothing added is "not found".
 *
 * The model is asked once more for its Citations, in one request with the
 * Answer and the Passages it read (as ./quoteRetry asks for quotes), when a
 * sentence is left with a marker it gave no record for, or, with no marker,
 * when nothing matches, the Answer has no Citation at all and one of its
 * sentences shares at least five words with one of the Passages'. What it
 * gives is taken the same way, a Citation taking the marker its sentence has.
 * An Answer in another language than its Passages shares no words with them
 * (#1415: Claude Haiku 5.5's Chinese summary of English Documents stayed
 * uncited where its English one was asked), so it is asked when it shares
 * what survives translation instead: a number in Latin digits, or a name or
 * term in Latin letters, of four or more. Never more than once per Answer, so
 * an Answer saying the Documents don't cover the Question, a greeting or a
 * question back doesn't pay for it. In the Tool loop the ask is one of the
 * end-of-turn checks' (see ./turnChecks): `mayAsk`.
 */
import { jsonSchema, Output, streamText } from "ai";
import { answerSentences } from "../../shared/answerSentences";
import { sentenceSpans } from "../../shared/sentences";
import { detectLanguage, LANGUAGE_SAMPLE } from "../documents/textLanguage";
import type { AnswerEngineEvent, AnswerRequest } from "./engine";
import {
  answerTableUnits,
  likeness,
  type MarkerRecord,
  textEdits,
  withMissingMarkers,
  wordsOf,
} from "./markerPlacement";
import { CITE_RETRY_INSTRUCTIONS, citeRetryPrompt } from "./prompt";
import { replyJson } from "./quoteRetry";
import type { WindowBudget } from "./window";

/** The most Citations added to one Answer. */
export const MAX_ADDED = 12;
/** Quoted text with fewer words than this (or CJK characters, by pairs) says too little to match. */
const MIN_QUOTED_WORDS = 3;
/** A sentence matches a Passage's sentence when they share this many words… */
const MIN_SHARED_WORDS = 5;
/** …and this much of their words (Dice similarity). */
const MIN_SIMILARITY = 0.6;
/** The most Passages, and of each one's text, the one request for Citations holds without a window. */
const MAX_ASKED_PASSAGES = 12;
const MAX_ASKED_CHARACTERS = 3000;
/** The request's output cap: a sentence, an id and a quote for each Citation. */
const ASK_OUTPUT_TOKENS = 1500;

/** Text in quotation marks. */
const QUOTATION = /["“「『]([^"“”「」『』\n]+)["”」』]/gu;
const MARKER = /\[\^(\d{1,4})\]/g;

interface ShownPassage {
  id: string;
  text: string;
}

/** A Citation to add: its Passage and quote, and the Answer's sentence it goes after. */
interface Match extends MarkerRecord {
  passage: string;
  sentence: string;
}

/**
 * A match, before its marker is given, with where its sentence is in the
 * Answer: the number of a marker the model wrote in the sentence with no
 * record behind it, which the Citation takes, if it is the first sentence
 * to hold that marker.
 */
type Found = Omit<Match, "marker"> & { marker?: number; start?: number; end?: number };

/** A number as written, without the separators between its groups of three: "£739,800" is "739800". */
const LATIN_NUMBER = /\d+(?:[.,\s]\d+)*/g;
const CHINESE_NUMBER = /[零〇一二两三四五六七八九十百千万亿]+/gu;
const NEGATION = /\b(?:not|no|never)\b|n't\b|[不没未无非]/giu;

/** The numbers in a text, sorted, so two texts' can be compared as a multiset. */
function numbersOf(text: string): string[] {
  const latin = [...text.matchAll(LATIN_NUMBER)].map((found) =>
    found[0].replace(/[,\s](?=\d{3}(?!\d))/g, ""),
  );
  const chinese = [...text.matchAll(CHINESE_NUMBER)].map((found) => found[0]);
  return [...latin, ...chinese].sort();
}

/**
 * Whether a near-duplicate says the same as a Passage's sentence: the same
 * numbers, and as many negations. Shared words alone don't tell "£739,800"
 * from "£793,800", or "is not" from "is".
 */
function saysTheSame(a: string, b: string): boolean {
  const ours = numbersOf(a);
  const theirs = numbersOf(b);
  return (
    ours.length === theirs.length &&
    ours.every((number, index) => number === theirs[index]) &&
    (a.match(NEGATION)?.length ?? 0) === (b.match(NEGATION)?.length ?? 0)
  );
}

/**
 * The Answer's sentences no Citation is on: those with no marker, or with
 * only markers the model wrote and gave no record for (`recorded`).
 */
function uncitedSentences(answer: string, recorded: (marker: number) => boolean) {
  return answerSentences(answer).filter((sentence) => !sentence.markers.some(recorded));
}

/** The sentences of a Passage's text, each as it is in the text. */
function passageSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => sentenceSpans(line).map((span) => line.slice(span.from, span.to).trim()))
    .filter((sentence) => sentence !== "");
}

/**
 * The quotations in `answer` that say enough to match, each with where it
 * starts: a quotation may run past a sentence's end ("“…drink.” So…").
 */
function quotationsIn(answer: string): { at: number; quote: string }[] {
  return [...answer.matchAll(QUOTATION)]
    .map((found) => ({ at: found.index, quote: (found[1] as string).trim() }))
    .filter(({ quote }) => wordsOf(quote).size >= MIN_QUOTED_WORDS);
}

/**
 * The sentence of a Passage that `sentence` is worded most closely like, if
 * close enough and saying the same (see `saysTheSame`).
 */
function closestSentence(
  sentence: string,
  passages: readonly { id: string; sentences: { text: string; words: Set<string> }[] }[],
): { passage: string; quote: string } | null {
  const words = wordsOf(sentence);
  if (words.size < MIN_SHARED_WORDS) return null;
  let best: { passage: string; quote: string; score: number } | null = null;
  for (const passage of passages) {
    for (const candidate of passage.sentences) {
      const alike = likeness(words, candidate.words);
      if (alike.shared < MIN_SHARED_WORDS || alike.score < MIN_SIMILARITY) continue;
      if (!saysTheSame(sentence, candidate.text)) continue;
      if (!best || alike.score > best.score) {
        best = { passage: passage.id, quote: candidate.text, score: alike.score };
      }
    }
  }
  return best && { passage: best.passage, quote: best.quote };
}

/**
 * The Citations to add to `answer`: for each sentence without a marker, the
 * first quotation starting in it that the check finds in a Passage, else the
 * Passage sentence it is worded closely like, if the check finds that; in
 * the Answer's order, at most `MAX_ADDED`.
 */
export function matchUnmarked(
  answer: string,
  passages: readonly ShownPassage[],
  found: (passage: string, quote: string) => boolean,
  recorded: (marker: number) => boolean = () => false,
): Found[] {
  const split = passages.map((passage) => ({
    id: passage.id,
    sentences: passageSentences(passage.text).map((text) => ({ text, words: wordsOf(text) })),
  }));
  const quotations = quotationsIn(answer);
  const matches: Found[] = [];
  /** Markers without records a sentence has taken: a later sentence holding one gets its own. */
  const taken = new Set<number>();
  for (const { start, end, text: sentence, markers } of uncitedSentences(answer, recorded)) {
    if (matches.length >= MAX_ADDED) break;
    const orphan = markers.find((marker) => !taken.has(marker));
    const own = { start, end, ...(orphan === undefined ? {} : { marker: orphan }) };
    const byQuotation = quotations
      .filter(({ at }) => at >= start && at < end)
      .flatMap(({ quote }) =>
        passages.flatMap((passage) =>
          found(passage.id, quote) ? [{ passage: passage.id, quote }] : [],
        ),
      )[0];
    const match = byQuotation ?? closestSentence(sentence, split);
    if (!match || (match !== byQuotation && !found(match.passage, match.quote))) continue;
    matches.push({ ...match, sentence, ...own });
    if (orphan !== undefined) taken.add(orphan);
  }
  return matches;
}

/** A marker before a sentence's first word ("” [^1] And so…") belongs to the sentence before. */
function ownMarkers(sentence: { text: string }): number[] {
  const first = [...sentence.text.matchAll(/\[\^\d{1,4}\]|[\p{L}\p{N}]/gu)].find(
    (found) => !found[0].startsWith("["),
  );
  return first
    ? [...sentence.text.slice(first.index).matchAll(MARKER)].map((found) => Number(found[1]))
    : [];
}

/** What a marker is written in: a sentence, or a row or cell of a table. */
function markedUnits(answer: string) {
  return [
    ...answerSentences(answer).map((sentence) => ({ ...sentence, markers: ownMarkers(sentence) })),
    ...answerTableUnits(answer),
  ];
}

/**
 * What the one request gave, each Citation taking a marker the model wrote
 * with no record in the sentence it names, unless that sentence is cited
 * already (`recorded`) or `matched` cites it.
 */
function takingMarkers(
  asked: readonly Omit<Match, "marker">[],
  answer: string,
  recorded: (marker: number) => boolean,
  matched: readonly Found[],
): Found[] {
  const units = markedUnits(answer).map((unit) => ({ ...unit, words: wordsOf(unit.text) }));
  const taken = new Set(
    matched.flatMap((match) => (match.marker === undefined ? [] : [match.marker])),
  );
  return asked.flatMap((match) => {
    const words = wordsOf(match.sentence);
    let own: (typeof units)[number] | undefined;
    let best = 0;
    for (const unit of units) {
      const { score } = likeness(words, unit.words);
      if (score >= MIN_SIMILARITY && score > best) {
        best = score;
        own = unit;
      }
    }
    if (own && (own.markers.some(recorded) || matched.some((each) => each.start === own?.start))) {
      return [];
    }
    const orphan = own?.markers.find((marker) => !taken.has(marker));
    if (!own || orphan === undefined) return [match];
    taken.add(orphan);
    return [{ ...match, marker: orphan, start: own.start, end: own.end }];
  });
}

const languageOf = (text: string) => detectLanguage(text.slice(0, LANGUAGE_SAMPLE));

function inAnotherLanguage(answer: string, passages: readonly ShownPassage[]): boolean {
  const ours = languageOf(answer);
  const theirs = languageOf(passages.map((passage) => passage.text).join("\n"));
  return ours !== null && theirs !== null && ours !== theirs;
}

/** Whether a sentence of `answer` shares as many words with a sentence of the Passages as a match needs. */
function sharesWords(answer: string, passages: readonly ShownPassage[]): boolean {
  const theirs = passages.flatMap((passage) => passageSentences(passage.text).map(wordsOf));
  return answerSentences(answer).some((sentence) => {
    const words = wordsOf(sentence.text);
    return theirs.some((each) => likeness(words, each).shared >= MIN_SHARED_WORDS);
  });
}

const DIGITS = /\d+(?:[.,]\d+)*/g;
const LATIN_TERM = /\p{Script=Latin}{4,}/gu;

const figuresAndTerms = (text: string): Set<string> =>
  new Set([
    ...[...text.matchAll(DIGITS)].map((found) => found[0].replace(/,(?=\d{3}(?!\d))/g, "")),
    ...[...text.matchAll(LATIN_TERM)].map((found) => found[0].toLowerCase()),
  ]);

function sharesFiguresOrTerms(answer: string, passages: readonly ShownPassage[]): boolean {
  const ours = figuresAndTerms(answer);
  if (ours.size === 0) return false;
  return passages.some((passage) =>
    [...figuresAndTerms(passage.text)].some((each) => ours.has(each)),
  );
}

/** Whether an uncited `answer` may draw on the Passages, so asking the model for its Citations is worth a request. */
export function mayDrawOn(answer: string, passages: readonly ShownPassage[]): boolean {
  return (
    (inAnotherLanguage(answer, passages) && sharesFiguresOrTerms(answer, passages)) ||
    sharesWords(answer, passages)
  );
}

/**
 * A marker without a record that a sentence took stays only there: in
 * another sentence it is that sentence's own Citation's marker, if it has
 * one, else it goes, as a marker with no record always did.
 */
export function settleOrphans(
  answer: string,
  records: readonly (Pick<Found, "start" | "end"> & { marker: number; took: boolean })[],
): string {
  const takers = new Map(
    records.filter((record) => record.took).map((record) => [record.marker, record]),
  );
  if (takers.size === 0) return answer;
  const within = (at: number) =>
    records.find(
      (record) =>
        record.start !== undefined &&
        record.end !== undefined &&
        at >= record.start &&
        at < record.end,
    );
  const renumbered = new Set<number>();
  const edits: { at: number; length: number; text: string }[] = [];
  // A footnote definition is dropped whole later; without its marker, its words would stay.
  const definitions = new Set(
    [...answer.matchAll(/^( {0,3})\[\^\d{1,4}\]:/gm)].map(
      (found) => found.index + (found[1] ?? "").length,
    ),
  );
  for (const found of answer.matchAll(MARKER)) {
    if (definitions.has(found.index)) continue;
    const marker = Number(found[1]);
    const taker = takers.get(marker);
    if (!taker || within(found.index) === taker) continue;
    const owner = within(found.index);
    // Its sentence's own Citation, once; any other occurrence there goes.
    const keep = owner && !owner.took && !renumbered.has(owner.marker);
    if (keep && owner) renumbered.add(owner.marker);
    edits.push({
      at: found.index,
      length: found[0].length,
      text: keep && owner ? `[^${owner.marker}]` : "",
    });
  }
  let text = answer;
  for (const edit of edits.reverse()) {
    text = text.slice(0, edit.at) + edit.text + text.slice(edit.at + edit.length);
  }
  return text;
}

/** The Citations in the reply to the one request, as given. */
export function parseAsked(value: unknown): Omit<Match, "marker">[] {
  const list = (value as { citations?: unknown } | undefined)?.citations;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { sentence, passage, quote } = item as Record<string, unknown>;
    return typeof sentence === "string" && typeof passage === "string" && typeof quote === "string"
      ? [{ sentence: sentence.trim(), passage: passage.trim(), quote: quote.trim() }]
      : [];
  });
}

const askedSchema = jsonSchema<{ citations: unknown }>({
  type: "object",
  properties: {
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sentence: { type: "string", description: "The Answer's sentence, as the Answer has it." },
          passage: { type: "string", description: "The Passage's id, e.g. P1." },
          quote: {
            type: "string",
            description:
              "A quote supporting the sentence, copied character for character from the Passage.",
          },
        },
        required: ["sentence", "passage", "quote"],
      },
    },
  },
  required: ["citations"],
});

/** The Passages the one request holds: within the window's room when there is one. */
function passagesToAsk(
  answer: string,
  passages: readonly ShownPassage[],
  budget: WindowBudget | null | undefined,
): ShownPassage[] {
  if (!budget) {
    return passages
      .slice(0, MAX_ASKED_PASSAGES)
      .map((passage) => ({ ...passage, text: passage.text.slice(0, MAX_ASKED_CHARACTERS) }));
  }
  let room = budget.roomBeside(
    [CITE_RETRY_INSTRUCTIONS, citeRetryPrompt(answer, [])],
    ASK_OUTPUT_TOKENS,
  );
  const asked: ShownPassage[] = [];
  for (const passage of passages) {
    const cost = budget.tokens(citeRetryPrompt("", [passage]));
    if (cost > room) break;
    asked.push(passage);
    room -= cost;
  }
  return asked;
}

/** The one request for an Answer's Citations; what it gives, or nothing if it fails. */
async function askForCitations(
  request: Pick<AnswerRequest, "model" | "signal">,
  answer: string,
  passages: readonly ShownPassage[],
  temperature: number | undefined,
): Promise<Omit<Match, "marker">[]> {
  const { signal } = request;
  let raw = "";
  try {
    const result = streamText({
      model: request.model,
      instructions: CITE_RETRY_INSTRUCTIONS,
      prompt: citeRetryPrompt(answer, passages),
      temperature,
      maxOutputTokens: ASK_OUTPUT_TOKENS,
      output: Output.object({ schema: askedSchema, name: "citations" }),
      // One request, never more.
      maxRetries: 0,
      abortSignal: signal,
      onError: () => undefined,
    });
    for await (const part of result.fullStream) {
      if (signal.aborted || part.type === "abort") return [];
      if (part.type === "text-delta") raw += part.text;
      else if (part.type === "error") throw part.error;
    }
  } catch (error) {
    if (signal.aborted) return [];
    console.error(
      `The Answer's Citations couldn't be asked for: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  return parseAsked(await replyJson(raw));
}

/**
 * Once an Answer (`answer`, its own records' markers placed) is written: adds
 * the Citations for what it quotes without markers, and when nothing matches
 * and it has no Citation, asks the model for them once. Yields the edits that
 * put the markers in, then "cited-after-checking" if it added any or asked;
 * nothing for an Answer that read no Passages. Returns the text.
 */
export async function* citeUnmarked(
  request: Pick<AnswerRequest, "model" | "documents" | "signal">,
  answer: string,
  temperature: number | undefined,
  budget?: WindowBudget | null,
  mayAsk: () => boolean = () => true,
): AsyncGenerator<AnswerEngineEvent, string> {
  const { documents, signal } = request;
  if (!documents.shownPassages || !documents.quoteFound || !documents.hasRecord) return answer;
  const passages = documents.shownPassages();
  if (passages.length === 0 || answer.trim() === "") return answer;
  const found = (passage: string, quote: string) => documents.quoteFound?.(passage, quote) ?? false;

  const recorded = (marker: number) => documents.hasRecord?.(marker) ?? false;
  let matches = matchUnmarked(answer, passages, found, recorded);
  let asked = false;
  const cited = [...answer.matchAll(MARKER)].some((each) => recorded(Number(each[1])));
  const matchedMarkers = new Set(matches.map((match) => match.marker));
  const unbacked = markedUnits(answer).some(
    ({ markers }) =>
      markers.length > 0 &&
      !markers.some((marker) => recorded(marker) || matchedMarkers.has(marker)),
  );
  if (unbacked || (matches.length === 0 && !cited && mayDrawOn(answer, passages))) {
    const toAsk = passagesToAsk(answer, passages, budget);
    if (toAsk.length > 0 && mayAsk()) {
      asked = true;
      yield { type: "phase", phase: "checking-quotes" };
      const given = await askForCitations(request, answer, toAsk, temperature);
      if (signal.aborted) return answer;
      const asking = given.filter((each) => found(each.passage, each.quote));
      matches = [...matches, ...takingMarkers(asking, answer, recorded, matches)].slice(
        0,
        MAX_ADDED,
      );
    }
  }
  if (matches.length === 0) {
    if (asked) yield { type: "cited-after-checking", count: 0, asked };
    return answer;
  }

  const used = [...answer.matchAll(MARKER)].map((each) => Number(each[1]));
  let next = Math.max(0, ...used) + 1;
  const records = matches.map((match) => {
    if (match.marker !== undefined) return { ...match, marker: match.marker, took: true };
    while (recorded(next)) next++;
    const record = { ...match, marker: next, took: false };
    next++;
    return record;
  });
  try {
    documents.cite(
      records.map(({ marker, passage, quote }) => ({ marker, passage, quote })),
      { structured: true },
    );
  } catch (error) {
    console.error(
      `The Answer's added Citations couldn't be recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
    return answer;
  }
  const { text } = withMissingMarkers(
    settleOrphans(answer, records),
    records,
    (marker) => documents.hasRecord?.(marker) ?? false,
  );
  yield* textEdits(answer, text);
  // The Citations the Answer shows: a record whose marker didn't go in is dropped.
  const shown = new Set([...text.matchAll(MARKER)].map((each) => Number(each[1])));
  const added = new Set(records.map((record) => record.marker));
  yield {
    type: "cited-after-checking",
    count: [...added].filter((marker) => shown.has(marker) && recorded(marker)).length,
    asked,
  };
  return text;
}
