/**
 * The Answer engine: the one place that turns Question context into a
 * streamed Answer by calling a chat model. Everything else about Answers
 * (building the context, the Tools' work, Citations, writing the Answer into
 * the Mind, stop and regenerate, the event stream) depends only on this port,
 * so the agent layer behind it can change without touching the rest.
 *
 * How the model cites depends on what it can do (see `CitationSupport`):
 * - "tools": a Tool-calling loop (ADR-0007), run by a Run engine (see
 *   ../runs/engine; AI SDK 7 by default). The model searches the Documents
 *   with `search_documents` as often as it needs, gives the records of its
 *   Citation markers with `cite`, and has the numbers it works out calculated
 *   with `calculate` (./calculations). The Answer keeps what is its own on top of
 *   the engine's events: the search phase, preambles taken back, the records
 *   and the markers they place.
 * - "structured-output": for a model that can't call Tools, or a small local
 *   model, which doesn't cite in the loop (see `citingMode` in
 *   ../providers/ollamaModels): one search, its Passages in the instructions,
 *   and the Answer and its records returned as one JSON object. A follow-up
 *   Question is first rewritten by the model into a search query that stands
 *   on its own (see `searchQuery`). When some of the Documents are in another
 *   language than the Question, the query is also translated into theirs and
 *   searched again, as the search Tool tells a model in the loop to do (see
 *   `searchLanguage`). A local model whose quotes the check doesn't find is
 *   asked for them once more, as `cite`'s feedback lets a model in the loop
 *   fix them (see ./quoteRetry).
 * - "none": for a model that can do neither, the same search, and a plain Answer.
 * The engine starts where it is told (or with Tools), and steps down when the
 * provider refuses Tools or structured output. A model may give records but
 * leave their markers out of its text: the engine then places them (see
 * ./markerPlacement).
 *
 * For a model with a known context window (a local model's fixed one, or a
 * cloud model's own from the catalog), every request is kept within it by
 * IncarnaMind's own rules (see ./window), and one that can't fit fails as
 * "too-long"; nothing is left to the server to cut.
 *
 * What the model is known to do before the first request (see
 * ../providers/capabilities) sets where this starts: how it cites, whether
 * structured output is worth trying, whether it takes a temperature. Answers
 * are written at a low temperature (see `ANSWER_TEMPERATURE`), except with
 * models known not to take one; a provider that refuses it gets the request
 * again without, and that model gets none from then on. These retries, and
 * stepping down from Tools, are the Answer's: the Run engine only reports
 * what the provider refused.
 *
 * Every Tool the loop offers has one shape and comes from a Tool provider
 * (see ../tools): the Documents' own (made here, from `AnswerTools`), and
 * those the request brings: the Skills' (`use_skill`, `read_skill_file`,
 * `run_skill_script`, see ../skills/tools) and each Connector's. A call that
 * asks the User first waits in the request's `gate`, which the engine awaits
 * before each call. The gate is told whether the Run had read untrusted
 * content first (`GatedCall.tainted`): the loop records it, above the engine,
 * from the results of the Tools that declare them untrusted
 * (docs/designs/agent-extensibility.md §4.6). It is told too why the Run
 * counts as having read third-party text (`GatedCall.thirdParty`, #78): what
 * the request starts it with, then what its Tools say they read, such as a
 * search that found a saved web page's Passages. Each Run is offered a Tool
 * set (`ToolSet`): an Answer every Tool, a check Run the Documents' search
 * and `cite` only. The loop names none of the Tools but the Documents' own:
 * every call shows as a Tool-call card, from its provider, except `cite`,
 * whose records become Citations, and `calculate`, whose figures become the
 * Answer's calculated figures (ADR-0021); results that aren't Passages are
 * never cited. With Skills or Connector Tools but no Documents, the loop runs with
 * those alone; a model that can't call Tools answers without.
 */
import {
  generateText,
  jsonSchema,
  type ModelMessage,
  Output,
  parsePartialJson,
  streamText,
} from "ai";
import type {
  AnswerPhase,
  CitationSupport,
  ClaimedChange,
  FigureRetry,
  ProviderError,
  QuoteRetry,
  ReadThirdPartySource,
  ThirdPartyReason,
  UnreadFile,
} from "../api";
import { ONE_SEARCH_PARAMETERS, type SearchToolParameters } from "../documents/searchTool";
import { detectLanguage } from "../documents/textLanguage";
import type { ChatLanguageModel, ContextWindow } from "../providers/models";
import { cacheProviderOptions, stablePrefixOptions, tokenUsageOf } from "../providers/promptCache";
import {
  classifyProviderError,
  contextOverflow,
  refusesFeature,
} from "../providers/providerErrors";
import { createAiSdkRunEngine, reasoningReader } from "../runs/aiSdkEngine";
import type {
  GateDecision,
  RunEngine,
  RunEvent,
  RunMessage,
  RunRequest,
  RunToolCall,
  RunWindow,
  TokenUsage,
} from "../runs/engine";
import { inStep } from "../timing/flows";
import { DOCUMENT_TOOLS, offeredTools, type Tool, type ToolProviderInfo } from "../tools";
import { asksForFigureFixes, type FigureProblem, givenList } from "./calculations";
import { asksForFixes, WRITE_NOW } from "./citations";
import { earlierContext, type RequestMind, withLineBefore } from "./context";
import { retryFigures } from "./figureRetry";
import { missingMarkerEvents, textEdits } from "./markerPlacement";
import {
  NOTHING_SHOWN_YET,
  SEARCH_QUERY_INSTRUCTIONS,
  searchQueryPrompt,
  TRANSLATE_QUERY_INSTRUCTIONS,
  translateQueryPrompt,
  withPassageNotes,
} from "./prompt";
import { retryQuotes } from "./quoteRetry";
import { heldBackFrom, TOOL_TEXT_TAGS, takeToolText } from "./toolText";
import { claimsOf, createNudges, settleReply, type TurnCheck } from "./turnChecks";
import { citeUnmarked } from "./unmarkedQuotes";
import { createWindowBudget, SEARCH_RESERVE_TOKENS, type WindowBudget } from "./window";

/** One message of Question context. */
export interface AnswerMessage {
  role: "user" | "assistant";
  /** Markdown. */
  content: string;
  /**
   * The length of the start of `content` that the next Question's request
   * repeats as it is: the Mind read with it (#564), which a provider's prompt
   * cache keeps (see ../providers/promptCache).
   */
  stablePrefix?: number;
}

/** A Citation record, as the model gives it for one marker. */
export interface CitationRecordInput {
  /** The marker's number: 1 for "[^1]". */
  marker: number;
  /** The Passage's id, as the search gave it (e.g. "P3"). */
  passage: string;
  /**
   * Where the quote is, as the Passage's marks name it (ADR-0011): "p. 4",
   * "slide 4", "§ 2.1 Sensitivity", "Revenue, rows 12–14", "lines 120–134".
   */
  location?: string | null;
  /** For a PDF (or a deck), instead of `location`: the page or two consecutive pages the quote is on. */
  pageFrom?: number | null;
  pageTo?: number | null;
  /** A short quote, copied word for word from the Passage. */
  quote: string;
}

/** How records came, for `AnswerTools.cite`. */
export interface CiteOptions {
  /**
   * In structured output, which gets no word back to fix its records with
   * (see `structured`): a Passage named by its number alone ("1"), or with
   * more ("P1 (p. 9)"), is "P1"; a record naming none it was given (a
   * Document's name, say) cites the first Passage it was given whose pages
   * hold its quote word for word; and a quote that isn't on the pages its
   * record names, but is word for word on a page of the Passage it names, or
   * on two consecutive ones, is cited there, as `cite`'s feedback lets a
   * model in the Tool loop do.
   */
  structured?: boolean;
}

/** How one search of the Documents is made. */
export interface AnswerSearchOptions {
  /** False leaves the reranker out (ADR-0009, 2026-10-12). Omitted: as the User set it. */
  rerank?: boolean;
  /** Counts for this search instead of the Tool's defaults. */
  parameters?: Partial<SearchToolParameters>;
  /** Only this Document, by its name as the instructions list it. */
  document?: string;
}

/** What a search gives the model. */
export interface SearchResultForModel {
  /** The Passages, formatted for the model, or a sentence saying there are none. */
  text: string;
  passageCount: number;
  /** The Passages found, by id, as their Citations name them: what an Answer's steps show each search led to. */
  passageIds?: readonly string[];
  /**
   * Each Passage's relevance, in the order `text` has them (reading order):
   * 0 the most relevant. A window too small for all of them keeps the most
   * relevant (see ./window). Absent: their order is their relevance.
   */
  ranks?: number[];
  /**
   * The third-party text among the Passages: "web-page" when one is a saved
   * web page's (#78). Reading it makes the Run third-party. Absent: none.
   */
  thirdParty?: readonly ReadThirdPartySource[];
}

/** A language the Documents to search are in, and how many of them are. */
export interface DocumentLanguage {
  /** In English, e.g. "Chinese". */
  language: string;
  documents: number;
}

/**
 * Searching and citing the Documents, done by the core: the engine makes the
 * Documents' Tools from it, and the ways of answering without Tools use it too.
 */
