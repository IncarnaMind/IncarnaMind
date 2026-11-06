/**
 * One ask about an Answer's nested quotation marks (#2504; its gate is
 * eval/nestedMarks/README.md). Matching never changes: a quote is found only
 * with its own marks. An Answer that quotes a sentence holding the page's
 * “soft weights” writes them ‘soft weights’, as typography asks, and the
 * check reads that as not found. So once the Answer is written, before its
 * Citations are checked, each quotation the check wouldn't find is read a
 * second time, here only, with every quotation mark of either kind read as one
 * mark. Where that reading finds it on its Citation's pages at one place, with
 * as many marks there as the quotation has, the Answer's own model is asked
 * once, in one request for all of them, with each quotation's sentence: the
 * same words in the Document's marks, or "none" where the marks carry a
 * meaning in that sentence.
 *
 * A reply is taken only when it is the quotation's own words with each of its
 * marks, at the same place in it, changed to the Document's mark there, of one
 * kind, “ ” or ‘ ’, and the check finds it exactly at the place the second
 * reading found. It is applied only to the Answer as it was asked about: the
 * same text, the same Citation of the same Document version, still in the
 * Answer's place. The quotation is then replaced, the Answer unchanged
 * outside it; its own marks become the other kind where the reply's are
 * theirs, and its Citation's card says its marks were changed. That the
 * sentence still means what it meant is the model's call, and the gate
 * measures it. In every other case the quotation stays as it was, not found.
 *
 * - **When:** only on a model listed for it, in a question's Answer
 *   (../providers/catalog/answerPaths), and only when a quotation's second
 *   reading finds it.
 * - **Cost:** one request of at most `MAX_ASKED` quotations, given up after
 *   `ASK_DEADLINE_MS`; Stop withdraws it.
 */
import { jsonSchema, type LanguageModel, Output, streamText } from "ai";
import { joinUnits, numbersIn } from "../../shared/locations";
import { findQuote, type MatchOptions, type TextRange } from "../../shared/quoteMatch";
import type { ExactMarksAsk } from "../api";
import type { PageText } from "../documents/passages";
import { outputTokens } from "../providers/outputLimits";
import { tokenUsageOf } from "../providers/promptCache";
import type { TokenUsage } from "../runs/engine";
import { replyJson } from "./quoteRetry";

/** The most quotations one request asks about: the first ones, in the Answer's order. */
export const MAX_ASKED = 6;
/** How long the Answer waits for the reply before it ends as if none had been asked. */
export const ASK_DEADLINE_MS = 10_000;

/** The quotation marks the second reading reads as one, and a reply's marks are counted from. */
const MARKS = new Set("“”‘’「」『』«»„‹›");
/** The marks a reply may hold: one kind of them. */
const DOUBLE = new Set("“”");
const SINGLE = new Set("‘’");
/** What every mark of `MARKS` reads as in the second reading: a character no text holds. */
const ONE_MARK = "﷐";
const WORDISH = /[\p{L}\p{N}]/u;
/** Scripts with no apostrophe: a mark between two of their characters is a quotation mark. */
const NO_APOSTROPHE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** What may follow the words inside an Answer's quotation: the stop typography puts there. */
const TAIL = /^[\s,.;:!?，。；：！？、]*$/u;

export const EXACT_MARKS_INSTRUCTIONS = [
  "An Answer quoted a Document. In each quotation below the words are the Document's, but the quotation marks inside it are not: the Answer wrote them in the other kind.",
  'For each quotation, read the sentence it is in. When that sentence means the same with the Document\'s marks, give your words again exactly as you wrote them, with only those marks changed to the Document\'s, as {"id": <id>, "quote": "<your words>"}.',
  'Give {"id": <id>, "quote": null} when the marks you wrote carry a meaning in your sentence that the Document\'s don\'t: marks the sentence asks to be typed or kept, a text value where the Document names a field, someone else\'s words, a title.',
  'Reply with JSON only: {"quotes": [...]}.',
].join("\n");

const wordish = (char: string | undefined) =>
  char !== undefined && WORDISH.test(char) && !NO_APOSTROPHE.test(char);

