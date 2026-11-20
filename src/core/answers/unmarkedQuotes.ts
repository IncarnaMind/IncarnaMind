/**
 * Citations an Answer's model left out (#760; ADR-0007). Once an Answer is written and its own
 * records placed, the model is asked once more for its Citations, in one request with the Answer
 * and the Passages it read (as ./quoteRetry asks for quotes), when a sentence is left with a marker
 * it gave no record for, or, with no marker, when the Answer has no Citation at all and one of its
 * sentences shares at least five words with one of the Passages'. What it gives is taken as
 * structured output's records are, a Citation taking the marker its sentence has, and only a quote
 * the check finds is kept. A sentence the model doesn't cite has no Citation: code never gives one
 * a Passage's Citation by itself (#3410).
 *
 * An Answer in another language than its Passages shares no words with them (#1415: Claude Haiku
 * 5.5's Chinese summary of English Documents stayed uncited where its English one was asked), so
 * it is asked when it shares what survives translation instead: a number in Latin digits of two or
 * more, or a name or term in Latin letters of four or more. Never more than once per Answer, so an
 * Answer saying the Documents don't cover the Question, a greeting or a question back doesn't pay
 * for it. In the Tool loop the ask is one of the end-of-turn checks' (see ./turnChecks): `mayAsk`.
 */
import { jsonSchema } from "ai";
import { answerSentences, MARKER } from "../../shared/answerSentences";
import { sentenceSpans } from "../../shared/sentences";
import { detectLanguage, LANGUAGE_SAMPLE } from "../documents/textLanguage";
import { itemsInRoom, outputTokens } from "../providers/outputLimits";
import type { AnswerEngineEvent, AnswerRequest, AnswerTools } from "./engine";
import type { AskedLine } from "./helpCitations";
import { fenceClosedBy, fenceOpened } from "./jsonFences";
import { fieldsOf, judge, list, structured } from "./judge";
import {
  answerTableUnits,
  likeness,
  type MarkerRecord,
  withMissingMarkers,
  withoutMarkers,
  wordsOf,
} from "./markerPlacement";
import {
  CITE_RETRY_INSTRUCTIONS,
  citeRetryParts,
  citeRetryPrompt,
  FILL_CITE_RETRY_INSTRUCTIONS,
  RETRY_TAGS,
} from "./prompt";
import { smallCallModel } from "./smallCalls";
import type { WindowBudget } from "./window";

/** Engine events that change the Answer's text from `from` to `to`: what follows their common start is replaced. */
export function* textEdits(from: string, to: string): Generator<AnswerEngineEvent> {
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  if (from.length > common) yield { type: "text-retracted", length: from.length - common };
  if (to.length > common) yield { type: "text-delta", text: to.slice(common) };
}

/**
 * Where the engine handles a finished Answer's records: the edits that put in
 * the markers the model left out of `text` for records the core took (see
 * `AnswerTools.hasRecord`), and how many it put in. Returns the text with them.
 */
export function* missingMarkerEvents(
  text: string,
  records: readonly MarkerRecord[],
  tools: Pick<AnswerTools, "hasRecord">,
): Generator<AnswerEngineEvent, string> {
  const { text: placed, placed: markers } = withMissingMarkers(
    text,
    records,
    (marker) => tools.hasRecord?.(marker) ?? false,
  );
  if (markers.length === 0) return text;
  yield* textEdits(text, placed);
  yield { type: "markers-placed", count: markers.length };
  return placed;
}

/**
 * The most Citations added to one Answer where its model wrote no marker. A marker it wrote with no
 * record is its own Citation still to place: a Meeting's notes hold dozens (#2306).
 */
export const MAX_ADDED = 12;

/** `matches` with at most `MAX_ADDED` where the Answer had no marker, in its order. */
function capped<T extends { marker?: number }>(matches: readonly T[]): T[] {
  let added = 0;
  return matches.filter((match) => match.marker !== undefined || ++added <= MAX_ADDED);
}