export interface AnswerTools {
  /** Documents with Passages to search. With none, there is no document search. */
  readonly documentCount: number;
  /**
   * The languages the Documents to search are in, the most common first: the
   * search Tool names them, so the model searches again in theirs when the
   * Question is in another language. Empty or absent when they can't be told.
   */
  readonly documentLanguages?: readonly DocumentLanguage[];
  /** The Documents in the Search scope whose text couldn't be read: the search Tool says so. Absent: none are known. */
  unreadDocuments?(): readonly UnreadFile[];
  /** The Documents in the Search scope still being read: the search Tool says so, so a Document isn't taken for missing (#1503). */
  readingDocuments?(): readonly { name: string }[];
  /** The document-search Tool. */
  searchDocuments(
    query: string,
    signal?: AbortSignal,
    options?: AnswerSearchOptions,
  ): Promise<SearchResultForModel>;
  /** Takes Citation records; returns what to tell the model about them. */
  cite(records: readonly CitationRecordInput[], options?: CiteOptions): string;
  /** Whether a valid record was taken for this marker: the engine places its marker if the model left it out. */
  hasRecord?(marker: number): boolean;
  /** The Passages the model was given in this Answer, by the id it cites them by, as it read them. */
  shownPassages?(): readonly { id: string; text: string }[];
  /**
   * Whether the Citation check would find `quote` in the Passage named `passage`
   * ("P3"), read as structured output's records are (see `CiteOptions`).
   */
  quoteFound?(passage: string, quote: string): boolean;
  /**
   * The records taken whose quotes the check doesn't find on the pages they
   * cite, by marker: what structured output's one request for exact quotes
   * asks about (see ./quoteRetry).
   */
  unfoundQuotes?(): UnfoundQuote[];
  /**
   * A new quote for a marker's record, from that request: it replaces the
   * record's quote, cited where it is in the record's Passage as structured
   * output's records are (see `CiteOptions`), only when the check finds it
   * there. Whether it did; if not, the record stays as it was.
   */
  correctQuote?(marker: number, quote: string): boolean;
  /**
   * Whether the Answer wrote its text into a Mind: its Citations are
   * there, so its reply only reports what was done, and no marker the model
   * left out of the reply is placed in it, nor any asked for.
   */
  wroteIntoMind?(): boolean;
  /**
   * Takes calculated figures (ADR-0021, ./calculations); returns what to tell
   * the model about them. Absent: the Answer offers no `calculate`.
   */
  calculate?(figures: readonly unknown[], options?: CiteOptions): string;
  /**
   * The figures structured output gave that couldn't be worked out: what its
   * one request to fix them asks about (see ./figureRetry).
   */
  figureProblems?(): FigureProblem[];
  /**
   * `text` with a Citation marker for each quote a figure gave its inputs directly, where the
   * figure's sentence or table cell has none (#1831); each quote is recorded as a Citation.
   */
  citeFigures?(text: string): string;
}

/** A record whose quote the check doesn't find, with the text of the Passage it names (see `AnswerTools.unfoundQuotes`). */
export interface UnfoundQuote {
  marker: number;
  /** The Passage's id, as the model was given it (e.g. "P3"). */
  passage: string;
  /** The quote, as taken: without the quotation marks or ellipses around it. */
  quote: string;
  /** The Passage's text, as the model was given it, with its location marks. */
  text: string;
}

export interface InstructionOptions {
  /** "structured-output" and "none": the Passages the search found (formatted, or a sentence saying there are none). */
  passages?: string;
  /** The model is offered the Skills' Tools. */
  skillTools?: boolean;
  /** The model is offered Connectors' Tools. */
  connectorTools?: boolean;
  /** The model is offered Find sources' Tool. */
  sourceTools?: boolean;
  /** The model is offered web search's Tools. */
  webTools?: boolean;
  /** The model is offered the Minds' Tools (#202). */
  mindTools?: boolean;
  /** The model is offered the commands' Tools (#1110). */
  commandTools?: boolean;
}

/** A Tool call at the Answer's gate. */
export interface GatedCall extends RunToolCall {
  /**
   * The Run had read untrusted content before this call: the result of a
   * Tool that declares `untrustedResult`, such as a search that found
   * Passages (docs/designs/agent-extensibility.md §4.6).
   */
  tainted: boolean;
  /**
   * Why the Run counts as having read third-party text before this call (#78):
   * what it started with (`AnswerRequest.thirdParty`), then what its Tools
   * read, oldest first, each once. Empty: none.
   */
  thirdParty: readonly ThirdPartyReason[];
}

/**
 * Which Tools a Run is offered (#78):
 * - "answer": an ordinary Answer's: the Documents' search and `cite`, and
 *   every other Tool the request brings (Skills, Connectors, Find sources);
 * - "check": a check Run's (check against documents, verify, a comparison
 *   table's cells, contradiction watch): the Documents' search and `cite` only,
 *   whatever the request brings, so the text it checks can't steer a write or
 *   a send;
 * - "documents": the Documents' Tools as an Answer has them, and nothing the
 *   request brings: help during a call, which reads a transcript
 *   someone else spoke.
 */
export type ToolSet = "answer" | "check" | "documents";

export interface AnswerRequest {
  /**
   * The instructions for a way of citing. "no-documents": the User has no
   * Documents to search.
   */
  instructions(mode: CitationSupport | "no-documents", options?: InstructionOptions): string;
  /** The Question context, oldest first; the last message is the User's and ends with the Question. */
  messages: AnswerMessage[];
  /**
   * The Mind read with a Question in the assistant (#544), right before the
   * Question in its message: within a window, it is cut by its own rules.
   */
  mind?: RequestMind;
  /**
   * The Question's own text: what a model that can't call Tools searches for,
   * once it has rewritten it into a query that stands on its own.
   */
  question: string;
  /**
   * The line naming the User's Minds (#1790), right before `asked`, the end of the last message:
   * only in a pass that offers the Minds' Tools. Without them it would reach a model that can't
   * read the Minds, and the search rewrite's notebook.
   */
  mindsLine?: { line: string; asked: string };
  /** The model to answer with, from `Core.prepareChatModel`. */
  model: ChatLanguageModel;
  /**
   * The model for the calls that don't write the Answer: rewriting a
   * follow-up Question into a search query, and translating the query. Asked
   * for only when one is made, and already asked to skip thinking, which
   * would fill their few tokens. Without it, or when it can't be had (e.g. its
   * flow was declined), the Answer's model makes them.
   */
  quickModel?(): Promise<ChatLanguageModel>;
  /** Searching and citing the Documents: the Documents' Tools, and the search of a model without Tools. */
  documents: AnswerTools;
  /**
   * The other Tools a model that can call Tools is offered, from their
   * providers: the Skills' and the Connectors' (see ../tools). Within a
   * window, what they return is cut to the room left.
   */
  tools: readonly Tool[];
  /**
   * Awaited before each call of an offered Tool (see `RunRequest.gate`): the
   * Answer's approvals decide there whether it asks the User first. Without
   * it, every call runs.
   */
  gate?(tool: Tool, call: GatedCall): Promise<GateDecision>;
  /** Whether a Tool hears its calls' input as it comes (see `RunRequest.streamsInput`). Without it, none does. */
  streamsInput?(tool: Tool): boolean;
  /** Which Tools the Run is offered. Absent: "answer", every Tool. */
  toolSet?: ToolSet;
  /** What a search says of the Answer's language after its Passages (see `DocumentToolsHooks`). */
  languageNote?(): string | null;
  /**
   * The Run counts as having read third-party text from its start: its
   * Question context holds some, or (a check Run) it reads the document it
   * checks (#78). Each call's gate is told (`GatedCall.thirdParty`).
   */
  thirdParty?: readonly ThirdPartyReason[];
  /** How this model is known to cite, from its capabilities or earlier Answers. Unknown: try Tools first. */
  support?: CitationSupport;
  /** In the Tool loop, the model writes the Answer, then cites it in the same reply (#489). */
  writeThenCite?: boolean;
  /** False: the model is known to give no structured output, so it isn't tried. */
  structuredOutput?: boolean;
  /**
   * Whether the model takes a temperature (see ../providers/capabilities).
   * False: it gets none. Unknown: it gets the Answer temperature, and none
   * once its provider refuses it.
   */
  takesTemperature?: boolean;
  /**
   * The model's context window: every request is kept within it (see
   * ./window), and one that can't fit fails as "too-long". None when it isn't
   * known: requests are sent as they are.
   */
  window?: ContextWindow;
  /** The most the model writes in one reply, in tokens, when the catalog says. */
  maxOutput?: number;
  /** The model needs the Tools in every request, the last step's too (`ModelFacts.toolsEveryRequest`). */
  toolsEveryRequest?: boolean;
  /**
   * In structured output, ask the model once more for the quotes the check
   * doesn't find (see ./quoteRetry): a local model, never a cloud one.
   */
  retryQuotes?: boolean;
  /**
   * Names the conversation (a Mind or an assistant's conversation), for
   * providers that route requests to a prompt cache by a key (see ../providers/promptCache).
   */
  cacheKey?: string;
  /**
   * The end-of-turn checks (see ./turnChecks), in order. In the Tool loop the
   * model is asked once more with a check's note, and a reply that still
   * trips one, or one written without Tools, ends with "claims-unbacked".
   */
  turnChecks?: readonly TurnCheck[];
  /**
   * How much of a reply being written may show while it streams: up to the
   * first sentence that may claim a change, which waits for the checks.
   * Absent: all of it.
   */
  shownUpTo?(text: string): number;
  /** Whether a reply with no text still answers: the Answer changed a Mind, which its card reports. */
  mayEndBlank?(): boolean;
  /** Stops generating. The stream then ends, with neither "finished" nor "failed". */
  signal: AbortSignal;
}