/** A quotation mark between two letters or digits is an apostrophe ("it’s"), and stays a letter. */
const inWord = (text: string, at: number) => wordish(text[at - 1]) && wordish(text[at + 1]);

const isMark = (text: string, at: number) => MARKS.has(text[at] as string) && !inWord(text, at);

/** `text` with every quotation mark of `MARKS`, outside a word, read as one mark: of the same length. */
export function asOneMark(text: string): string {
  let read = "";
  for (let at = 0; at < text.length; at++) read += isMark(text, at) ? ONE_MARK : text[at];
  return read;
}

/** The quotation marks of `MARKS` in `text`, outside words, in order. */
function marksOf(text: string): string[] {
  const marks: string[] = [];
  for (let at = 0; at < text.length; at++) if (isMark(text, at)) marks.push(text[at] as string);
  return marks;
}

/** `words` with each of its marks changed, in order, to the page's; null when they have more or fewer. */
function withMarksOf(words: string, page: string): string | null {
  const marks = marksOf(page);
  if (marks.length !== marksOf(words).length) return null;
  let next = 0;
  let changed = "";
  for (let at = 0; at < words.length; at++) {
    changed += isMark(words, at) ? (marks[next++] as string) : words[at];
  }
  return changed;
}

/** The one kind of `text`'s marks, “ ” or ‘ ’, or none; null for marks of both or another kind. */
function kindOf(text: string): "double" | "single" | "none" | null {
  const marks = marksOf(text);
  if (marks.length === 0) return "none";
  if (marks.every((mark) => DOUBLE.has(mark))) return "double";
  if (marks.every((mark) => SINGLE.has(mark))) return "single";
  return null;
}

/** Every place `words` are found in `text`, in order. */
function placesOf(text: string, words: string, options: MatchOptions): TextRange[] {
  const places: TextRange[] = [];
  let from = 0;
  while (from < text.length) {
    const found = findQuote(text.slice(from), words, options);
    if (found?.length !== 1) break;
    const [range] = found as [TextRange];
    places.push({ start: from + range.start, end: from + range.end });
    from += range.start + 1;
  }
  return places;
}

const gap = (a: TextRange, b: TextRange) =>
  a.end <= b.start ? b.start - a.end : b.end <= a.start ? a.start - b.end : 0;

/** The place nearest the record's own quote; null when two are as near. */
function nearest(places: readonly TextRange[], quoteAt: readonly TextRange[] | null) {
  if (places.length === 0) return null;
  if (places.length === 1) return places[0] as TextRange;
  if (!quoteAt || quoteAt.length === 0) return null;
  const distance = (place: TextRange) => Math.min(...quoteAt.map((part) => gap(place, part)));
  const sorted = [...places].sort((a, b) => distance(a) - distance(b));
  const [first, second] = sorted as [TextRange, TextRange];
  return distance(first) === distance(second) ? null : first;
}

/** A Citation of the quotation's sentence whose own quote is found, as the session gives it. */
export interface CitedPages {
  marker: number;
  units: PageText[];
  matching: Pick<MatchOptions, "lostLigatures">;
  quoteAt: TextRange[] | null;
  /** Its Document, version and quote: a reply applies only while they are the same. */
  version: string;
}

/** An Answer's quotation, as `quotationsIn` gives it. */
export interface Quotation {
  words: string;
  markers: number[];
  quotation: string;
  sentence: string;
}

interface Asked {
  id: number;
  words: string;
  quotation: string;
  sentence: string;
  /** Where the quotation is in the Answer's text as asked about. */
  at: TextRange;
  cited: CitedPages;
  place: TextRange;
  pageText: string;
  /** The only reply that can be taken: the words with the page's marks. */
  expected: string;
}

/** What the ask needs from the Answer. */
export interface ExactMarksRequest {
  model: LanguageModel;
  /** The Answer's text, as written: its quotations are replaced in it. */
  markdown: string;
  quotations: readonly Quotation[];
  /** The session's view of quoted words it wouldn't find (`unfoundQuotedWords`). */
  unfound(words: string, markers: readonly number[]): CitedPages[] | null;
  /** The Answer's text now: a reply applies only to the text it was asked about. */
  current(): string;
  /** A marker's Citation now, as `CitedPages.version`; null when it has none. */
  version(marker: number): string | null;
  /** Whether the Answer's place still holds the quotation as written: the User may have typed into it. */
  holds(quotation: string): boolean;
  /** Records that a marker's quotation now has the Document's marks. */
  changed(marker: number): void;
  signal: AbortSignal;
  /** How long to wait for the reply; `ASK_DEADLINE_MS` unless a test says. */
  deadlineMs?: number;
}