/** An Answer may draw on its Passages when one of its sentences shares this many words with one of theirs. */
const MIN_SHARED_WORDS = 5;
/** A Citation the model gives goes on the Answer's sentence its own is this much like (Dice similarity). */
const MIN_SIMILARITY = 0.6;
/** The most Passages, and of each one's text, the one request for Citations holds without a window. */
const MAX_ASKED_PASSAGES = 12;
const MAX_ASKED_CHARACTERS = 3000;

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
 * A Citation the one request gave, before its marker is given, with where its sentence is in the
 * Answer: the number of a marker the model wrote in the sentence with no record behind it, which
 * the Citation takes.
 */
type Found = Omit<Match, "marker"> & {
  marker?: number;
  start?: number;
  end?: number;
  /** A Citation its line shares with other list items, which this one replaces there (#2925). */
  replaces?: number;
};

/** The sentences of a Passage's text, each as it is in the text. */
function passageSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => sentenceSpans(line).map((span) => line.slice(span.from, span.to).trim()))
    .filter((sentence) => sentence !== "");
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
 * What the one request gave, each Citation taking a marker the model wrote with no record in the
 * sentence it names, unless that sentence is cited already (`recorded`).
 */
function takingMarkers(
  asked: readonly Omit<Match, "marker">[],
  answer: string,
  recorded: (marker: number) => boolean,
): Found[] {
  const units = markedUnits(answer).map((unit) => ({ ...unit, words: wordsOf(unit.text) }));
  /** Each marker taken, with the quote that took it. */
  const taken = new Map<number, string>();
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
    if (own?.markers.some(recorded)) return [];
    // A marker used in two sentences is given its quote twice: the second time it would take the
    // sentence's other marker, citing a line that marker never named (#3099).
    if (own?.markers.some((marker) => taken.get(marker) === match.quote)) return [];
    const orphan = own?.markers.find((marker) => !taken.has(marker));
    if (!own || orphan === undefined) return [match];
    taken.set(orphan, match.quote);
    return [{ ...match, marker: orphan, start: own.start, end: own.end }];
  });
}