export type AnswerEngineEvent =
  /** How the model gives Citations, once its provider has accepted the request. */
  | { type: "support"; support: CitationSupport }
  /**
   * What the Answer is doing now: searching the Documents, the model's turn,
   * or asking the model once more for exact quotes (see ./quoteRetry).
   */
  | {
      type: "phase";
      phase: Extract<AnswerPhase, "searching" | "writing" | "checking-quotes" | "checking-figures">;
    }
  /** The engine put in `count` Citation markers the model left out of its text (see ./markerPlacement). */
  | { type: "markers-placed"; count: number }
  /**
   * Citations the engine added for sentences the Answer wrote without markers
   * (see ./unmarkedQuotes), and whether the model was asked once more for them.
   */
  | { type: "cited-after-checking"; count: number; asked: boolean }
  /** The model's window holds only part of the Mind read with the Question: this share of it (0: none). */
  | { type: "mind-cut"; share: number }
  /** The model's window left out the whole text of the Documents that went with the Question. */
  | { type: "documents-dropped" }
  /** The model was asked once more for exact quotes (see ./quoteRetry), and what that gave. */
  | { type: "quotes-retried"; retry: QuoteRetry }
  /** The model was asked once more for the figures it gave that couldn't be worked out (see ./figureRetry). */
  | { type: "figures-retried"; retry: FigureRetry }
  /**
   * The model's reasoning as its provider streams it (see `RunEvent`): a
   * summary or raw chain of thought, which the Answer keeps or drops.
   */
  | { type: "reasoning"; text: string }
  /** More of the Answer's text (Markdown, with Citation markers), in order. */
  | { type: "text-delta"; text: string }
  /**
   * The last `length` characters of text were only a preamble to a search
   * ("Let me look that up"), or are being replaced: remove them.
   */
  | { type: "text-retracted"; length: number }
  /**
   * The texts the model wrote beside `cite` or `calculate` alone, after a search, with no marker
   * in them, that the Answer doesn't show, in the order written. Once, before "finished", when
   * there is any.
   */
  | { type: "text-set-aside"; texts: string[] }
  /**
   * A Tool call started, for its Tool-call card: any Tool but `cite` and `calculate`, or the
   * search the engine makes for a model without Tools. `tool` is its name at
   * its `provider` (a Connector's "create_issue"); `input`, what the card
   * shows of the arguments (e.g. a search's `{ query }`; a Connector's, as sent).
   */
  | {
      type: "tool-call-started";
      id: string;
      provider: ToolProviderInfo;
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool-call-finished";
      id: string;
      ok: boolean;
      resultCount: number | null;
      /** A search: the Passages it found, by id. */
      passages?: readonly string[];
      /** A search that failed: why. */
      error?: ProviderError;
    }
  /**
   * The Run read third-party text (#78): a search found a saved web page's
   * Passages. Once per source, before the Tool-call card of the call that read it finishes.
   */
  | { type: "read-third-party"; source: ReadThirdPartySource }
  /** A model call ended, with the tokens its provider counted, the cached ones too. */
  | { type: "usage"; usage: TokenUsage }
  /** The reply claims these changes to a Mind, which none of the Answer's Tool calls made. */
  | { type: "claims-unbacked"; claims: ClaimedChange[] }
  /** The Answer is complete. Nothing follows. */
  | { type: "finished" }
  /** The model or its provider failed. Nothing follows. */
  | { type: "failed"; error: ProviderError };

export interface AnswerEngine {
  /** Streams the Answer to the Question context as events. It never throws: failures are events. */
  generate(request: AnswerRequest): AsyncIterable<AnswerEngineEvent>;
}

export interface AiSdkAnswerEngineOptions {
  /** The most model calls one Answer makes in the Tool-calling loop. The last one must write. */
  maxSteps?: number;
  /** Runs the Tool-calling loop. Defaults to the one on AI SDK 7. */
  runEngine?: RunEngine;
}

/** Model calls per Answer: a few searches, the records, and the Answer, with room to spare. */
const MAX_STEPS = 10;

/**
 * The temperature Answers are written at. Providers default to about 1, which
 * samples freely: a model then tends to paraphrase the quotes of its
 * Citations, and a quote is checked word for word against the pages it cites,
 * so a paraphrase fails the check. A low temperature keeps the model to its
 * likeliest wording, which for a quote is the Passage's own, and keeps the
 * Answer close to the Passages. Not 0, greedy decoding: that makes some
 * models, small local ones especially, repeat themselves in long Answers. (The
 * old CLI used 0, the old backend 0.5.)
 */
export const ANSWER_TEMPERATURE = 0.2;

/**
 * The temperature to send a model, or undefined for one known not to take
 * one: OpenAI's reasoning models and Claude's newest reject it, and Google
 * wants Gemini 3 run at its default (the catalog says which, see
 * ../providers/catalog). A model whose provider refuses it anyway gets the
 * request again without (`generate`).
 */
export function answerTemperature(takesTemperature: boolean | undefined): number | undefined {
  return takesTemperature === false ? undefined : ANSWER_TEMPERATURE;
}

/** The provider refused this way of answering: try the next one. Internal to the engine. */
type Unsupported = { type: "unsupported" };
/** The provider refused the temperature: send the request again without one. Internal to the engine. */
type TemperatureRefused = { type: "temperature-refused" };
/**
 * A local model refused the first request as longer than its window: our
 * estimate was short. `promptTokens`: its real size, when Ollama said, where
 * `estimated` were expected. Internal to the engine.
 */
type Overflow = { type: "overflow"; promptTokens: number | null; estimated: number };
type Attempt = AsyncGenerator<AnswerEngineEvent | Unsupported | TemperatureRefused | Overflow>;
/** An attempt that has dealt with a refused temperature itself. */
type TemperedAttempt = AsyncGenerator<AnswerEngineEvent | Unsupported | Overflow>;
/** An attempt that has dealt with a refused temperature and a too-long first request itself. */
type FittedAttempt = AsyncGenerator<AnswerEngineEvent | Unsupported>;

/** Who provides document search and `cite`: IncarnaMind's own Documents. */
const DOCUMENTS_PROVIDER: ToolProviderInfo = {
  kind: "documents",
  id: "documents",
  name: "Documents",
};

/** "English", "English and Chinese", "English, Chinese and French". */
const listed = (items: readonly string[]) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * The search Tool's description: what it returns, and the languages the
 * Documents are in, with how many are in each. Search finds a query best in
 * a Document's own language (ADR-0009), so a Question in another language is
 * searched in theirs too.
 */
export function searchToolDescription(languages: readonly DocumentLanguage[]): string {
  const base =
    "Search the User's Documents. Returns the Passages that best match, each with an id, its Document, the Document's date when known, and where it is (pages, slides, sections, rows or lines). The search sees only the query, not the conversation: write it to stand on its own.";
  if (languages.length === 0) return base;
  const names = languages.map((each) =>
    languages.length > 1 ? `${each.language} (${each.documents})` : each.language,
  );
  return `${base} The Documents are in ${listed(names)}. Search finds Passages best in their own language: when the Question is in another language than the Documents it may be about, search with the query translated into their language too. Only the query is in their language: write the reply in the Question's.`;
}
/** A Citation marker ("[^1]") or a figure marker ("[=1]"): the Answer is being written. */
const MARKER = /\[[\^=]\d{1,4}\]/;

/**
 * A backstop: a step before the last that has read the Documents and has written this much with no
 * Citation marker in it is a model running on, not an Answer (#1344). The last step may write an
 * Answer with no marker, as it is told no Citation can be recorded then; it is capped instead
 * (src/core/runs/aiSdkEngine.ts).
 */
const RUNAWAY_CHARS = 12_000;

/**
 * What a one-pass attempt yields when its provider refused the request before
 * anything came back: the temperature, if one was sent, or else `feature`;
 * or, for a request sized to a window (`estimated` tokens), that it was too
 * long. Null for any other failure. (The Tool loop's refusals come from its
 * Run engine, as "refused" events.)
 */
function refusalOf(
  error: unknown,
  feature: "structured-output" | null,
  temperature: number | undefined,
  estimated?: number,
): Unsupported | TemperatureRefused | Overflow | null {
  const overflow = estimated === undefined ? null : contextOverflow(error);
  if (overflow && estimated !== undefined) {
    return { type: "overflow", promptTokens: overflow.promptTokens, estimated };
  }
  if (temperature !== undefined && refusesFeature(error, "temperature")) {
    return { type: "temperature-refused" };
  }
  if (feature && refusesFeature(error, feature)) return { type: "unsupported" };
  return null;
}

const calculationsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      marker: {
        type: "integer",
        description:
          "The figure's marker number: 1 for [=1]. Figures are numbered apart from Citations.",
      },
      label: {
        type: "string",
        description: 'What the result is, with its period: "Revenue growth 2025".',
      },
      inputs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "A short name for the formula: rev2024." },
            label: {
              type: "string",
              description: 'What it is, with its year or period: "Revenue 2024".',
            },
            citation: {
              type: "integer",
              description:
                "The marker of a Citation record with the number in its quote: 1 for [^1]. Or give passage, location and quote instead.",
            },
            passage: {
              type: "string",
              description: "Instead of citation: the Passage's id, e.g. P1.",
            },
            location: {
              type: "string",
              description: "With passage: where the quote is, as for a Citation.",
            },
            quote: {
              type: "string",
              description: "With passage: a short quote holding the number, copied word for word.",
            },
            number: {
              type: "string",
              description: 'The number as it is written in the quote: "1.2亿", "$1,482.6 million".',
            },
            position: {
              type: "integer",
              description:
                "Instead of number, when the number is in the quote twice: its place among the quote's numbers, 1 for the first.",
            },
            unitQuote: {
              type: "string",
              description:
                'When the number\'s scale or currency is only in a table\'s heading or caption ("单位：万元", "in millions"): that line, copied word for word from the same Passage.',
            },
            reading: {
              type: "integer",
              description:
                "Only when told the number can be read more than one way: the reading to use, as numbered then.",
            },
            rate: {
              type: "string",
              description:
                'Only for an exchange rate: the currencies it converts, as "CNY per USD".',
            },
          },
          required: ["name"],
        },
      },
      formula: {
        type: "string",
        description:
          "In Excel's syntax, over the inputs' names: (rev2025 - rev2024) / rev2024, SUM(q1, q2, q3, q4), RRI(4, start, end), a > b. A percent is a share, 25% is 0.25: never multiply by 100, give as instead. Inputs are in base units: never multiply or divide by 1000 or 10000 to change the scale, give scale instead.",
      },
      as: {
        type: "string",
        enum: ["number", "percent", "points", "currency", "times", "yes-no"],
        description:
          "How to show the result: percent for a growth rate or a share. Default: from the inputs.",
      },
      decimals: { type: "integer", description: "Decimal places, when the default won't do." },
      scale: {
        type: "string",
        description:
          "Show an amount in this scale: 万, 亿, thousand, million, billion. Inputs are in base units with their page's scale applied, so this, never the formula, sets the scale shown.",
      },
    },
    required: ["marker", "inputs", "formula"],
  },
} as const;

/**
 * In a check Run (#707), each figure also names the number of the sentence it
 * is for, which IncarnaMind compares the result with.
 */