/** What `exactMarks` gives back: the text, spliced or as it was, the report, and the request's tokens. */
export interface ExactMarksResult {
  markdown: string;
  ask: ExactMarksAsk;
  /** The request's tokens, as its provider counted them; null when it reported none. */
  usage: TokenUsage | null;
}

const repliesSchema = jsonSchema<{ quotes: unknown }>({
  type: "object",
  properties: {
    quotes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          quote: {
            type: ["string", "null"],
            description: "Your words, with the Document's quotation marks; null to keep yours.",
          },
        },
        required: ["id", "quote"],
      },
    },
  },
  required: ["quotes"],
});

/** The reply's quotes by id: a string, or null for "none"; an id given twice is "twice". */
export function parseReplies(value: unknown): Map<number, string | null | "twice"> {
  const replies = new Map<number, string | null | "twice">();
  const quotes = (value as { quotes?: unknown } | null)?.quotes;
  if (!Array.isArray(quotes)) return replies;
  for (const each of quotes) {
    const { id, quote } = (each ?? {}) as { id?: unknown; quote?: unknown };
    if (typeof id !== "number") continue;
    if (replies.has(id)) replies.set(id, "twice");
    else if (quote === null || typeof quote === "string") replies.set(id, quote);
  }
  return replies;
}

function prompt(asked: readonly Asked[]): string {
  return asked
    .map((each) =>
      [
        `<quotation id="${each.id}">`,
        `Your sentence: ${each.sentence}`,
        `Your words: ${each.words}`,
        `The Document's text there: ${each.pageText}`,
        "</quotation>",
      ].join("\n"),
    )
    .join("\n\n");
}

/** The quotation's parts: its marks, the words and what typography put after them; null if it holds more. */
function partsOf(quotation: string, words: string) {
  const inside = quotation.slice(1, -1);
  const tail = inside.slice(words.length);
  if (!inside.startsWith(words) || !TAIL.test(tail)) return null;
  return { open: quotation[0] as string, close: quotation.at(-1) as string, tail };
}

/** The quotation with `reply` for its words, its own marks the other kind where the reply's are theirs. */
function spliced(quotation: string, words: string, reply: string): string {
  const parts = partsOf(quotation, words) as NonNullable<ReturnType<typeof partsOf>>;
  const kind = kindOf(reply);
  let { open, close } = parts;
  if (kind === "double" && DOUBLE.has(open)) [open, close] = ["‘", "’"];
  else if (kind === "single" && SINGLE.has(open)) [open, close] = ["“", "”"];
  return `${open}${reply}${parts.tail}${close}`;
}

/** Where `part` is in `text`, once only; null when it isn't, or is more than once. */
function onlyPlace(text: string, part: string): TextRange | null {
  const start = text.indexOf(part);
  if (start < 0 || text.indexOf(part, start + 1) >= 0) return null;
  return { start, end: start + part.length };
}

/** Whether the check finds `reply` exactly at the place on the Citation's pages that the second reading found. */
function foundThere(asked: Asked, reply: string): boolean {
  const { units, matching } = asked.cited;
  return findQuote(asked.pageText, reply, { ...matching, numbers: numbersIn(units) }) !== null;
}

/** Resolves once `signal` aborts: a stream that stalls doesn't keep the Answer past it. */
const abortion = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

/**
 * Asks once about the quotations whose marks alone keep them from being found, and splices the
 * replies taken. Null when no quotation's second reading finds it: no request is made.
 */
