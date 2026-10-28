/**
 * Keeping an Answer's requests within a model's context window (see
 * `ContextWindow`): a local model's, or a cloud model's own when the catalog
 * gives it (see ../providers/capabilities). Ollama is told the window
 * (`num_ctx`) and to refuse a longer request rather than cut it (see
 * ../providers/ollamaChat), so nothing is lost without notice: the engine
 * makes each request fit, by IncarnaMind's own rules, giving up first what
 * matters least:
 *
 * 1. The Question context loses its oldest content first, as
 *    `buildQuestionContext` does (see `fitQuestionContext`), down to the
 *    Question alone; the Mind read with a Question in the assistant goes
 *    last, cut by its own rules. In the Tool loop, room for one search is kept first.
 * 2. Search results keep the most relevant Passages that fit what is left,
 *    by the search's own ranks (see `SearchResultForModel.ranks`), in the
 *    order the search gave them, and other Tool results are cut at the end.
 *    Once nothing more would fit, the model is told to answer with what it has.
 * 3. Every request keeps the room the model's output cap needs.
 *
 * A request whose instructions and Question alone don't fit fails with a
 * "too-long" error before anything is sent.
 *
 * Token counts are estimated (see `estimateTokens`) times a factor, until
 * Ollama's own count of a request comes back (`prompt_eval_count`, its input
 * tokens): from then on the Tool loop counts from it, and the factor is
 * corrected for the rest of the Answer and the model's next ones. A model's
 * tokenizer can count far more than the estimate: 1.35 times for Chinese with
 * Mistral's (docs/research/ollama-integration.md), almost 2 for text full of
 * digits with Qwen's, which splits numbers into single digits.
 */
import type { ProviderError } from "../api";
import type { ContextWindow } from "../providers/models";
import {
  estimateTokens,
  fitQuestionContext,
  head,
  holdsDocumentText,
  type RequestMind,
} from "./context";
import type { AnswerMessage } from "./engine";
import { CONTINUES_ATTRIBUTE } from "./prompt";

/** The factor on the estimate until a request's real count is known. */
export const ESTIMATE_FACTOR = 1.25;
/** The factor stays within these bounds when it is corrected. */
const MIN_FACTOR = 1;
const MAX_FACTOR = 4;
/** Tokens the chat template adds around each message. */
const MESSAGE_TOKENS = 8;
/** Room kept free in every request, for what the estimate misses. */
const MARGIN_TOKENS = 128;
/** What a model writes in a step of the Tool loop besides its Answer: a Tool call, a preamble. */
const STEP_OUTPUT_TOKENS = 128;
/** Kept free for the first search in the Tool loop: about 8 Passages of 500 tokens. */
export const SEARCH_RESERVE_TOKENS = 4_500;
/** A Tool result cut to less than this isn't worth sending: the model is told to answer instead. */
const MIN_RESULT_TOKENS = 256;

const PASSAGE = /<passage\b[^>]*>[\s\S]*?<\/passage>/g;
const PASSAGE_ID = /^<passage id="([^"]+)"/;
const CONTINUED = new RegExp(`^<passage\\b[^>]*\\b${CONTINUES_ATTRIBUTE}="([^"]+)"`);

/** What a search result says when none of its Passages fit. */
export const NO_ROOM_FOR_PASSAGES =
  "There is no room left in your context for more Passages: answer with the ones you have.";
/** What a Tool result says when it doesn't fit at all. */
const NO_ROOM_FOR_RESULT =
  "This result doesn't fit in what is left of your context: answer with what you have.";
/** Added where a Tool result was cut. */
const CUT_RESULT = "\n…(the rest doesn't fit in your context)";

/**
 * The request's Question context, fitted, and its estimated size, and the
 * share of the Mind read with the Question it kept when that had to be cut
 * (0: none of it), and whether the whole text of Documents it held was left
 * out; or why it can't fit.
 */
export type Fitted =
  | {
      ok: true;
      messages: AnswerMessage[];
      estimated: number;
      mindCut?: number;
      documentsDropped?: true;
    }
  | { ok: false; error: ProviderError };

export interface FitRequest {
  instructions: string;
  /** The Question context, oldest first, ending with the Question. */
  messages: readonly AnswerMessage[];
  question: string;
  /** The Tools' definitions as sent (their names, descriptions and schemas), if any. */
  tools?: string;
  /** Tokens to keep free for what the request will gain, e.g. search results. */
  reserve?: number;
  /** The Mind read with the Question, cut by its own rules if it doesn't fit whole. */
  mind?: RequestMind;
}

