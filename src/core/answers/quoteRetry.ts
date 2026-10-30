/**
 * Structured output's one second chance at quotes (ADR-0007). In the Tool
 * loop, `cite` tells the model which quotes aren't word for word on the pages
 * they cite, and it may fix them. Structured output's one request gets no
 * such word, and small local models reword or stitch quotes (#67). So once a
 * local model's Answer is written and its records placed, the quotes the
 * check doesn't find are asked for once more, in one short request for all of
 * them: each record's marker, the Answer's sentence it is on, its quote, and
 * its Passage's text (the part nearest the quote when the Passage is long),
 * with a request to copy an exact quote from that text, or none.
 *
 * A new quote replaces a record's only when the check finds it on the pages
 * it then cites (see `AnswerTools.correctQuote`); otherwise the record stays
 * as it was, "not found". So the request can't make a Citation worse.
 *
 * - **When:** only in structured output, only for a local model (the engine
 *   passes a window budget), at most once per Answer, and only when some
 *   quote isn't found: an Answer whose quotes are all found makes no request.
 * - **Cost:** one request, of at most `MAX_RETRIED_RECORDS` records, each
 *   with at most `EXCERPT_TOKENS` of its Passage, and an output cap per
 *   record (../providers/outputLimits). The Answer's phase shows it
 *   ("checking-quotes"), and its end reports it (`AnswerFinished.quoteRetry`),
 *   so the evaluation counts the requests, what they recovered and their time.
 */
import { jsonSchema, Output, parsePartialJson, streamText } from "ai";
import { outputTokens } from "../providers/outputLimits";
import type { AnswerEngineEvent, AnswerRequest, UnfoundQuote } from "./engine";
import { markedSentence, wordsOf } from "./markerPlacement";
import { QUOTE_RETRY_INSTRUCTIONS, type QuoteToRetry, quoteRetryPrompt } from "./prompt";
import type { WindowBudget } from "./window";

/** The most records one request asks about: the first ones, by marker. */
export const MAX_RETRIED_RECORDS = 6;
/** The most of a Passage's text a record gets, in the window's estimated tokens. */
export const EXCERPT_TOKENS = 400;
/** Less than this of a Passage isn't worth asking with: no request is made. */
const MIN_EXCERPT_TOKENS = 96;

/** Where a Passage's text may be cut: after a line, or a sentence's end. */
const PIECE_BREAK = /(?<=\n)|(?<=[。！？；])|(?<=[.!?;])(?=\s)/u;

/** How many of `words` a text shares. */
const sharedWith = (words: ReadonlySet<string>, text: string) => {
  let shared = 0;
  for (const word of wordsOf(text)) if (words.has(word)) shared++;
  return shared;
};

/**
 * The part of a Passage's text nearest a quote, within `maxTokens` (as
 * `tokens` counts them): the whole text when it fits; else the line or
 * sentence that shares the most words with the quote (or, failing that, with
 * the sentence it is on), grown line by line or sentence by sentence on the
 * side that shares more, while it fits. A quote stitched from neighbouring
 * sentences finds its parts nearby.
 */
export function nearestExcerpt(
  text: string,
  quote: string,
  sentence: string,
  maxTokens: number,
  tokens: (text: string) => number,
): string {
  if (tokens(text) <= maxTokens) return text;
  const pieces = text.split(PIECE_BREAK).filter((piece) => piece !== "");
  const quoteWords = wordsOf(quote);
  const sentenceWords = wordsOf(sentence);
  const score = (piece: string) =>
    sharedWith(quoteWords, piece) * 1_000 + sharedWith(sentenceWords, piece);
  const scores = pieces.map(score);
  let best = 0;
  scores.forEach((each, index) => {
    if (each > (scores[best] as number)) best = index;
  });
  const first = pieces[best] as string;
  let used = tokens(first);
  if (used > maxTokens) {
    // One long line: its start, as much as fits.
    return first.slice(0, Math.max(1, Math.floor((first.length * maxTokens) / used))).trim();
  }
  let from = best;
  let to = best + 1;
  for (;;) {
    const before = from > 0 ? (pieces[from - 1] as string) : null;
    const after = to < pieces.length ? (pieces[to] as string) : null;
    const fits = (piece: string | null) => piece !== null && used + tokens(piece) <= maxTokens;
    const takeBefore =
      fits(before) && (!fits(after) || (scores[from - 1] as number) > (scores[to] as number));
    if (takeBefore) {
      used += tokens(before as string);
      from--;
    } else if (fits(after)) {
      used += tokens(after as string);
      to++;
    } else {
      break;
    }
  }
  return pieces.slice(from, to).join("").trim();
}