export async function exactMarks(request: ExactMarksRequest): Promise<ExactMarksResult | null> {
  const ask: ExactMarksAsk = {
    unfound: 0,
    secondReadings: 0,
    asked: 0,
    accepted: 0,
    declined: 0,
    failed: 0,
    rejected: 0,
    otherMarks: 0,
    invalidated: 0,
    durationMs: 0,
  };
  const { markdown } = request;
  const candidates: Omit<Asked, "id">[] = [];
  for (const { words, markers, quotation, sentence } of request.quotations) {
    const cited = request.unfound(words, markers);
    if (!cited) continue;
    ask.unfound++;
    const at = onlyPlace(markdown, quotation);
    const within = onlyPlace(markdown, sentence);
    if (/…|\.\.\./u.test(words) || !partsOf(quotation, words) || !at || !within) continue;
    if (at.start < within.start || at.end > within.end) continue;
    const found = cited.flatMap((pages) => {
      const read = pages.units.map((unit) => ({ ...unit, text: asOneMark(unit.text) }));
      const options = { ...pages.matching, numbers: numbersIn(pages.units) };
      const place = nearest(
        placesOf(joinUnits(read).text, asOneMark(words), options),
        pages.quoteAt,
      );
      return place ? [{ pages, place }] : [];
    });
    if (found.length !== 1) continue;
    const [{ pages, place }] = found as [(typeof found)[number]];
    const pageText = joinUnits(pages.units).text.slice(place.start, place.end);
    const expected = withMarksOf(words, pageText);
    if (expected === null) continue;
    ask.secondReadings++;
    if (kindOf(expected) === null) {
      ask.otherMarks++;
      continue;
    }
    candidates.push({ words, quotation, sentence, at, cited: pages, place, pageText, expected });
  }
  if (candidates.length === 0)
    return ask.secondReadings > 0 ? { markdown, ask, usage: null } : null;
  const asked = candidates.slice(0, MAX_ASKED).map((each, index) => ({ ...each, id: index + 1 }));
  ask.asked = asked.length;

  const started = Date.now();
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(request.deadlineMs ?? ASK_DEADLINE_MS),
  ]);
  let raw = "";
  let usage: TokenUsage | null = null;
  try {
    const result = streamText({
      model: request.model,
      instructions: EXACT_MARKS_INSTRUCTIONS,
      prompt: prompt(asked),
      maxOutputTokens: outputTokens("exact-marks", asked.length),
      output: Output.object({ schema: repliesSchema, name: "quotes" }),
      // One request, never more: a failure leaves the quotations as they are.
      maxRetries: 0,
      abortSignal: signal,
      onError: () => undefined,
    });
    const read = async () => {
      for await (const part of result.fullStream) {
        if (signal.aborted || part.type === "abort") return;
        if (part.type === "text-delta") raw += part.text;
        else if (part.type === "error") throw part.error;
        else if (part.type === "finish-step") usage = tokenUsageOf(part.usage);
      }
    };
    await Promise.race([read(), abortion(signal)]);
  } catch (error) {
    if (!request.signal.aborted) {
      console.error(
        `The Answer's quotation marks couldn't be asked about: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // What came before the failure may be cut off (#2275): none of it is read.
    raw = "";
  }
  ask.durationMs = Date.now() - started;
  // A stopped Answer changes nothing; one past the deadline goes on as if none had been asked.
  if (request.signal.aborted) return null;
  const replies = signal.aborted ? new Map() : parseReplies(await replyJson(raw));

  // A reply applies only to the Answer it was asked about: any edit since makes every one stale.
  const unchanged = request.current() === markdown;
  let next = markdown;
  // From the last quotation to the first, so each earlier one stays where it was asked about.
  for (const each of [...asked].sort((a, b) => b.at.start - a.at.start)) {
    if (!replies.has(each.id)) {
      ask.failed++;
      continue;
    }
    const reply = replies.get(each.id);
    if (reply === null || reply === each.words) {
      ask.declined++;
      continue;
    }
    if (reply !== each.expected || !foundThere(each, reply)) {
      ask.rejected++;
      continue;
    }
    if (
      !unchanged ||
      request.version(each.cited.marker) !== each.cited.version ||
      !request.holds(each.quotation)
    ) {
      ask.invalidated++;
      continue;
    }
    next = `${next.slice(0, each.at.start)}${spliced(each.quotation, each.words, reply)}${next.slice(each.at.end)}`;
    request.changed(each.cited.marker);
    ask.accepted++;
  }
  return { markdown: next, ask, usage };
}