const checkCalculationsSchema = {
  ...calculationsSchema,
  items: {
    ...calculationsSchema.items,
    properties: {
      ...calculationsSchema.items.properties,
      inputs: {
        ...calculationsSchema.items.properties.inputs,
        items: {
          ...calculationsSchema.items.properties.inputs.items,
          properties: {
            ...calculationsSchema.items.properties.inputs.items.properties,
            bracketedCost: {
              type: "boolean",
              description:
                'True when the number is a cost or deduction printed in brackets ("Finance costs (41.2)", "财务费用 (41.2)"), so its size is meant. Never for a loss or another result in brackets.',
            },
          },
        },
      },
      stated: {
        type: "string",
        description: 'The number as the sentence to check writes it: "1.1x", "12%".',
      },
      relation: {
        type: "string",
        enum: ["equals", "at most", "at least"],
        description:
          'How the figure stands to stated: "equals" when stated is the figure; "at most" or "at least" when stated is a limit the sentence says the figure stays within or above ("inside a 3.25x covenant", "不超过3.25倍", "至少5倍").',
      },
    },
    required: [...calculationsSchema.items.required, "stated", "relation"],
  },
} as const;

const recordsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      marker: { type: "integer", description: "The marker's number: 1 for [^1]." },
      passage: {
        type: "string",
        description:
          "The Passage's id, e.g. P1; or, to keep a Citation shown in <mind>, read_mind or an earlier Answer, its id, e.g. C2.",
      },
      location: {
        type: "string",
        description:
          'Where the quote is, as the Passage names it: e.g. "p. 4", "slide 4", "§ 2.1 Sensitivity", "Revenue, rows 12–14" or "lines 120–134". One place, or two in a row.',
      },
      pageFrom: {
        type: "integer",
        description:
          "For a PDF, instead of location: the page the quote starts on. Leave out for other Passages.",
      },
      pageTo: {
        type: "integer",
        description: "For a PDF: the page the quote ends on: the same page, or the next one.",
      },
      quote: {
        type: "string",
        description:
          "A short quote, copied word for word from the Passage. Leave it out for a Citation's id: it keeps its own.",
      },
    },
    required: ["marker", "passage"],
  },
} as const;