/** The new quotes in the model's reply, by marker: only those given as text. */
export function parseCorrections(value: unknown): Map<number, string> {
  const quotes = new Map<number, string>();
  const list = (value as { quotes?: unknown } | undefined)?.quotes;
  if (!Array.isArray(list)) return quotes;
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { marker, quote } = item as Record<string, unknown>;
    const number =
      typeof marker === "string" ? Number(/\d{1,4}/.exec(marker)?.[0] ?? Number.NaN) : marker;
    if (typeof number === "number" && Number.isInteger(number) && typeof quote === "string") {
      quotes.set(number, quote.trim());
    }
  }
  return quotes;
}

const correctionsSchema = jsonSchema<{ quotes: unknown }>({
  type: "object",
  properties: {
    quotes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          marker: { type: "integer", description: "The marker's number: 1 for [^1]." },
          quote: {
            type: "string",
            description:
              "The quote, copied character for character from the Passage's text; empty if nothing there supports the sentence.",
          },
        },
        required: ["marker", "quote"],
      },
    },
  },
  required: ["quotes"],
});

/** The reply's JSON, even inside a Markdown code fence or after thinking; undefined if there is none. */
export async function replyJson(raw: string): Promise<unknown> {
  const json = raw
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/^\s*```(?:json)?[ \t]*\n?/i, "")
    .replace(/\n?```\s*$/, "");
  return (await parsePartialJson(json)).value;
}

/** The records to ask about, with their sentences in `answer`: those whose marker is in it. */
function recordsToRetry(unfound: readonly UnfoundQuote[], answer: string) {
  return unfound
    .flatMap((record) => {
      const sentence = markedSentence(answer, record.marker);
      return sentence ? [{ ...record, sentence }] : [];
    })
    .slice(0, MAX_RETRIED_RECORDS);
}

/**
 * Once a local model's Answer in structured output is written (`answer`, its
 * markers placed): asks for the quotes the check doesn't find, once, and
 * takes those it then finds. Yields the "checking-quotes" phase before the
 * request and "quotes-retried" after it; nothing when every quote is found,
 * or the request couldn't fit the window. A failed request changes nothing.
 */
export async function* retryQuotes(
  request: Pick<AnswerRequest, "model" | "documents" | "signal">,
  answer: string,
  temperature: number | undefined,
  budget: WindowBudget,
): AsyncGenerator<AnswerEngineEvent> {
  const { documents, signal } = request;
  if (!documents.unfoundQuotes || !documents.correctQuote) return;
  const records = recordsToRetry(documents.unfoundQuotes(), answer);
  if (records.length === 0) return;
  const maxOutputTokens = outputTokens("quote-retry", records.length);
  // What the request holds besides the Passages' text, and the room left for it.
  const framing = quoteRetryPrompt(records.map((record) => ({ ...record, text: "" })));
  const room = budget.roomBeside([QUOTE_RETRY_INSTRUCTIONS, framing], maxOutputTokens);
  const perRecord = Math.min(EXCERPT_TOKENS, Math.floor(room / records.length) - 1);
  if (perRecord < MIN_EXCERPT_TOKENS) return;
  const asked: QuoteToRetry[] = records.map((record) => ({
    marker: record.marker,
    sentence: record.sentence,
    quote: record.quote,
    passage: record.passage,
    text: nearestExcerpt(record.text, record.quote, record.sentence, perRecord, budget.tokens),
  }));

  yield { type: "phase", phase: "checking-quotes" };
  const started = Date.now();
  let raw = "";
  try {
    const result = streamText({
      model: request.model,
      instructions: QUOTE_RETRY_INSTRUCTIONS,
      prompt: quoteRetryPrompt(asked),
      temperature,
      maxOutputTokens,
      output: Output.object({ schema: correctionsSchema, name: "quotes" }),
      // One request, never more: a failure leaves the records as they are.
      maxRetries: 0,
      abortSignal: signal,
      onError: () => undefined,
    });
    for await (const part of result.fullStream) {
      if (signal.aborted || part.type === "abort") return;
      if (part.type === "text-delta") raw += part.text;
      else if (part.type === "error") throw part.error;
    }
  } catch (error) {
    if (signal.aborted) return;
    console.error(
      `The quotes couldn't be asked for again: ${error instanceof Error ? error.message : String(error)}`,
    );
    // What came before the failure may be cut off (#2275): none of it is read.
    raw = "";
  }
  if (signal.aborted) return;
  const corrections = parseCorrections(await replyJson(raw));
  let recovered = 0;
  for (const record of asked) {
    const quote = corrections.get(record.marker);
    if (!quote || quote === record.quote) continue;
    try {
      if (documents.correctQuote(record.marker, quote)) recovered++;
    } catch (error) {
      console.error(
        `A corrected quote couldn't be recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  yield {
    type: "quotes-retried",
    retry: { records: asked.length, recovered, durationMs: Date.now() - started },
  };
}