/** A sentence without its markers, punctuation and spaces, to tell whether one holds another. */
const plainOf = (text: string) =>
  text
    .replace(MARKER, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .toLowerCase();

/**
 * What the one request gave, taken on the lines it was asked about (#2925) and nowhere else: each
 * Citation on the line its sentence is worded like, or is part of (a clause of a Chinese line).
 * A line's marker with no record is the one its first Citation takes; a Citation the line shares
 * with other list items is replaced, on that line alone, by the first it is given.
 */
function onLines(
  asked: readonly Omit<Match, "marker">[],
  lines: readonly AskedLine[],
  recorded: (marker: number) => boolean,
): Found[] {
  const units = lines.map((line) => ({
    line,
    words: wordsOf(line.text),
    plain: plainOf(line.text),
  }));
  const taken = new Set<number>();
  const replaced = new Set<number>();
  return asked.flatMap((match): Found[] => {
    const words = wordsOf(match.sentence);
    const plain = plainOf(match.sentence);
    let own: AskedLine | undefined;
    let best = 0;
    for (const unit of units) {
      const { score } = likeness(words, unit.words);
      const alike = plain !== "" && unit.plain.includes(plain) ? 1 : score;
      if (alike >= MIN_SIMILARITY && alike > best) {
        best = alike;
        own = unit.line;
      }
    }
    if (!own) return [];
    const placed = { ...match, sentence: own.text, start: own.start, end: own.end };
    const orphan = [...own.text.matchAll(MARKER)]
      .map((each) => Number(each[1]))
      .find((marker) => !recorded(marker) && !taken.has(marker));
    if (orphan !== undefined) {
      taken.add(orphan);
      return [{ ...placed, marker: orphan }];
    }
    if (own.replaces !== undefined && !replaced.has(own.start)) {
      replaced.add(own.start);
      return [{ ...placed, replaces: own.replaces }];
    }
    return [placed];
  });
}

/** A shared Citation replaced, on each line an answer was taken on for it, by that line's own. */
function replaceShared(text: string, records: readonly (Found & { marker: number })[]): string {
  let out = text;
  for (const record of records) {
    if (record.replaces === undefined) continue;
    const at = out.indexOf(record.sentence);
    if (at === -1) continue;
    const line = out
      .slice(at, at + record.sentence.length)
      .replace(`[^${record.replaces}]`, `[^${record.marker}]`);
    out = out.slice(0, at) + line + out.slice(at + record.sentence.length);
  }
  return out;
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

/** A figure of two or more digits: nearly every Passage has a one-digit one ("Table 2", "Section 3"), so sharing it says nothing. */
const figuresOf = (text: string): string[] =>
  [...withoutMarkers(text).matchAll(DIGITS)]
    .map((found) => found[0].replace(/,(?=\d{3}(?!\d))/g, ""))
    .filter((figure) => figure.length > 1);

const figuresAndTerms = (text: string): Set<string> =>
  new Set([
    ...figuresOf(text),
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

/** The one request's reply, in structured output: its list of Citations, each item whole. */
export const CITED_REPLY = structured(askedSchema, "citations", (value) =>
  fieldsOf(value, { citations: list }) ? parseAsked(value) : null,
);

/** How the one request is worded, and how many items its reply to `answer` may hold. */
interface Asking {
  instructions: string;
  items(answer: string): number;
}

const BY_SENTENCE: Asking = {
  instructions: CITE_RETRY_INSTRUCTIONS,
  items: (answer) => markedUnits(answer).length,
};

/** A fill's: an item for each marker, so a sentence with two markers has room for both (#3145). */
const BY_MARKER: Asking = {
  instructions: FILL_CITE_RETRY_INSTRUCTIONS,
  items: (answer) => Math.max(BY_SENTENCE.items(answer), [...answer.matchAll(MARKER)].length),
};

/** The Passages the one request holds: within the window's room when there is one. */
function passagesToAsk(
  answer: string,
  passages: readonly ShownPassage[],
  budget: WindowBudget | null | undefined,
  asking = BY_SENTENCE,
): ShownPassage[] {
  if (!budget) {
    return passages
      .slice(0, MAX_ASKED_PASSAGES)
      .map((passage) => ({ ...passage, text: passage.text.slice(0, MAX_ASKED_CHARACTERS) }));
  }
  let room = budget.roomBeside(
    [asking.instructions, citeRetryPrompt(answer, [])],
    outputTokens("unmarked-quotes", asking.items(answer)),
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

/**
 * The one request for an Answer's Citations; what it gives, or nothing if it fails. It goes to the
 * small calls' model, which doesn't think first: the Answer's thinking could fill its whole limit
 * before a Citation was written (#2306).
 */
async function askForCitations(
  request: Pick<AnswerRequest, "model" | "quickModel" | "signal">,
  answer: string,
  passages: readonly ShownPassage[],
  temperature: number | undefined,
  asking = BY_SENTENCE,
): Promise<Omit<Match, "marker">[]> {
  const { signal } = request;
  let small: Awaited<ReturnType<typeof smallCallModel>>;
  try {
    small = await smallCallModel(request, temperature);
  } catch (error) {
    if (!signal.aborted) {
      console.error(
        `The Answer's Citations couldn't be asked for: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return [];
  }
  const judged = await judge({
    model: small.model,
    question: { id: "unmarked-quotes", instructions: asking.instructions },
    parts: citeRetryParts(answer, passages),
    data: RETRY_TAGS,
    reply: CITED_REPLY,
    items: asking.items(answer),
    // One request, never more.
    retries: 0,
    signal,
    temperature: small.temperature,
    stream: true,
  });
  if (!judged.ok && judged.error)
    console.error(`The Answer's Citations couldn't be asked for: ${judged.error.message}`);
  return judged.ok ? judged.value : [];
}

/**
 * The lines of a reply that hold a Citation marker: its sentences, not its code, headings or
 * footnotes. A marker written after its sentence's full stop, or after the quotation mark that
 * closes it, is put before the stop: read as written, "Agreed. [^4]" gives [^4] to the sentence
 * that follows. The space after the marker stays, or the next sentence would join this one and
 * the two share a record (#3145).
 */
function markedLines(reply: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of reply.split("\n")) {
    if (fence !== null) {
      if (fenceClosedBy(fence, line)) fence = null;
      continue;
    }
    fence = fenceOpened(line);
    if (fence === null && !/^ {0,3}(?:#|\[\^\d{1,4}\]:)/.test(line) && /\[\^\d{1,4}\]/.test(line))
      lines.push(
        line
          .trim()
          .replace(
            /([.!?。！？]+["'”’」』]*)((?:[ \t]*\[\^\d{1,4}\])+)/gu,
            (_, stop: string, markers: string) => ` ${markers.trim()}${stop}`,
          ),
      );
  }
  return lines.join("\n\n");
}

/** Markers written side by side, as in "[^3][^4]": they stand after the same words. */
const MARKER_RUN = /(?:\[\^\d{1,4}\][ \t]*){2,}/g;

/**
 * What the one request gave for a fill's reply (`marked`, its lines), each Citation taking a
 * marker with no record. The model copies a sentence with its markers, so the copy says which
 * marker the quote is for; the sentence's likeness to the reply's sentences can't, once a
 * quotation or an abbreviation splits one (#3145). A copy takes a marker only on a line that holds
 * it, and never with the quote another marker of that copy took: a marker used in two sentences
 * is given its quote twice (#3099). A Citation whose copy holds no marker of such a line is placed
 * by likeness, as an Answer's is. Of markers written side by side, one left without a Citation
 * takes its neighbour's.
 */
function takingCopiedMarkers(
  asked: readonly Omit<Match, "marker">[],
  marked: string,
  recorded: (marker: number) => boolean,
): { marker: number; passage: string; quote: string }[] {
  const markersIn = (text: string) => [...text.matchAll(MARKER)].map((found) => Number(found[1]));
  const lines = marked
    .split("\n")
    .map((line) => ({ plain: plainOf(line), markers: markersIn(line) }))
    .filter((line) => line.markers.length > 0);
  const taken = new Map<number, { passage: string; quote: string }>();
  const open = (marker: number) => !recorded(marker) && !taken.has(marker);
  const unplaced: Omit<Match, "marker">[] = [];
  for (const each of asked) {
    const copied = plainOf(each.sentence);
    if (copied === "") continue;
    const held = markersIn(each.sentence).filter((marker) =>
      lines.some((line) => line.markers.includes(marker) && line.plain.includes(copied)),
    );
    if (held.length === 0) {
      unplaced.push(each);
      continue;
    }
    if (held.some((marker) => taken.get(marker)?.quote === each.quote)) continue;
    const marker = held.find(open);
    if (marker !== undefined) taken.set(marker, each);
  }
  for (const each of takingMarkers(unplaced, marked, (marker) => !open(marker))) {
    if (each.marker !== undefined) taken.set(each.marker, each);
  }
  for (const run of marked.matchAll(MARKER_RUN)) {
    const together = markersIn(run[0]);
    const given = together.map((marker) => taken.get(marker)).find((each) => each !== undefined);
    if (!given) continue;
    for (const marker of together.filter(open)) taken.set(marker, given);
  }
  return [...taken].map(([marker, { passage, quote }]) => ({ marker, passage, quote }));
}

/**
 * A reply's marked lines (`marked`), in runs that each ask for no more records than one request
 * has room to write. One request for a reply of 76 markers was cut off at its limit, nothing of it
 * was read, and the fill failed with every fact left out (#3227).
 */
function linesByRoom(marked: string): string[] {
  const room = itemsInRoom("unmarked-quotes");
  const runs: string[][] = [];
  let held = 0;
  for (const line of marked.split("\n\n")) {
    const items = BY_MARKER.items(line);
    if (runs.length === 0 || (held > 0 && held + items > room)) {
      runs.push([]);
      held = 0;
    }
    runs.at(-1)?.push(line);
    held += items;
  }
  return runs.map((lines) => lines.join("\n\n"));
}

/**
 * A Meeting fill's reply that wrote its Citation markers and called no `cite` (#3099): their
 * records, asked for in the request for an Answer's Citations, an item for each marker (#3145), of
 * the model that wrote the reply, in as many requests as the records need room. A record takes
 * only a marker with none, and only a quote the check finds is kept.
 */
export async function recordMarkedSentences(
  request: Pick<AnswerRequest, "model" | "ownQuickModel" | "documents" | "signal">,
  reply: string,
  temperature: number | undefined,
  budget?: WindowBudget | null,
): Promise<void> {
  const { documents, signal, ownQuickModel } = request;
  if (!documents.shownPassages || !documents.quoteFound || !documents.hasRecord) return;
  const passages = documents.shownPassages();
  const sentences = markedLines(reply);
  if (passages.length === 0 || sentences === "") return;
  const given = (
    await Promise.all(
      linesByRoom(sentences).map((lines) => {
        // The fill read every Passage of its part whole: only a window limits what a request shows.
        const toAsk = budget ? passagesToAsk(lines, passages, budget, BY_MARKER) : passages;
        if (toAsk.length === 0) return [];
        return askForCitations(
          { model: request.model, signal, ...(ownQuickModel && { quickModel: ownQuickModel }) },
          lines,
          toAsk,
          temperature,
          BY_MARKER,
        );
      }),
    )
  ).flat();
  if (signal.aborted) return;
  const found = given.filter((each) => documents.quoteFound?.(each.passage, each.quote) ?? false);
  const recorded = (marker: number) => documents.hasRecord?.(marker) ?? false;
  const records = takingCopiedMarkers(found, sentences, recorded);
  if (records.length === 0) return;
  try {
    documents.cite(records, { structured: true });
  } catch (error) {
    console.error(
      `The fill's asked Citations couldn't be recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Once an Answer (`answer`, its own records' markers placed) is written: asks the model once for
 * the Citations it left out, when a marker has no record or the Answer has none and may draw on
 * its Passages. Yields the edits that put the markers in, then "cited-after-checking" if it asked;
 * nothing for an Answer that read no Passages. Returns the text.
 */
export async function* citeUnmarked(
  request: Pick<AnswerRequest, "model" | "quickModel" | "documents" | "signal" | "askedLines">,
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
  let matches: Found[] = [];
  let asked = false;
  const lines = request.askedLines?.(answer, passages, recorded);
  if (lines) {
    const asking = lines.map((line) => line.text).join("\n");
    const toAsk = lines.length > 0 ? passagesToAsk(asking, passages, budget) : [];
    if (toAsk.length > 0 && mayAsk()) {
      asked = true;
      yield { type: "phase", phase: "checking-quotes" };
      const given = await askForCitations(request, asking, toAsk, temperature);
      if (signal.aborted) return answer;
      const taken = given.filter((each) => found(each.passage, each.quote));
      matches = capped(onLines(taken, lines, recorded));
    }
  } else {
    const cited = [...answer.matchAll(MARKER)].some((each) => recorded(Number(each[1])));
    const unbacked = markedUnits(answer).some(
      ({ markers }) => markers.length > 0 && !markers.some(recorded),
    );
    if (unbacked || (!cited && mayDrawOn(answer, passages))) {
      const toAsk = passagesToAsk(answer, passages, budget);
      if (toAsk.length > 0 && mayAsk()) {
        asked = true;
        yield { type: "phase", phase: "checking-quotes" };
        const given = await askForCitations(request, answer, toAsk, temperature);
        if (signal.aborted) return answer;
        const asking = given.filter((each) => found(each.passage, each.quote));
        matches = capped(takingMarkers(asking, answer, recorded));
      }
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
    replaceShared(settleOrphans(answer, records), records),
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