/** Records from the model's JSON, kept only where they have the right shape. */
function parseRecords(value: unknown): CitationRecordInput[] {
  // Some models send the array as a JSON string, or one record alone.
  if (typeof value === "string") {
    try {
      return parseRecords(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return parseRecords([value]);
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CitationRecordInput[] => {
    if (typeof item !== "object" || item === null) return [];
    const { marker, passage, location, pageFrom, pageTo, quote } = item as Record<string, unknown>;
    // A marker as the Answer writes it ("[^1]"), or a Passage by its number alone (1), as small models give them.
    const number =
      typeof marker === "string" ? Number(/\d{1,4}/.exec(marker)?.[0] ?? Number.NaN) : marker;
    const named = typeof passage === "number" ? String(passage) : passage;
    if (typeof number !== "number" || typeof named !== "string") return [];
    const page = (value: unknown) =>
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
    return [
      {
        marker: number,
        passage: named,
        ...(typeof location === "string" && location.trim() ? { location } : {}),
        pageFrom: page(pageFrom),
        pageTo: page(pageTo),
        quote: typeof quote === "string" ? quote : "",
      },
    ];
  });
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The JSON a model is writing, parsed as far as it goes, even inside a Markdown code fence. */
const parseAnswerJson = (raw: string) =>
  parsePartialJson(raw.replace(/^\s*```(?:json)?[ \t]*\n?/i, "").replace(/\n?```\s*$/, ""));

/** The longest search query a rewrite may give, in characters: a query, not an Answer. */
const MAX_QUERY_LENGTH = 300;

/** The search query in a model's rewrite: its first line, without its thinking, a label or quotes. */
function queryIn(reply: string): string {
  const line =
    reply
      // An unclosed block was cut off mid-thought.
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
      .split("\n")
      .map((each) => each.trim())
      .find(Boolean) ?? "";
  return line
    .replace(/^(?:search )?query:\s*/i, "")
    .replace(/^["'“”`]+|["'“”`]+$/g, "")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/** The model a call that doesn't write the Answer goes to, with the temperature it gets. */
interface SmallCallModel {
  model: ChatLanguageModel;
  temperature: number | undefined;
}

/** What a call that doesn't write the Answer gave: its text, and the tokens it counted. */
interface SmallCallResult<T> {
  value: T;
  usage: TokenUsage | null;
}

/**
 * The model for the small calls, else the Answer's (see `AnswerRequest.quickModel`).
 * Another model than the Answer's runs at its provider's own temperature.
 */
async function smallCallModel(
  request: AnswerRequest,
  temperature: number | undefined,
): Promise<SmallCallModel> {
  if (request.quickModel) {
    try {
      const quick = await request.quickModel();
      const sameModel =
        quick.provider === request.model.provider && quick.modelId === request.model.modelId;
      return { model: quick, temperature: sameModel ? temperature : undefined };
    } catch (error) {
      if (!request.signal.aborted) {
        console.error(`The quick-tasks model couldn't be used: ${messageOf(error)}`);
      }
    }
  }
  return { model: request.model, temperature };
}

function logEmptySmallCall(
  call: string,
  model: ChatLanguageModel,
  finishReason: string,
  instead: string,
) {
  console.error(
    `The ${call} came back empty from ${model.provider} ${model.modelId} (finish reason: ${finishReason}); ${instead}.`,
  );
}

/**
 * What a model that can't call Tools searches for: the Question, rewritten by
 * the model into one query that stands on its own, from the Question context
 * above it. So "What about its limitations?" searches for what "it" is, as
 * the old CLI's condense step did, but as one query: there is still one
 * search (ADR-0007). With nothing above the Question, the Question is the
 * query; and it is the query when the rewrite fails or comes back empty.
 */
async function searchQuery(
  request: AnswerRequest,
  small: () => Promise<SmallCallModel>,
): Promise<SmallCallResult<string>> {
  const { question, signal } = request;
  const earlier = earlierContext(request.messages, question);
  if (!earlier) return { value: question, usage: null };
  try {
    const { model, temperature } = await small();
    const { text, usage, finishReason } = await generateText({
      model,
      instructions: SEARCH_QUERY_INSTRUCTIONS,
      prompt: searchQueryPrompt(earlier, question),
      temperature,
      // A short query; a cut-off reply falls back to the Question.
      maxOutputTokens: 256,
      // A failure falls back to the Question at once; the Answer's own request still retries.
      maxRetries: 0,
      abortSignal: signal,
    });
    const query = queryIn(text);
    if (!query) {
      logEmptySmallCall(
        "search rewrite",
        model,
        finishReason,
        "searching for the Question as it was asked",
      );
    }
    return { value: query || question, usage: tokenUsageOf(usage) };
  } catch (error) {
    if (!signal.aborted) {
      console.error(`The Question couldn't be rewritten for search: ${messageOf(error)}`);
    }
    return { value: question, usage: null };
  }
}

/** Languages told by their scripts: a Question with none of those scripts isn't in them. */
const SCRIPT_LANGUAGES: ReadonlySet<string> = new Set(["Chinese", "Japanese", "Korean"]);
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The language a model without Tools searches in a second time: the most
 * common language of the Documents that the Question isn't written in, as
 * the search Tool tells a model in the loop to search (`searchToolDescription`,
 * ADR-0009: search finds Passages best in their own language). Null when the
 * Documents are all in the Question's language, or that can't be told. A
 * Question whose language can't be told (a short one, in English, say) is
 * known not to be in a language written in CJK scripts if it has none.
 */
export function searchLanguage(
  question: string,
  languages: readonly DocumentLanguage[],
): string | null {
  const asked = detectLanguage(question);
  const other = languages.find(({ language }) =>
    asked ? language !== asked : SCRIPT_LANGUAGES.has(language) && !CJK_SCRIPT.test(question),
  );
  return other?.language ?? null;
}

/** A Passage in a search's result, as the model reads it, with its id. */
const PASSAGE_BLOCK = /<passage id="([^"]+)"[^>]*>[\s\S]*?<\/passage>/g;

/**
 * Searches' results as one: each Passage once, the first search's first, in
 * the order each gave them, ranked alternately (the first's best, the
 * second's best, then each one's next), so a window too small for all keeps
 * the best of each. With no Passages in any, the first's text.
 */
export function mergeSearches(results: readonly SearchResultForModel[]): SearchResultForModel {
  const passages: { id: string; text: string; rank: number }[] = [];
  results.forEach((result, which) => {
    [...result.text.matchAll(PASSAGE_BLOCK)].forEach((match, index) => {
      const rank = (result.ranks?.[index] ?? index) * results.length + which;
      const seen = passages.find((passage) => passage.id === match[1]);
      if (seen) seen.rank = Math.min(seen.rank, rank);
      else passages.push({ id: match[1] as string, text: match[0], rank });
    });
  });
  const [first] = results;
  if (passages.length === 0 || !first) return first ?? { text: "", passageCount: 0 };
  if (results.length === 1) return first;
  return {
    text: passages.map((passage) => passage.text).join("\n\n"),
    passageCount: passages.length,
    ranks: passages.map((passage) => passage.rank),
  };
}

/**
 * The query translated into `language` by the model, for a second search; null
 * when the translation fails, comes back empty or is the query itself.
 */
async function translatedQuery(
  request: AnswerRequest,
  query: string,
  language: string,
  small: () => Promise<SmallCallModel>,
): Promise<SmallCallResult<string | null>> {
  try {
    const { model, temperature } = await small();
    const { text, usage, finishReason } = await generateText({
      model,
      instructions: TRANSLATE_QUERY_INSTRUCTIONS,
      prompt: translateQueryPrompt(query, language),
      temperature,
      // A short query; a cut-off reply means no second search.
      maxOutputTokens: 256,
      maxRetries: 0,
      abortSignal: request.signal,
    });
    const translated = queryIn(text);
    if (!translated) {
      logEmptySmallCall(
        "search query's translation",
        model,
        finishReason,
        "searching in the Question's language only",
      );
    }
    return {
      value: translated && translated !== query ? translated : null,
      usage: tokenUsageOf(usage),
    };
  } catch (error) {
    if (!request.signal.aborted) {
      console.error(`The search query couldn't be translated: ${messageOf(error)}`);
    }
    return { value: null, usage: null };
  }
}

/**
 * The Answer engine: its Tool-calling loop on a Run engine, and the ways of
 * answering without Tools on the model layer (the Vercel AI SDK).
 */
function createWritingEngine(options: AiSdkAnswerEngineOptions): AnswerEngine {
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const engine = options.runEngine ?? createAiSdkRunEngine();
  /** Models whose provider refused a temperature, by provider and model: they get none. */
  const refusedTemperature = new Set<string>();
  /** What earlier Answers learnt of each local model's tokenizer (see ./window). */
  const tokenFactors = new Map<string, number>();

  return {
    async *generate(asked) {
      // Only an ordinary Answer is offered the Tools the request brings (see `ToolSet`).
      const request: AnswerRequest =
        asked.toolSet && asked.toolSet !== "answer" ? { ...asked, tools: [] } : asked;
      const failed = (error: unknown): AnswerEngineEvent => ({
        type: "failed",
        error: classifyProviderError(error),
      });
      const { signal } = request;
      const modelKey = `${request.model.provider}\n${request.model.modelId}`;
      const temperature = () =>
        refusedTemperature.has(modelKey) ? undefined : answerTemperature(request.takesTemperature);
      const budget = request.window
        ? createWindowBudget(request.window, tokenFactors.get(modelKey), (factor) =>
            tokenFactors.set(modelKey, factor),
          )
        : null;

      /**
       * Runs a way of answering at the Answer temperature, and if the provider
       * refuses it, again without one: the model gets none from then on.
       */
      async function* tempered(run: (temperature: number | undefined) => Attempt): TemperedAttempt {
        const sent = temperature();
        if (sent !== undefined) {
          let refused = false;
          for await (const event of run(sent)) {
            if (event.type === "temperature-refused") {
              refused = true;
              break;
            }
            yield event;
          }
          if (!refused || signal.aborted) return;
          refusedTemperature.add(modelKey);
        }
        for await (const event of run(undefined)) {
          if (event.type !== "temperature-refused") yield event;
        }
      }

      /**
       * Runs a way of answering sized to the window, and if the model refuses
       * its first request as too long after all, once more with the estimate
       * corrected by the model's own count; then the Answer fails as "too-long".
       */
      async function* fitted(make: () => TemperedAttempt): FittedAttempt {
        for (let tries = 0; ; tries++) {
          let overflow: Overflow | null = null;
          for await (const event of make()) {
            if (event.type === "overflow") {
              overflow = event;
              break;
            }
            yield event;
          }
          // Only a request sized to a window can overflow.
          if (!overflow || !budget || signal.aborted) return;
          if (tries === 0 && overflow.promptTokens) {
            budget.learn(overflow.promptTokens, overflow.estimated);
            continue;
          }
          yield { type: "failed", error: budget.tooLong(overflow.promptTokens) };
          return;
        }
      }

      /**
       * A way of answering with the Passages (if any) in its instructions:
       * structured output, or a plain Answer. Within a window, the Passages
       * that fit beside the Question, then the Question context that fits beside them.
       */
      const onePass = (mode: CitationSupport | "no-documents", found?: SearchResultForModel) =>
        fitted(async function* () {
          if (!budget) {
            const instructions = request.instructions(mode, { passages: found?.text });
            yield* tempered((sent) =>
              mode === "structured-output"
                ? structured(request, instructions, sent)
                : plain(request, instructions, sent),
            );
            return;
          }
          const kept =
            found === undefined
              ? undefined
              : budget.fitPassages(
                  found.text,
                  request.instructions(mode, { passages: "" }),
                  request.question,
                  found.ranks,
                );
          const instructions = request.instructions(mode, { passages: kept });
          const fit = budget.fit({
            instructions,
            messages: request.messages,
            question: request.question,
            mind: request.mind,
          });
          if (!fit.ok) {
            yield { type: "failed", error: fit.error };
            return;
          }
          if (fit.mindCut !== undefined) yield { type: "mind-cut", share: fit.mindCut };
          if (fit.documentsDropped) yield { type: "documents-dropped" };
          const sized = { ...request, messages: fit.messages };
          const window: Sized = {
            estimated: fit.estimated,
            learn: (actual) => budget.learn(actual, fit.estimated),
          };
          // A local model's quotes the check doesn't find are asked for once more (see ./quoteRetry).
          const retry = request.retryQuotes ? budget : undefined;
          yield* tempered((sent) =>
            mode === "structured-output"
              ? structured(sized, instructions, sent, window, retry)
              : plain(sized, instructions, sent, window),
          );
        });

      // With no Documents there is nothing to search or cite: Skills and
      // Connector Tools alone, or a plain Answer. Web search saves what it reads as
      // Documents, which are cited, so with it the Documents' Tools are offered too.
      // So are they where the only Documents in scope couldn't be read: the search says so (#485).
      const savesDocuments = request.tools.some((each) => each.provider.kind === "web");
      const hasUnread =
        (request.support ?? "tools") === "tools" &&
        (request.documents.unreadDocuments?.().length ?? 0) > 0;
      if (request.documents.documentCount === 0 && !savesDocuments && !hasUnread) {
        if (request.tools.length > 0 && (request.support ?? "tools") === "tools") {
          let unsupported = false;
          for await (const event of fitted(() =>
            tempered((sent) => toolLoop(request, engine, maxSteps, "no-documents", sent, budget)),
          )) {
            if (event.type === "unsupported") {
              unsupported = true;
              break;
            }
            yield event;
          }
          if (!unsupported || signal.aborted) return;
        }
        for await (const event of onePass("no-documents")) {
          if (event.type === "unsupported") return;
          yield event;
        }
        return;
      }

      // A model without Tools searches once, for the Question rewritten to stand on its own, and
      // again in the Documents' language if the Question is in another (see `searchLanguage`); the
      // result is kept for the next way of answering if the provider refuses this one.
      let searched: SearchResultForModel | undefined;
      async function* searchOnce(): AsyncGenerator<AnswerEngineEvent, SearchResultForModel> {
        if (searched !== undefined) return searched;
        // The quick-tasks model is asked for once, and only if a call needs it.
        let small: Promise<SmallCallModel> | undefined;
        const smallModel = () => {
          small ??= smallCallModel(request, temperature());
          return small;
        };
        const rewrite = await inStep("search-rewrite", () => searchQuery(request, smallModel));
        if (rewrite.usage) yield { type: "usage", usage: rewrite.usage };
        const query = rewrite.value;
        signal.throwIfAborted();
        const language = searchLanguage(
          request.question,
          request.documents.documentLanguages ?? [],
        );
        const translation = language
          ? await inStep("search-translation", () =>
              translatedQuery(request, query, language, smallModel),
            )
          : null;
        if (translation?.usage) yield { type: "usage", usage: translation.usage };
        const translated = translation?.value ?? null;
        signal.throwIfAborted();
        const searches: [string, string][] = [
          ["question-search", query],
          ...(translated ? [["question-search-translated", translated] as [string, string]] : []),
        ];
        yield { type: "phase", phase: "searching" };
        const results: SearchResultForModel[] = [];
        const read = new Set<ReadThirdPartySource>();
        for (const [id, each] of searches) {
          yield {
            type: "tool-call-started",
            id,
            provider: DOCUMENTS_PROVIDER,
            tool: DOCUMENT_TOOLS.search,
            input: { query: each },
          };
          try {
            const result = await request.documents.searchDocuments(each, signal, {
              parameters: ONE_SEARCH_PARAMETERS,
            });
            for (const source of result.thirdParty ?? []) {
              if (read.has(source)) continue;
              read.add(source);
              yield { type: "read-third-party", source };
            }
            yield {
              type: "tool-call-finished",
              id,
              ok: true,
              resultCount: result.passageCount,
              ...(result.passageIds && { passages: result.passageIds }),
            };
            results.push(result);
          } catch (error) {
            if (signal.aborted) throw error;
            console.error(error);
            yield {
              type: "tool-call-finished",
              id,
              ok: false,
              resultCount: null,
              error: classifyProviderError(error),
            };
          }
        }
        searched =
          results.length > 0
            ? mergeSearches(results)
            : { text: "The search of the User's Documents failed.", passageCount: 0 };
        yield { type: "phase", phase: "writing" };
        return searched;
      }

      // Structured output isn't tried for a model known to give none, unless it is where to start
      // (an earlier Answer found it works).
      const order = (["tools", "structured-output", "none"] as const).filter(
        (each) =>
          each !== "structured-output" ||
          request.structuredOutput !== false ||
          request.support === each,
      );
      const start = order.indexOf(request.support ?? "tools");
      for (let mode = start; mode < order.length; mode++) {
        const support = order[mode] as CitationSupport;
        let attempt: FittedAttempt;
        try {
          if (support === "tools") {
            attempt = fitted(() =>
              tempered((sent) => toolLoop(request, engine, maxSteps, "tools", sent, budget)),
            );
          } else {
            const found: SearchResultForModel = yield* searchOnce();
            if (signal.aborted) return;
            attempt = onePass(support, found);
          }
        } catch (error) {
          if (signal.aborted) return;
          yield failed(error);
          return;
        }
        let announced = false;
        let unsupported = false;
        for await (const event of attempt) {
          if (event.type === "unsupported") {
            unsupported = true;
            break;
          }
          if (!announced && event.type !== "failed") {
            announced = true;
            yield { type: "support", support };
          }
          yield event;
        }
        if (!unsupported || signal.aborted) return;
      }
    },
  };
}

/**
 * Passes on an Answer's events, but an Answer that finishes with no text
 * fails as "no-answer" instead, unless `mayEndBlank`: a reply that ended
 * empty, or whose stream held nothing the provider could read, would
 * otherwise be a blank Answer.
 */
async function* endedBlank(
  events: AsyncIterable<AnswerEngineEvent>,
  request: AnswerRequest,
): AsyncGenerator<AnswerEngineEvent> {
  const { model } = request;
  let text = "";
  for await (const event of events) {
    if (event.type === "text-delta") text += event.text;
    else if (event.type === "text-retracted") text = text.slice(0, -event.length);
    if (event.type === "finished" && text.trim() === "" && !request.mayEndBlank?.()) {
      console.warn(`The model sent no Answer: provider=${model.provider} model=${model.modelId}`);
      yield { type: "failed", error: { kind: "no-answer", message: "The model sent no Answer." } };
      return;
    }
    yield event;
  }
}

export function createAiSdkAnswerEngine(options: AiSdkAnswerEngineOptions = {}): AnswerEngine {
  const writer = createWritingEngine(options);
  return { generate: (request) => endedBlank(writer.generate(request), request) };
}

/** What one go of the Tool-calling loop keeps of its calls of the Documents' Tools. */
interface DocumentToolsHooks {
  /** A search's result as the model gets it: within a window, the Passages that fit (see ./window). */
  fit(found: SearchResultForModel): SearchResultForModel;
  /** A search gave the model `count` Passages, of those it found (`passageIds`): its Tool-call card says so. */
  searched(toolCallId: string, count: number, passageIds?: readonly string[]): void;
  /** A search failed: its card says why. */
  failed?(toolCallId: string, error: unknown): void;
  /** The model gave these records: the engine places their markers if it leaves them out. */
  cited(records: readonly CitationRecordInput[]): void;
  /** What to say of the Answer's language after a search's Passages, if anything, asked for each search. */
  languageNote?(): string | null;
}

/**
 * The Documents as a Tool provider, for one go of the Tool-calling loop:
 * `search_documents`, which reads the Documents; `cite`, whose records become
 * this Answer's Citations; and `calculate`, whose figures become its
 * calculated figures (ADR-0021), when the Answer takes them. The last two
 * reach nothing beyond the Answer.
 */
export function documentTools(
  documents: AnswerTools,
  hooks: DocumentToolsHooks,
  toolSet: ToolSet = "answer",
): { search: Tool; cite: Tool; calculate: Tool | null } {
  const own = (name: string) => ({ name, provider: DOCUMENTS_PROVIDER, providerTool: name });
  const checking = toolSet === "check";
  return {
    search: {
      ...own(DOCUMENT_TOOLS.search),
      description: searchToolDescription(documents.documentLanguages ?? []),
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to look for: words likely to be in the Passages, in their language. Name what the Question refers to instead of pronouns or words that point back, such as "it", "they" or "that paper".',
          },
          document: {
            type: "string",
            description:
              "Search only this Document, named as the instructions list it: to find what each of several Documents says.",
          },
        },
        required: ["query"],
      },
      shownInput: ({ query, document }) => ({
        query: String(query ?? ""),
        ...(typeof document === "string" && document !== "" && { document }),
      }),
      effects: () => [{ action: "read", scope: { kind: "documents" } }],
      // The User didn't write their Documents.
      untrustedResult: true,
      async call({ query, document }, { toolCallId, signal, readThirdParty }) {
        let found: SearchResultForModel;
        try {
          found = await documents.searchDocuments(String(query ?? ""), signal, {
            rerank: false,
            ...(typeof document === "string" && document !== "" && { document }),
          });
        } catch (error) {
          // A failed search is the app's problem, so it is logged; the model is told it failed.
          if (!signal.aborted) {
            console.error(error);
            hooks.failed?.(toolCallId, error);
          }
          throw error;
        }
        for (const source of found.thirdParty ?? []) readThirdParty?.(source);
        const result = hooks.fit(found);
        hooks.searched(toolCallId, result.passageCount, found.passageIds);
        // The dates are named from the Passages that fit, so never a Document the model wasn't handed.
        const passages = withPassageNotes(
          result.text,
          documents.unreadDocuments?.() ?? [],
          documents.readingDocuments?.() ?? [],
        );
        const note = hooks.languageNote?.();
        return note ? `${passages}\n\n${note}` : passages;
      },
    },
    cite: {
      ...own(DOCUMENT_TOOLS.cite),
      description:
        "Record the Citations of your Answer: for each marker such as [^1], the Passage, where its quote is (a page, slide, section, or rows or lines, or two in a row), and a short quote copied word for word from the Passage. To keep a Citation already shown with an id, like [Tides, p. 3 · C2], give its id as the passage instead.",
      inputSchema: {
        type: "object",
        properties: { citations: recordsSchema },
        required: ["citations"],
      },
      effects: () => [],
      untrustedResult: false,
      async call({ citations }) {
        const records = parseRecords(citations);
        hooks.cited(records);
        return documents.cite(records);
      },
    },
    calculate: documents.calculate
      ? {
          ...own(DOCUMENT_TOOLS.calculate),
          description: `Work out a number from numbers in the Passages instead of in your head, and get its result back. Give figures, each {marker, label, inputs, formula, as}. Each input is {name, label, citation, number}: citation is the marker of a cite record whose quote has the number (1 for [^1]), or give passage, location and quote instead; number is the number as it is written there. The formula is in Excel's syntax over the inputs' names. For example: {"figures": [{"marker": 1, "label": "Revenue growth 2025", "inputs": [{"name": "r24", "label": "Revenue 2024", "citation": 1, "number": "$1,231.0 million"}, {"name": "r25", "label": "Revenue 2025", "citation": 1, "number": "$1,482.6 million"}], "formula": "r25 / r24 - 1", "as": "percent"}]}. IncarnaMind reads each number from its quote, checks the quote and does the arithmetic. Inputs are read in base units with their page's scale ("单位：万元", "in millions") applied, so give scale ("亿", "billion") for the scale a figure is shown in, never multiply or divide by 1000 or 10000 in the formula. An input keeps its sign as the Passage writes it: an amount in brackets, "(12,500)", is negative, so take a deduction off by adding it, never by subtracting it. ${
            checking
              ? 'Give stated, the number as the sentence to check writes it: IncarnaMind compares the result with it. When that number is a limit the sentence says the figure stays within or above ("leverage inside the 3.25x covenant"), give relation "at most" or "at least".'
              : "Write the figure's marker, such as [=1], in the number's place; never write the number yourself."
          }`,
          inputSchema: {
            type: "object",
            properties: { figures: checking ? checkCalculationsSchema : calculationsSchema },
            required: ["figures"],
          },
          effects: () => [],
          // Numbers, and IncarnaMind's own words.
          untrustedResult: false,
          async call({ figures }) {
            return documents.calculate?.(givenList(figures)) ?? "";
          },
        }
      : null,
  };
}

/** What a call the gate lets through gets: it runs. */
const RUN: GateDecision = { run: true };

/** Messages of Question context as the AI SDK takes them, a stable start marked for the prompt cache. */
const modelMessages = (messages: readonly AnswerMessage[]): ModelMessage[] =>
  messages.map(({ role, content, stablePrefix }) =>
    role === "user" && stablePrefix
      ? { role, content, providerOptions: stablePrefixOptions(stablePrefix) }
      : { role, content },
  );

/** A message of Question context as a Run's. */
const runMessage = (message: AnswerMessage): RunMessage =>
  message.role === "user"
    ? {
        role: "user",
        text: message.content,
        ...(message.stablePrefix && { stablePrefix: message.stablePrefix }),
      }
    : { role: "assistant", text: message.content, toolCalls: [] };

/**
 * The Tools' definitions as the window's estimate counts them: by name, each
 * with its description and JSON Schema (written out as the AI SDK's `ToolSet`
 * was before the Run engine, so requests are sized as they were).
 */
const definitions = (tools: readonly Tool[]) =>
  JSON.stringify(
    Object.fromEntries(
      tools.map((each) => [
        each.name,
        { description: each.description, inputSchema: { jsonSchema: each.inputSchema } },
      ]),
    ),
  );

/**
 * The Tool-calling loop, on a Run engine (see ../runs/engine): search, cite,
 * answer; with Skills, load them as needed; with Connectors, call their Tools
 * where they help. "no-documents": the Skill and Connector Tools alone, with
 * nothing to cite. Within a window, its requests are kept within it (see
 * ./window). A request the provider refused is the engine's "refused" event;
 * what to try next is `generate`'s.
 */
async function* toolLoop(
  request: AnswerRequest,
  engine: RunEngine,
  maxSteps: number,
  mode: "tools" | "no-documents",
  temperature: number | undefined,
  budget: WindowBudget | null = null,
): Attempt {
  const { signal } = request;
  /** Passages each search gave, by Tool call. */
  const results = new Map<string, number>();
  /** The Passages each search found, by Tool call, by id. */
  const found = new Map<string, readonly string[]>();
  /** Why each search that failed did, by Tool call. */
  const failures = new Map<string, ProviderError>();
  /** The records the model gave, in order. */
  const cited: CitationRecordInput[] = [];
  /** The account of the window, once the first request is sized. */
  let loop: ReturnType<WindowBudget["loop"]> | null = null;
  // The Documents' Tools fit what they return themselves: a search's Passages, and records take no room.
  const documents =
    mode === "tools"
      ? documentTools(
          request.documents,
          {
            fit: (found) =>
              loop ? loop.passages(found.text, found.passageCount, found.ranks) : found,
            searched: (toolCallId, count, passageIds) => {
              results.set(toolCallId, count);
              if (passageIds) found.set(toolCallId, passageIds);
            },
            failed: (toolCallId, error) => failures.set(toolCallId, classifyProviderError(error)),
            cited: (records) => cited.push(...records),
            ...(request.languageNote && { languageNote: request.languageNote }),
          },
          request.toolSet,
        )
      : null;
  const search = documents?.search ?? null;
  const cite = documents?.cite ?? null;
  const calculate = documents?.calculate ?? null;
  /** `cite` and `calculate` record something for the Answer: they have no Tool-call card. */
  const recording = (tool: Tool | undefined): boolean =>
    tool !== undefined && (tool === cite || tool === calculate);
  /**
   * Whether this Run has read untrusted content: from the first call of a
   * Tool with `untrustedResult` that returned some, each call's gate is told.
   */
  let tainted = false;
  /**
   * Why this Run counts as having read third-party text: what it started
   * with, then what its Tools read, each once; each call's gate is told.
   */
  const thirdParty: ThirdPartyReason[] = [...(request.thirdParty ?? [])];
  /** What the Tools read since the last event: the Answer hears of it with the call's result. */
  const unannounced: ReadThirdPartySource[] = [];
  const readThirdParty = (source: ReadThirdPartySource) => {
    if (thirdParty.some((each) => each.via === "read" && each.source === source)) return;
    thirdParty.push({ via: "read", source });
    unannounced.push(source);
  };
  /** Whether the reply of `cite` or `calculate` to each call asked the model to fix what it gave, by the call's id. */
  const askedForFixes = new Map<string, boolean>();
  const writesMinds = request.tools.some((each) => each.provider.kind === "minds");
  /**
   * A Tool as the engine calls it: one with untrusted results taints the Run
   * once it returns some; one that counts what it found (Find sources) says
   * so for its card; one that read third-party text says so.
   */
  const tracked = (tool: Tool): Tool => ({
    ...tool,
    async call(input, context) {
      const result = await tool.call(input, {
        ...context,
        counted: (count) => results.set(context.toolCallId, count),
        readThirdParty,
      });
      // A search that found nothing (no Passages, no works) read nothing untrusted.
      const read = results.has(context.toolCallId)
        ? (results.get(context.toolCallId) ?? 0) > 0
        : result.trim() !== "";
      if (tool.untrustedResult && read) tainted = true;
      if (tool === cite) {
        askedForFixes.set(context.toolCallId, asksForFixes(result));
        // Records for text a Mind will hold come first; an Answer's come with its text (#489).
        if (request.writeThenCite && !writesMinds && !MARKER.test(keptText + stepText)) {
          return result.replace(WRITE_NOW, NOTHING_SHOWN_YET);
        }
      }
      if (tool === calculate) askedForFixes.set(context.toolCallId, asksForFigureFixes(result));
      return result;
    },
  });
  /** The Tools offered, by the name the model calls them; never a Connector's with one of ours. */
  const offered = new Map(
    offeredTools([
      ...(documents ? [documents.search, documents.cite] : []),
      ...(calculate ? [calculate] : []),
      ...request.tools,
    ]).map((each) => [each.name, each]),
  );
  const tools = [...offered.values()];
  const instructions = request.instructions(mode, {
    skillTools: request.tools.some((each) => each.provider.kind === "skills"),
    connectorTools: tools.some((each) => each.provider.kind === "connector"),
    sourceTools: tools.some((each) => each.provider.kind === "sources"),
    webTools: tools.some((each) => each.provider.kind === "web"),
    mindTools: tools.some((each) => each.provider.kind === "minds"),
    commandTools: tools.some((each) => each.provider.kind === "commands"),
  });

  // Within a window: the Question context that fits beside the instructions, the Tools and a search.
  let messages =
    request.mindsLine && tools.some((each) => each.provider.kind === "minds")
      ? withLineBefore(
          request.messages,
          request.mindsLine.line,
          request.mindsLine.asked,
          request.question,
        )
      : request.messages;
  let estimated: number | undefined;
  let window: RunWindow | undefined;
  if (budget) {
    const fit = budget.fit({
      instructions,
      messages,
      question: request.question,
      tools: definitions(tools),
      reserve: SEARCH_RESERVE_TOKENS,
      mind: request.mind,
    });
    if (!fit.ok) {
      yield { type: "failed", error: fit.error };
      return;
    }
    if (fit.mindCut !== undefined) yield { type: "mind-cut", share: fit.mindCut };
    if (fit.documentsDropped) yield { type: "documents-dropped" };
    ({ messages, estimated } = fit);
    const account = budget.loop(fit.estimated);
    loop = account;
    window = {
      // What another provider's Tool returns (or the gate gives instead) is cut to the room left.
      fitResult: (text, tool) =>
        tool === search?.name || tool === cite?.name || tool === calculate?.name
          ? text
          : account.result(text),
      canCallTools: () => account.canCallTools(),
      stepFinished: ({ inputTokens, outputTokens }) =>
        account.stepFinished({ inputTokens, outputTokens }),
    };
  }

  /** Text of the current step, and of every step before it that was kept. */
  let stepText = "";
  let keptText = "";
  /** The Tools the current step called. */
  let stepTools: Tool[] = [];
  /** An earlier step wrote the Answer and recorded its Citations: text with markers after that is a second copy. */
  let answered = false;
  /** As the Run engine ends steps: a step wrote marked text beside `cite` or `calculate` alone. */
  let writtenBesideRecords = false;
  /**
   * Texts written beside `cite` or `calculate` alone, with no marker in them,
   * and taken back: the last is the Answer if the model never writes another,
   * and a check whose reply has no verdict reads it from those written after
   * a search.
   */
  let setAside: { text: string; searched: boolean }[] = [];
  /** The Tool of each call, by its id. */
  const calls = new Map<string, Tool>();
  /** Searches running now: the Answer is "searching" while there are any. */
  let searching = 0;
  let searched = false;
  const rambling = new AbortController();
  /** The reply that stands if the model, asked once more, fails: as it was before the last ask. */
  let standing: string | null = null;
  let again: readonly RunMessage[] | null = null;
  /** Model calls made so far: asked once more, the model gets what is left of `maxSteps`. */
  let steps = 0;
  const nudges = createNudges(maxSteps, () => steps);
  /** How much of `keptText + stepText` the Answer shows: a claim of a change waits until it is checked. */
  let released = 0;
  function* release(upTo: number): Generator<AnswerEngineEvent> {
    const text = keptText + stepText;
    const end = Math.min(upTo, text.length);
    if (end <= released) return;
    yield { type: "text-delta", text: text.slice(released, end) };
    released = end;
  }
  const toolTextTags = [...new Set([...TOOL_TEXT_TAGS, ...offered.keys()])];
  const releasable = (text: string) =>
    Math.min(request.shownUpTo?.(text) ?? text.length, heldBackFrom(text, toolTextTags));
  function* flag(text: string): Generator<AnswerEngineEvent> {
    const claims = claimsOf(request.turnChecks ?? [], text);
    if (claims.length > 0) yield { type: "claims-unbacked", claims };
  }
  function* backToFirst(written: string): Generator<AnswerEngineEvent> {
    if (released > 0) yield { type: "text-retracted", length: released };
    released = 0;
    keptText = written;
    stepText = "";
    yield* release(keptText.length);
    yield* flag(keptText);
  }
  async function* endAnswer(): AsyncGenerator<AnswerEngineEvent> {
    if (!request.documents.wroteIntoMind?.()) {
      const figured = request.documents.citeFigures?.(keptText) ?? keptText;
      yield* textEdits(keptText, figured);
      keptText = figured;
      const placed = yield* missingMarkerEvents(keptText, cited, request.documents);
      yield* citeUnmarked(request, placed, temperature, budget, () =>
        nudges.take("unmarked-quotes"),
      );
    }
    yield { type: "finished" };
  }
  const runTools = tools.map(tracked);
  async function* runs(): AsyncGenerator<RunEvent> {
    let history: readonly RunMessage[] = messages.map(runMessage);
    for (;;) {
      yield* engine.run(runRequest(history, maxSteps - steps));
      if (!again) return;
      history = [...history, ...again];
      again = null;
    }
  }
  const runRequest = (history: readonly RunMessage[], stepsLeft: number): RunRequest => ({
    model: request.model,
    instructions,
    messages: history,
    tools: runTools,
    maxSteps: stepsLeft,
    cacheKey: request.cacheKey,
    lastStep: {
      ...(request.maxOutput !== undefined && { tokens: request.maxOutput }),
      ...(request.toolsEveryRequest && { keepTools: true }),
    },
    gate: async (call) => {
      const tool = offered.get(call.tool);
      return tool && request.gate
        ? request.gate(tool, { ...call, tainted, thirdParty: [...thirdParty] })
        : RUN;
    },
    streamsInput: (name) => {
      const tool = offered.get(name);
      return tool !== undefined && (request.streamsInput?.(tool) ?? false);
    },
    window,
    // The Answer written beside `cite` or `calculate`, with all they were given taken, is complete:
    // another call would only write it again. So is one whose records a later step fixed.
    endsAfter: (step) => {
      const recordsOnly =
        step.calls.length > 0 && step.calls.every((call) => recording(offered.get(call.tool)));
      writtenBesideRecords ||= recordsOnly && MARKER.test(step.text);
      return (
        cite !== null &&
        writtenBesideRecords &&
        recordsOnly &&
        step.calls.every((call) => askedForFixes.get(call.id) === false)
      );
    },
    temperature,
    signal: AbortSignal.any([signal, rambling.signal]),
  });
  for await (const event of runs()) {
    if (signal.aborted) return;
    if (rambling.signal.aborted) continue;
    switch (event.type) {
      case "reasoning":
        yield event;
        break;
      case "text-delta": {
        let { text } = event;
        // A new step's text goes on from the last kept text in a new paragraph.
        if (stepText === "" && keptText !== "" && !/\s$/.test(keptText)) text = `\n\n${text}`;
        stepText += text;
        if (
          searched &&
          steps < maxSteps - 1 &&
          stepText.length > RUNAWAY_CHARS &&
          !MARKER.test(stepText)
        ) {
          rambling.abort();
          break;
        }
        yield* release(releasable(keptText + stepText));
        break;
      }
      case "tool-input-started": {
        // A Tool that writes as its input comes (the Minds'): its card shows from the start.
        const called = offered.get(event.tool);
        if (!called || recording(called)) break;
        yield {
          type: "tool-call-started",
          id: event.id,
          provider: called.provider,
          tool: called.providerTool,
          input: {},
        };
        break;
      }
      case "tool-call": {
        const called = offered.get(event.tool);
        if (!called) break;
        calls.set(event.id, called);
        stepTools.push(called);
        if (called === search) searched = true;
        if (called === search && searching++ === 0) {
          yield { type: "phase", phase: "searching" };
        }
        // Every call has a Tool-call card but those of `cite` and `calculate`: what they record
        // becomes the Answer's Citations and figures.
        if (!recording(called)) {
          yield {
            type: "tool-call-started",
            id: event.id,
            provider: called.provider,
            tool: called.providerTool,
            input: called.shownInput ? called.shownInput(event.input) : event.input,
          };
        }
        break;
      }
      case "tool-result": {
        for (const source of unannounced.splice(0)) yield { type: "read-third-party", source };
        // A failed call (a Skill or file that isn't there, a Connector's failure or a declined
        // consent) is told to the model; its card says it failed.
        const called = calls.get(event.id);
        if (called && !recording(called)) {
          const passages = found.get(event.id);
          const error = failures.get(event.id);
          yield {
            type: "tool-call-finished",
            id: event.id,
            ok: event.ok,
            resultCount: results.get(event.id) ?? null,
            ...(passages && { passages }),
            ...(error && { error }),
          };
        }
        if (called === search && --searching === 0) {
          yield { type: "phase", phase: "writing" };
        }
        break;
      }
      case "step-finished": {
        steps++;
        yield { type: "usage", usage: event.usage };
        // Text before a call with a Tool-call card (a search, a Skill, a Connector's Tool), or
        // before records or figures with no marker in it, was a preamble.
        const recorded = stepTools.some(recording);
        const preamble =
          stepTools.some((each) => !recording(each)) || (recorded && !MARKER.test(stepText));
        // After `cite` or `calculate` asked for fixes to an Answer written beside it, the model
        // writes the Answer again.
        const again = answered && MARKER.test(stepText);
        if ((preamble || again) && stepText) {
          const shown = released - keptText.length;
          if (shown > 0) yield { type: "text-retracted", length: shown };
          released = Math.min(released, keptText.length);
          if (recorded && !stepTools.some((each) => !recording(each)) && !again)
            setAside.push({ text: stepText, searched });
        } else {
          keptText += stepText;
          if (recorded && MARKER.test(stepText)) answered = true;
        }
        stepText = "";
        stepTools = [];
        break;
      }
      case "refused":
        // Asked once more, the reply before stands: trying another way now would call its Tools again.
        if (standing !== null) {
          yield* backToFirst(standing);
          yield* endAnswer();
          return;
        }
        // Too long only with a window, so sized to one.
        yield event.what === "tools"
          ? { type: "unsupported" }
          : event.what === "temperature"
            ? { type: "temperature-refused" }
            : {
                type: "overflow",
                promptTokens: event.promptTokens ?? null,
                estimated: estimated ?? 0,
              };
        return;
      case "failed":
        for (const source of unannounced.splice(0)) yield { type: "read-third-party", source };
        if (standing !== null) {
          console.error(`Asking again for a better reply failed: ${event.error.message}`);
          yield* backToFirst(standing);
          yield* endAnswer();
          return;
        }
        yield { type: "failed", error: event.error };
        return;
      case "finished": {
        if (keptText.trim() === "" && (setAside.at(-1)?.text ?? "").trim() !== "")
          keptText = setAside.pop()?.text ?? "";
        const taken = takeToolText(keptText, toolTextTags);
        if (mode === "tools" && !request.documents.wroteIntoMind?.()) {
          const records = parseRecords(taken.records).filter(
            ({ marker }) => !request.documents.hasRecord?.(marker),
          );
          cited.push(...records);
          try {
            request.documents.cite(records, { structured: true });
          } catch (error) {
            console.error(
              `The Citations written as text couldn't be recorded: ${messageOf(error)}`,
            );
          }
        }
        const settled = settleReply(request.turnChecks ?? [], taken.text, nudges);
        if ("nudge" in settled) {
          standing = taken.text;
          if (released > 0) yield { type: "text-retracted", length: released };
          released = 0;
          keptText = "";
          stepText = "";
          answered = false;
          writtenBesideRecords = false;
          setAside = [];
          again = [...event.messages, { role: "user", text: settled.nudge }];
          break;
        }
        const afterSearch = setAside.filter((each) => each.searched).map((each) => each.text);
        if (afterSearch.length > 0) yield { type: "text-set-aside", texts: afterSearch };
        if (taken.text !== keptText) {
          yield* textEdits(keptText.slice(0, released), taken.text);
          keptText = taken.text;
          released = keptText.length;
        }
        yield* release(keptText.length);
        if (settled.claims.length > 0) yield { type: "claims-unbacked", claims: settled.claims };
        yield* endAnswer();
        return;
      }
    }
  }
  if (rambling.signal.aborted && !signal.aborted) {
    if (released > 0) yield { type: "text-retracted", length: released };
    yield {
      type: "failed",
      error: { kind: "no-answer", message: "The model ran on without an Answer." },
    };
  }
}

/**
 * A request sized to a window: its estimated tokens, and what to learn from
 * the model's own count of it (see ./window).
 */
interface Sized {
  estimated: number;
  learn(actual: number): void;
}

/**
 * The Answer and its records as one JSON object, streamed: its `answer` text
 * as it grows. With a local model's window (`budget`), the quotes the check
 * doesn't find are then asked for once more (see ./quoteRetry); never for a
 * cloud model.
 */
async function* structured(
  request: AnswerRequest,
  instructions: string,
  temperature: number | undefined,
  sized?: Sized,
  budget?: WindowBudget,
): Attempt {
  const { signal } = request;
  const result = streamText({
    model: request.model,
    instructions,
    messages: modelMessages(request.messages),
    temperature,
    providerOptions: cacheProviderOptions(request.cacheKey),
    output: Output.object({
      schema: jsonSchema<{ answer: string; citations: unknown; calculations?: unknown }>({
        type: "object",
        properties: {
          answer: {
            type: "string",
            description: "The Answer, in Markdown, with Citation markers and figure markers.",
          },
          // A small local model leaves out what its schema doesn't require: a record needs its quote here.
          citations: {
            ...recordsSchema,
            items: { ...recordsSchema.items, required: [...recordsSchema.items.required, "quote"] },
          },
          ...(request.documents.calculate && { calculations: calculationsSchema }),
        },
        required: ["answer", "citations"],
      }),
      name: "answer",
    }),
    abortSignal: signal,
    onError: () => undefined,
  });

  let raw = "";
  let emitted = "";
  const reasoning = reasoningReader();
  const emit = function* (value: unknown): Generator<AnswerEngineEvent> {
    if (typeof value !== "string" || value === emitted) return;
    yield* textEdits(emitted, value);
    emitted = value;
  };
  const estimated = sized?.estimated;
  try {
    for await (const part of result.fullStream) {
      if (signal.aborted || part.type === "abort") return;
      if (part.type === "reasoning-start" || part.type === "reasoning-delta") {
        const event = reasoning(part);
        if (event) yield event;
      } else if (part.type === "text-delta") {
        raw += part.text;
        const { value } = await parseAnswerJson(raw);
        yield* emit((value as { answer?: unknown } | undefined)?.answer);
      } else if (part.type === "finish-step") {
        yield { type: "usage", usage: tokenUsageOf(part.usage) };
        if (part.usage.inputTokens) sized?.learn(part.usage.inputTokens);
      } else if (part.type === "error") {
        const refused = emitted
          ? null
          : refusalOf(part.error, "structured-output", temperature, estimated);
        yield refused ?? { type: "failed", error: classifyProviderError(part.error) };
        return;
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    const refused = emitted ? null : refusalOf(error, "structured-output", temperature, estimated);
    yield refused ?? { type: "failed", error: classifyProviderError(error) };
    return;
  }
  if (signal.aborted) return;
  const { value } = await parseAnswerJson(raw);
  const answer = (value as { answer?: unknown } | undefined)?.answer;
  // The model didn't answer in JSON after all: it can't do structured output.
  if (typeof answer !== "string" && !emitted) {
    yield { type: "unsupported" };
    return;
  }
  const records = parseRecords((value as { citations?: unknown } | undefined)?.citations);
  try {
    // The answer is written: what `cite` would tell the model can't reach it. It places the records instead.
    request.documents.cite(records, { structured: true });
  } catch (error) {
    console.error(`The Citations couldn't be recorded: ${messageOf(error)}`);
  }
  yield* emit(typeof answer === "string" ? takeToolText(answer).text : answer);
  if (typeof answer === "string") {
    // A small model often gives the records but leaves their markers out.
    const marked = yield* missingMarkerEvents(emitted, records, request.documents);
    if (budget) yield* retryQuotes(request, marked, temperature, budget);
    if (signal.aborted) return;
    const placed = yield* citeUnmarked(request, marked, temperature, budget);
    if (signal.aborted) return;
    // Worked out once the quotes are as good as they will be, since figures read their numbers there.
    const calculations = givenList((value as { calculations?: unknown } | undefined)?.calculations);
    if (calculations.length > 0 && request.documents.calculate) {
      try {
        request.documents.calculate(calculations, { structured: true });
      } catch (error) {
        console.error(`The figures couldn't be worked out: ${messageOf(error)}`);
      }
      if (budget) yield* retryFigures(request, placed, temperature, budget);
      if (signal.aborted) return;
      yield* textEdits(placed, request.documents.citeFigures?.(placed) ?? placed);
    }
  }
  yield* flagClaims(request, emitted);
  yield { type: "finished" };
}

function* flagClaims(request: AnswerRequest, text: string): Generator<AnswerEngineEvent> {
  const claims = claimsOf(request.turnChecks ?? [], text);
  if (claims.length > 0) yield { type: "claims-unbacked", claims };
}

/** A plain streamed Answer, with no Tools and no Citations. */
async function* plain(
  request: AnswerRequest,
  instructions: string,
  temperature: number | undefined,
  sized?: Sized,
): Attempt {
  const { signal } = request;
  const estimated = sized?.estimated;
  let produced = "";
  const reasoning = reasoningReader();
  try {
    const result = streamText({
      model: request.model,
      instructions,
      messages: modelMessages(request.messages),
      temperature,
      providerOptions: cacheProviderOptions(request.cacheKey),
      abortSignal: signal,
      onError: () => undefined,
    });
    for await (const part of result.fullStream) {
      if (signal.aborted || part.type === "abort") return;
      if (part.type === "reasoning-start" || part.type === "reasoning-delta") {
        const event = reasoning(part);
        if (event) yield event;
      } else if (part.type === "text-delta") {
        if (!part.text) continue;
        produced += part.text;
        yield { type: "text-delta", text: part.text };
      } else if (part.type === "finish-step") {
        yield { type: "usage", usage: tokenUsageOf(part.usage) };
        if (part.usage.inputTokens) sized?.learn(part.usage.inputTokens);
      } else if (part.type === "error") {
        const refused = produced ? null : refusalOf(part.error, null, temperature, estimated);
        yield refused ?? { type: "failed", error: classifyProviderError(part.error) };
        return;
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    const refused = produced ? null : refusalOf(error, null, temperature, estimated);
    yield refused ?? { type: "failed", error: classifyProviderError(error) };
    return;
  }
  if (signal.aborted) return;
  const written = takeToolText(produced).text;
  yield* textEdits(produced, written);
  yield* flagClaims(request, written);
  yield { type: "finished" };
}
