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
 * 3. Every request keeps the room the model's output cap needs. Where the
 *    window is small, the cap of the Answer's own requests gives way first,
 *    as far as the first search's room for a few Passages needs, never below
 *    a floor (#3045).
 *
 * A request that can't be sent fails before anything is sent: "window-too-small"
 * where even an empty Question would leave no room to read a Passage beside the
 * instructions and Tools, else "too-long". Required context stays whole or fails too.
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
  keptWhole,
  type RequestMind,
} from "./context";
import type { AnswerMessage } from "./engine";

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
/**
 * The least output cap an Answer's own requests are given where the window is small, unless the
 * window sets its own (`ContextWindow.outputFloor`): at 16,384 tokens the assistant's instructions
 * and Tools take about 12,200, so a cap of 4,096 left no room to read anything (#3045).
 */
export const OUTPUT_FLOOR_TOKENS = 1_024;
/** A Passage, as Documents are split for search (../documents/searchTool): about this many tokens. */
const PASSAGE_TOKENS = 500;
/**
 * The output cap gives way only as far as the first search's room for this many Passages needs:
 * about what a Question in a Note reads at 8k with its whole cap, so that path keeps its cap, and
 * at 16k the assistant still reads a search's worth (#3045).
 */
const FIRST_SEARCH_PASSAGES = 5;
/** At a small window the turn just before is kept only beside at least this many Passages (#3045). */
const MIN_PASSAGES = 3;
/** A Tool result cut to less than this isn't worth sending: the model is told to answer instead. */
const MIN_RESULT_TOKENS = 256;