export type WindowBudget = ReturnType<typeof createWindowBudget>;

/**
 * One Answer's budget for a model's window. `factor`: what earlier Answers
 * learnt of its tokenizer; `remember` keeps what this one learns for the next.
 */
export function createWindowBudget(
  window: ContextWindow,
  factor = ESTIMATE_FACTOR,
  remember: (factor: number) => void = () => undefined,
) {
  let current = factor;
  const tokens = (text: string) => Math.ceil(estimateTokens(text) * current);
  /** What a request may hold before its output. */
  const limit = window.tokens - window.outputTokens - MARGIN_TOKENS;
  const messagesTokens = (messages: readonly AnswerMessage[]) =>
    messages.reduce((sum, message) => sum + tokens(message.content) + MESSAGE_TOKENS, 0);

  /**
   * Corrects the factor from a request Ollama counted: `actual` tokens where
   * `estimated` were expected. A little is added, as other text may count more.
   */
  const learn = (actual: number, estimated: number): void => {
    if (!(actual > 0 && estimated > 0)) return;
    current = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, ((current * actual) / estimated) * 1.05));
    remember(current);
  };

  const tooLong = (needed: number): ProviderError => ({
    kind: "too-long",
    message: `The request needs about ${needed} tokens, but the model's context window holds ${window.tokens}, ${window.outputTokens} of them kept for the Answer.`,
  });

  /**
   * Keeps whole Passages within `room` tokens: the most relevant first, by
   * `ranks` (the order given when there are none), until the next doesn't
   * fit, then in the order given. Text without Passages is cut at the end.
   */
  function fitResult(
    text: string,
    room: number,
    ranks?: readonly number[],
  ): { text: string; passages: number | null } {
    const passages = text.match(PASSAGE);
    if (passages) {
      const order = passages.map((_, index) => index);
      if (ranks?.length === passages.length) {
        order.sort((a, b) => (ranks[a] as number) - (ranks[b] as number) || a - b);
      }
      const ids = passages.map((passage) => PASSAGE_ID.exec(passage)?.[1]);
      const before = passages.map((passage) => {
        const continued = CONTINUED.exec(passage)?.[1];
        return continued === undefined ? -1 : ids.indexOf(continued);
      });
      const chosen = new Set<number>();
      let used = 0;
      const costOf = (at: number) => tokens(passages[at] as string) + 1;
      for (const index of order) {
        if (chosen.has(index)) continue;
        // A Passage that leaves out the start it shares with the one before goes with it if it can.
        const group: number[] = [];
        for (let at = index; at >= 0 && !chosen.has(at); at = before[at] ?? -1) group.push(at);
        const cost = group.reduce((sum, at) => sum + costOf(at), 0);
        const taken = used + cost <= room ? group : used + costOf(index) <= room ? [index] : null;
        if (!taken) break;
        for (const at of taken) chosen.add(at);
        used += taken === group ? cost : costOf(index);
      }
      const kept = passages.filter((_, index) => chosen.has(index));
      if (kept.length === passages.length) return { text, passages: passages.length };
      return {
        text: kept.length > 0 ? kept.join("\n\n") : NO_ROOM_FOR_PASSAGES,
        passages: kept.length,
      };
    }
    if (tokens(text) <= room) return { text, passages: null };
    if (room < MIN_RESULT_TOKENS) return { text: NO_ROOM_FOR_RESULT, passages: null };
    const cut = head(text, Math.floor((room - tokens(CUT_RESULT)) / current));
    return { text: `${cut}${CUT_RESULT}`, passages: null };
  }

  return {
    window,
    /** The factor on the estimate, as corrected so far. */
    get factor() {
      return current;
    },
    /** Estimated tokens of a text. */
    tokens,

    learn,

    /**
     * Fits a request: the Question context loses its oldest content until the
     * instructions, the Tools, the Question context and `reserve` fit, but the
     * reserve gives way before the Question does.
     */
    fit(request: FitRequest): Fitted {
      const fixed = tokens(request.instructions) + tokens(request.tools ?? "") + MESSAGE_TOKENS;
      const room = limit - fixed;
      const question = tokens(request.question) + MESSAGE_TOKENS;
      if (question > room)
        return { ok: false, error: tooLong(fixed + question + window.outputTokens) };
      const forContext = Math.max(question, room - (request.reserve ?? 0));
      const overhead = MESSAGE_TOKENS * request.messages.length;
      let mindCut: number | undefined;
      const messages = fitQuestionContext(
        request.messages,
        request.question,
        Math.floor((forContext - overhead) / current),
        request.mind,
        (kept) => {
          mindCut = kept.text ? kept.share : 0;
        },
      );
      if (!messages) return { ok: false, error: tooLong(fixed + question + window.outputTokens) };
      return {
        ok: true,
        messages,
        estimated: fixed + messagesTokens(messages),
        ...(mindCut !== undefined && { mindCut }),
        ...(holdsDocumentText(request.messages) &&
          !holdsDocumentText(messages) && { documentsDropped: true as const }),
      };
    },

    /**
     * The Passages of a search, for a request with these instructions and
     * Question: the most relevant that fit (by `ranks`, see `fitResult`).
     */
    fitPassages(
      passages: string,
      instructions: string,
      question: string,
      ranks?: readonly number[],
    ): string {
      const room = limit - tokens(instructions) - tokens(question) - 3 * MESSAGE_TOKENS;
      return fitResult(passages, room, ranks).text;
    },

    /**
     * Tokens left in a request of these messages (the first its instructions)
     * whose output is capped at `outputTokens`: for a request of the engine's
     * own, such as the one for exact quotes (see ./quoteRetry).
     */
    roomBeside(messages: readonly string[], outputTokens: number): number {
      const held = messages.reduce((sum, text) => sum + tokens(text) + MESSAGE_TOKENS, 0);
      return window.tokens - Math.min(outputTokens, window.outputTokens) - MARGIN_TOKENS - held;
    },

    /** Error for a request Ollama refused as too long, after the retry. */
    tooLong(promptTokens: number | null): ProviderError {
      return tooLong((promptTokens ?? window.tokens) + window.outputTokens);
    },

    /**
     * The Tool loop's account of its requests, from the first one's estimate:
     * the room left for Tool results, and whether another step can call Tools.
     */
    loop(firstEstimate: number) {
      /** What the first request holds, as best known: what `stepFinished` corrects the factor by. */
      let first = firstEstimate;
      /** Tokens the next request will hold, as best known. */
      let held = firstEstimate;
      /** Tool results added since the last request. */
      let added = 0;
      let steps = 0;
      const room = () => limit - held - STEP_OUTPUT_TOKENS;
      const cost = (text: string) => tokens(text) + MESSAGE_TOKENS;
      const fitWithin = (text: string, count: number, ranks?: readonly number[]) => {
        const fitted = fitResult(text, room(), ranks);
        return { text: fitted.text, passageCount: fitted.passages ?? count };
      };
      return {
        /** A search's Passages, fitted to the room left (by `ranks`), and how many were kept. */
        passages(
          text: string,
          count: number,
          ranks?: readonly number[],
        ): { text: string; passageCount: number } {
          const fitted = fitWithin(text, count, ranks);
          held += cost(fitted.text);
          added += cost(fitted.text);
          return fitted;
        },
        /**
         * Passages the first request carries, made before it is sent (the search made first,
         * #1633): fitted to the room left, then counted with the messages that carry them in the
         * first request itself, not as a later step's result.
         */
        carried(
          text: string,
          count: number,
          ranks: readonly number[] | undefined,
          messages: (fitted: string) => readonly string[],
        ): { text: string; passageCount: number } {
          const fitted = fitWithin(text, count, ranks);
          const size = messages(fitted.text).reduce((sum, each) => sum + cost(each), 0);
          first += size;
          held += size;
          return fitted;
        },
        /** Another Tool's result, cut to the room left. */
        result(text: string): string {
          const fitted = fitResult(text, room()).text;
          held += cost(fitted);
          added += cost(fitted);
          return fitted;
        },
        /** What the first request holds, as best known. */
        firstRequest: () => first,
        /** Whether the next step may call Tools: there is room for a result worth having. */
        canCallTools: () => room() >= MIN_RESULT_TOKENS + MESSAGE_TOKENS,
        /**
         * A step ended: its request's real size, when Ollama counted it,
         * replaces the estimate; the first one's corrects the factor.
         */
        stepFinished(usage: { inputTokens: number | undefined; outputTokens: number | undefined }) {
          const output = usage.outputTokens ?? STEP_OUTPUT_TOKENS;
          if (usage.inputTokens) {
            if (steps === 0) learn(usage.inputTokens, first);
            held = usage.inputTokens + output + MESSAGE_TOKENS + added;
          } else {
            held += output + MESSAGE_TOKENS;
          }
          added = 0;
          steps++;
        },
      };
    },
  };
}