const PASSAGE = /<passage\b[^>]*>[\s\S]*?<\/passage>/g;

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
  /** The Transcript, protocol and retained fact IDs must not be cut apart (#2306). */
  requiredContext?: true;
  question: string;
  /** The Tools' definitions as sent (their names, descriptions and schemas), if any. */
  tools?: string;
  /** Tokens to keep free for what the request will gain, e.g. search results. */
  reserve?: number;
  /** It reads Passages: an Answer that couldn't read one doesn't start (#3045). */
  reads?: true;
  /** The line naming the Documents on screen, which goes with the Question where it reads (#3045). */
  onScreen?: string;
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
  const floor = Math.min(window.outputFloor ?? OUTPUT_FLOOR_TOKENS, window.outputTokens);
  /** The output cap of the Answer's own requests: the window's, until a request's fit lowers it. */
  let output = window.outputTokens;
  /** What a request may hold before its output. */
  const limit = () => window.tokens - output - MARGIN_TOKENS;
  const onePassage = () => Math.ceil(PASSAGE_TOKENS * current);
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
    message: `The request needs about ${needed} tokens, but the model's context window holds ${window.tokens}, ${output} of them kept for the Answer.`,
  });

  // Agents, a check's card and a cell's tooltip show the message: the numbers go to the log only.
  const windowTooSmall = (fixed: number): ProviderError => {
    console.warn(
      `A request didn't fit the model's context window: window ${window.tokens}, instructions and Tools about ${fixed}, output at least ${floor}.`,
    );
    return {
      kind: "window-too-small",
      message:
        "The model's context window is too small to read a Passage beside the model's instructions.",
    };
  };

  /** The selection can't go whole beside three Passages at the floor, though the Question alone would. */
  const selectionTooLong = (fixed: number, question: number, selection: number): ProviderError => {
    console.warn(
      `A selection didn't fit the model's context window: window ${window.tokens}, instructions and Tools about ${fixed}, Question about ${question}, selection about ${selection}, output at least ${floor}.`,
    );
    return {
      kind: "too-long",
      message:
        "The selected text is too long to go with the Question in the model's context window.",
      tooLong: "selection",
    };
  };

  /**
   * Sizes the output cap for a request of `fixed` tokens and a Question of `question`, which must
   * leave `need` tokens free and would like `wanted`: the cap gives way only as far as `wanted`
   * needs, and never below the floor. Or why it can't be sent, decided by one test so the problem's
   * advice is always true: where even an empty Question would leave less than `need`, no Question
   * fits ("window-too-small"); else this one is too long.
   */
  function size(
    fixed: number,
    question: number,
    need: number,
    wanted: number,
  ): ProviderError | null {
    const atFloor = window.tokens - MARGIN_TOKENS - floor - fixed;
    if (atFloor - MESSAGE_TOKENS < need) return windowTooSmall(fixed);
    if (atFloor - question < need) return tooLong(fixed + question + need + floor);
    const room = window.tokens - MARGIN_TOKENS - fixed - question - wanted;
    output = Math.max(floor, Math.min(window.outputTokens, room));
    return null;
  }

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
      const chosen = new Set<number>();
      let used = 0;
      for (const index of order) {
        const cost = tokens(passages[index] as string) + 1;
        if (used + cost > room) break;
        chosen.add(index);
        used += cost;
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
    /** The window the Answer's own requests are sent within: its output cap as the last fit sized it. */
    get window(): ContextWindow {
      return { ...window, outputTokens: output };
    },
    /** The last fit lowered the output cap for the window. */
    get lowered(): boolean {
      return output < window.outputTokens;
    },
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
     * reserve gives way before the Question does. Required context is never cut.
     */
    fit(request: FitRequest): Fitted {
      const fixed = tokens(request.instructions) + tokens(request.tools ?? "") + MESSAGE_TOKENS;
      if (request.requiredContext) {
        const held = messagesTokens(request.messages);
        const error = size(fixed, held, 0, 0);
        if (error) return { ok: false, error };
        return { ok: true, messages: [...request.messages], estimated: fixed + held };
      }
      const onScreen = request.reads ? request.onScreen : undefined;
      const held = keptWhole(request.messages, request.question, request.mind, onScreen);
      // Where it reads, the Question goes with the line naming the Documents on screen, and with the
      // Search scope after that line or the selection: no Tool gives them back (#3045).
      const question =
        tokens(request.question) +
        MESSAGE_TOKENS +
        (request.reads
          ? Math.ceil((held.asked - estimateTokens(request.question) + held.onScreen) * current)
          : 0);
      // The first search's room: its Passages and the step that asks for it.
      const error = request.reads
        ? size(
            fixed,
            question,
            onePassage() + STEP_OUTPUT_TOKENS,
            FIRST_SEARCH_PASSAGES * onePassage(),
          )
        : size(fixed, question, 0, 0);
      if (error) return { ok: false, error };
      // Where it reads, the selection goes with the Question, whole, and the Mind is cut without it:
      // the Mind's cut would shorten it. At a small window the turn just before is kept too, whole or
      // not at all. The room to write gives way for them only where they don't fit at the cap, then
      // Passages beyond three; where everything fits, nothing moves.
      const selection =
        request.reads && held.selection > 0 ? Math.ceil(held.selection * current) : 0;
      const turn =
        request.reads && held.turn > 0 ? Math.ceil(held.turn * current) + 2 * MESSAGE_TOKENS : 0;
      const contextRoom = limit() - fixed - (request.reserve ?? 0);
      const besideThree = (ahead: number) =>
        window.tokens - MARGIN_TOKENS - floor - fixed - question - ahead >=
        MIN_PASSAGES * onePassage() + STEP_OUTPUT_TOKENS;
      const selectionLeftOut = selection > 0 && contextRoom < question + selection;
      if (selectionLeftOut && !besideThree(selection)) {
        return { ok: false, error: selectionTooLong(fixed, question, selection) };
      }
      const keepsTurn =
        turn > 0 && contextRoom < question + selection + turn && besideThree(selection + turn);
      const ahead = (selectionLeftOut || keepsTurn ? selection : 0) + (keepsTurn ? turn : 0);
      if (ahead > 0) {
        const room = window.tokens - MARGIN_TOKENS - fixed - question - ahead;
        output = Math.max(
          floor,
          Math.min(window.outputTokens, room - FIRST_SEARCH_PASSAGES * onePassage()),
        );
      }
      const room = limit() - fixed;
      const forContext = Math.max(question + ahead, room - (request.reserve ?? 0));
      const overhead = MESSAGE_TOKENS * request.messages.length;
      let mindCut: number | undefined;
      const messages = fitQuestionContext(
        request.messages,
        request.question,
        // The overhead counts every message, kept or not: with room for the Question alone, the
        // earlier ones it drops must not leave too little for the Question itself, nor for what
        // goes with it. The few tokens the two counts differ by come out of the search's reserve.
        Math.max(
          Math.floor((forContext - overhead) / current),
          held.asked +
            held.onScreen +
            (selection > 0 ? held.selection : 0) +
            (keepsTurn ? held.turn : 0),
        ),
        request.mind,
        (kept) => {
          mindCut = kept.text ? kept.share : 0;
        },
        { ...(onScreen && { onScreen }), selection: selection > 0, turn: keepsTurn },
      );
      if (!messages) return { ok: false, error: tooLong(fixed + question + output) };
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
     * Question: the most relevant that fit (by `ranks`, see `fitResult`), the
     * output cap giving way as far as they need. Null when none of them fits.
     */
    fitPassages(
      passages: string,
      instructions: string,
      question: string,
      ranks?: readonly number[],
    ): string | null {
      const fixed = tokens(instructions) + tokens(question) + 3 * MESSAGE_TOKENS;
      const wanted = Math.min(tokens(passages), FIRST_SEARCH_PASSAGES * onePassage());
      output = Math.max(
        floor,
        Math.min(window.outputTokens, window.tokens - MARGIN_TOKENS - fixed - wanted),
      );
      const fitted = fitResult(passages, limit() - fixed, ranks);
      return fitted.passages === 0 ? null : fitted.text;
    },

    /**
     * Why a request with these instructions and Question couldn't read the Passages its search
     * found: the window can't hold one beside its instructions whatever the Question, or this
     * Question is too long to leave room for one.
     */
    cannotRead(instructions: string, question: string): ProviderError {
      const fixed = tokens(instructions) + 2 * MESSAGE_TOKENS;
      return (
        size(fixed, tokens(question) + MESSAGE_TOKENS, onePassage(), 0) ?? windowTooSmall(fixed)
      );
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
      return tooLong((promptTokens ?? window.tokens) + output);
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
      const room = () => limit() - held - STEP_OUTPUT_TOKENS;
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
