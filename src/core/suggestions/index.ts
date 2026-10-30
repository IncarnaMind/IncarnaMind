/**
 * Suggest as I write (#282): at a pause at the end of a paragraph, how it may
 * go on, from the User's Documents and always with a checked Citation; when
 * nothing in them backs a way on, nothing.
 *
 * 1. The end of the paragraph is searched as an Answer's Question is (see
 *    ../answers/citing), in the composer's Search scope.
 * 2. Unless the best Passage is a strong match (`isStrongMatch`: as the
 *    reranker judges it, or by the words it shares), it stops there: no request.
 * 3. The default chat model (thinking off, a short reply; the quick-tasks
 *    model once Settings have one, #180) gets the paragraph and the Passages,
 *    and gives the words to add, the Passage they rest on and a quote from it.
 * 4. The quote is cited and checked (`citeQuote`); a quote that isn't found
 *    gives nothing, and nor does a number in the words that isn't in the
 *    quote or the paragraph (`numbersBacked`).
 *
 * Nothing leaves the computer unless the User turned suggestions on and
 * allowed the "suggestions" flow to the model's service (ADR-0014), which is
 * asked when they turn it on, never at a pause; in local mode, only a model
 * on this computer is used. One request at a time: a new one, or
 * `cancel`, aborts the one before.
 *
 * Today's counts of suggestions shown and accepted stay on this device, and
 * each accepted one is pushed as "suggestion.accepted" (what a record of AI
 * use hears, #292).
 */
import { randomUUID } from "node:crypto";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import type { Citing, FoundPassage } from "../answers/citing";
import { replyJson } from "../answers/quoteRetry";
import { createWindowBudget } from "../answers/window";
import type {
  ChatModelChoice,
  ChatReadiness,
  Citation,
  ExternalService,
  SearchScope,
  Suggestion,
  SuggestionOutcome,
  SuggestionRequest,
  SuggestionStatus,
} from "../api";
import type { Consent } from "../consent";
import { keywordTerms } from "../documents/keywords";
import { ConsentDeclinedError, InvalidInputError, isRecord, LocalModeError } from "../errors";
import type { createEventHub } from "../events";
import { parseIds, parseMindId } from "../minds";
import { givesStructuredOutput } from "../providers/capabilities";
import type { PreparedChatModel } from "../providers/chat";
import { outputTokens } from "../providers/outputLimits";
import {
  continuationOf,
  numbersBacked,
  readReply,
  SUGGESTION_INSTRUCTIONS,
  suggestionPrompt,
  suggestionSchema,
} from "./prompt";

/** What the "suggestions" flow sends: the paragraph being written, and Passages that match it. */
export const SUGGESTIONS_FLOW_SENDS = ["writing", "writing-passages"] as const;

/** A paragraph shorter than this gets no suggestion: too little to search with. */
export const MIN_PARAGRAPH_CHARACTERS = 40;
/** The most of a paragraph's end the model is given. */
const MAX_PARAGRAPH_CHARACTERS = 1_200;
/** The end of the paragraph that is searched: its last two sentences, at most this long. */
const MAX_QUERY_CHARACTERS = 400;
/** The most Passages the model is given. */
export const MAX_PASSAGES = 8;
/**
 * A strong match, when search reranked: the reranker's score of the best
 * Passage (from 0 to 1) is at least this. In the hand check with the
 * built-in reranking model (#282), paragraphs the Documents support scored
 * 0.78 to 0.98, and those they don't 0.001 to 0.03.
 */
const MIN_RELEVANCE = 0.5;
/**
 * A strong match, when search didn't rerank (the User turned it off): the
 * best Passage holds at least this many of the searched words (not
 * stopwords, nor single letters or characters), and this share of them,
 * though never more than `MATCHED_WORDS_ENOUGH`: a long sentence says much
 * that no Passage repeats.
 *
 * Below a strong match, the Documents don't clearly speak to what is being
 * written, and nothing is asked. (Above it, the model is told to give
 * nothing when no Passage supports a way on, and the quote check follows.)
 */
const MIN_MATCHED_WORDS = 2;
const MIN_MATCHED_SHARE = 1 / 3;
const MATCHED_WORDS_ENOUGH = 3;
/** A request that takes longer than this (a local model loading) gives nothing. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How many suggestions given are remembered, so accepting one can say what it was. */
const REMEMBERED = 20;
/** Where today's counts are kept, on this device. */
const COUNTS_KEY = "suggestionCounts";

const NONE: SuggestionOutcome = { kind: "none" };

/** Where a sentence ends, in English or Chinese. */
const SENTENCE_END = /(?<=[.!?。！？])\s*/u;

/** The end of a paragraph that is searched: its last two sentences, at most `MAX_QUERY_CHARACTERS`. */
export function queryOf(paragraph: string): string {
  const sentences = paragraph
    .split(SENTENCE_END)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const end = sentences.slice(-2).join(" ");
  return end.length > MAX_QUERY_CHARACTERS ? end.slice(-MAX_QUERY_CHARACTERS) : end;
}

/** A word that says something: two Chinese characters or more, or three letters or more. */
const telling = (term: string) =>
  /\p{Script=Han}/u.test(term) ? term.replaceAll(" ", "").length >= 2 : term.length >= 3;

/**
 * Whether the best Passage found for `query` is a strong match: the reranker
 * scored it `MIN_RELEVANCE` or more, or, without a reranker, it holds enough
 * of the query's telling words (`MIN_MATCHED_WORDS`, a third of them for a
 * short query, up to `MATCHED_WORDS_ENOUGH`).
 */
export function isStrongMatch(
  query: string,
  best: Pick<FoundPassage, "matches" | "relevance">,
): boolean {
  if (best.relevance !== null) return best.relevance >= MIN_RELEVANCE;
  const terms = keywordTerms(query).filter(telling).length;
  const matched = best.matches.filter(telling).length;
  const needed = Math.min(
    MATCHED_WORDS_ENOUGH,
    Math.max(MIN_MATCHED_WORDS, Math.ceil(terms * MIN_MATCHED_SHARE)),
  );
  return matched >= needed;
}

interface Counts {
  day: string;
  shown: number;
  accepted: number;
}

/** What a suggestion given was, to say what was accepted. */
interface Given {
  mindId: string;
  providerId: string;
  modelId: string;
  citation: Citation;
}

export interface SuggestionsOptions {
  /** Whether the User has suggestions on (`UserSettings.suggestWhileWriting`). */
  enabled(): boolean;
  /** The default chat model, which suggestions use. */
  model(): ChatModelChoice | null;
  chat: {
    readiness(choice: ChatModelChoice, flow: "suggestions"): Promise<ChatReadiness>;
    prepareModel(choice: ChatModelChoice, flow: "suggestions"): Promise<PreparedChatModel>;
    /** The service the default chat model sends to; null with none, or one on this computer. */
    defaultService(): ExternalService | null;
  };
  consent: Consent;
  citing: Citing;
  /** Throws `NotFoundError` unless the Mind exists. */
  requireMind(mindId: string): void;
  /** The Documents a Search scope covers; with none, the User's own (`scopeDocuments`). */
  scopeDocuments(scope: SearchScope | null, mindId: string | null): string[] | null;
  /** What a suggestion in a Mind searches, by the one rule (`mindSearchScope`); null: every Document. */
  searchedScope(scope: SearchScope, mindId: string): SearchScope | null;
  /** How many of these Documents (null: all) have Passages to search. */
  searchableCount(documentIds: readonly string[] | null): number;
  /** Local mode: only models on this computer. */
  localOnly(): boolean;
  events: ReturnType<typeof createEventHub>;
  /** A per-device value the core keeps for itself (today's counts). */
  readValue(key: string): unknown;
  writeValue(key: string, value: unknown): void;
  now(): Date;
  reportError(error: unknown): void;
}

function parseRequest(input: unknown): SuggestionRequest {
  if (!isRecord(input)) throw new InvalidInputError("suggestNext expects an object.");
  const { requestId, paragraph, scope } = input;
  if (typeof requestId !== "string" || requestId === "") {
    throw new InvalidInputError("A suggestion request needs an id.");
  }
  if (typeof paragraph !== "string") throw new InvalidInputError("paragraph must be text.");
  if (!isRecord(scope)) throw new InvalidInputError("scope must be a Search scope.");
  return {
    requestId,
    mindId: parseMindId(input.mindId),
    paragraph,
    scope: {
      folderIds: parseIds(scope.folderIds, "scope.folderIds"),
      tagIds: parseIds(scope.tagIds, "scope.tagIds"),
      documentIds: parseIds(scope.documentIds, "scope.documentIds"),
    },
  };
}

/** The computer's day, as "2026-10-11". */
const dayOf = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function createSuggestions(options: SuggestionsOptions) {
  const { chat, consent, citing } = options;
  let current: { requestId: string; controller: AbortController } | null = null;
  const given = new Map<string, Given>();

  options.consent.registry.register({
    id: "suggestions",
    sends: SUGGESTIONS_FLOW_SENDS,
    async services() {
      const service = chat.defaultService();
      return service ? [service] : [];
    },
  });

  const counts = (): Counts => {
    const today = dayOf(options.now());
    const stored = options.readValue(COUNTS_KEY);
    if (isRecord(stored) && stored.day === today) {
      const shown = typeof stored.shown === "number" ? stored.shown : 0;
      const accepted = typeof stored.accepted === "number" ? stored.accepted : 0;
      return { day: today, shown, accepted };
    }
    return { day: today, shown: 0, accepted: 0 };
  };
  const count = (what: "shown" | "accepted") => {
    const now = counts();
    options.writeValue(COUNTS_KEY, { ...now, [what]: now[what] + 1 });
  };

  /** Why a suggestion can't be made with the model now, or null when it can. */
  const pausedFor = async (choice: ChatModelChoice | null): Promise<SuggestionStatus["paused"]> => {
    if (!choice) return { reason: "no-model" };
    const readiness = await chat.readiness(choice, "suggestions");
    if (!readiness.ready) {
      return readiness.reason === "consent-declined" && readiness.provider.service
        ? { reason: "consent", service: readiness.provider.service }
        : { reason: "no-model" };
    }
    const { service } = readiness.provider;
    if (!service) return null;
    if (options.localOnly()) return { reason: "local-mode" };
    return consent.status("suggestions", service) === "accepted"
      ? null
      : { reason: "consent", service };
  };

  /** Asks the model, and reads its reply; null when it gives nothing usable. */
  async function ask(
    prepared: PreparedChatModel,
    paragraph: string,
    passages: readonly FoundPassage[],
    signal: AbortSignal,
  ) {
    const prompt = suggestionPrompt(paragraph, passages);
    const abortSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let value: unknown;
    if (givesStructuredOutput(prepared.capabilities) === false) {
      const result = await generateText({
        model: prepared.model,
        instructions: SUGGESTION_INSTRUCTIONS,
        prompt,
        maxOutputTokens: outputTokens("suggestion"),
        maxRetries: 0,
        abortSignal,
      });
      value = await replyJson(result.text);
    } else {
      try {
        const result = await generateText({
          model: prepared.model,
          instructions: SUGGESTION_INSTRUCTIONS,
          prompt,
          output: Output.object({ schema: suggestionSchema, name: "suggestion" }),
          maxOutputTokens: outputTokens("suggestion"),
          maxRetries: 0,
          abortSignal,
        });
        value = result.output;
      } catch (error) {
        // JSON in a code fence, or after thinking, is still read.
        if (!NoObjectGeneratedError.isInstance(error) || !error.text) throw error;
        value = await replyJson(error.text);
      }
    }
    return readReply(value, passages.length);
  }

  /** The Passages that fit the model's window with the rest of the request, best first. */
  function fitted(prepared: PreparedChatModel, paragraph: string, passages: FoundPassage[]) {
    if (!prepared.window) return passages;
    const budget = createWindowBudget(prepared.window);
    let room = budget.roomBeside(
      [SUGGESTION_INSTRUCTIONS, suggestionPrompt(paragraph, [])],
      outputTokens("suggestion"),
    );
    const kept: FoundPassage[] = [];
    for (const passage of passages) {
      const cost = budget.tokens(suggestionPrompt("", [passage])) + 1;
      if (cost > room) break;
      kept.push(passage);
      room -= cost;
    }
    return kept;
  }

  async function suggestFor(
    request: SuggestionRequest,
    documentIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<SuggestionOutcome> {
    const paragraph = request.paragraph.trim().slice(-MAX_PARAGRAPH_CHARACTERS);
    if ([...paragraph].length < MIN_PARAGRAPH_CHARACTERS) return NONE;
    if (options.searchableCount(documentIds) === 0) return NONE;
    const choice = options.model();
    // Nothing is sent unless the flow is allowed already: a pause never asks.
    if ((await pausedFor(choice)) !== null || !choice || signal.aborted) return NONE;

    const query = queryOf(paragraph);
    const found = (await citing.findPassages(query, documentIds, signal)).filter(
      (passage) => !passage.notCited,
    );
    const best = found[0];
    if (signal.aborted || !best || !isStrongMatch(query, best)) return NONE;

    const service = chat.defaultService();
    if (service && consent.status("suggestions", service) !== "accepted") return NONE;
    const prepared = await chat.prepareModel(choice, "suggestions");
    const passages = fitted(prepared, paragraph, found.slice(0, MAX_PASSAGES));
    if (passages.length === 0 || signal.aborted) return NONE;
    const reply = await ask(prepared, paragraph, passages, signal);
    if (!reply || signal.aborted) return NONE;
    // A reply that only repeats what the paragraph says already is no way on.
    const text = continuationOf(paragraph, reply.text);
    if (text === "" || paragraph.includes(text)) return NONE;
    // The quote is cited where it is found: in the Passage the reply names, or else, as a model
    // quoting one Passage may name another, the first other one it was given that holds it.
    const named = passages[reply.passage];
    let citation: Citation | null = null;
    for (const passage of named ? [named, ...passages.filter((each) => each !== named)] : []) {
      const cited = citing.citeQuote(passage.passageId, reply.quote);
      if (cited?.check === "found") {
        citation = cited;
        break;
      }
    }
    if (!citation || !numbersBacked(text, citation.quote, paragraph)) return NONE;

    const suggestion: Suggestion = {
      suggestionId: randomUUID(),
      requestId: request.requestId,
      text,
      citation,
      providerId: prepared.provider.id,
      modelId: prepared.modelId,
    };
    given.set(suggestion.suggestionId, {
      mindId: request.mindId,
      providerId: suggestion.providerId,
      modelId: suggestion.modelId,
      citation,
    });
    const oldest = given.keys().next().value;
    if (given.size > REMEMBERED && oldest !== undefined) given.delete(oldest);
    count("shown");
    return { kind: "suggestion", suggestion };
  }

  const cancelCurrent = () => {
    current?.controller.abort();
    current = null;
  };

  return {
    async suggest(input: unknown): Promise<SuggestionOutcome> {
      const request = parseRequest(input);
      options.requireMind(request.mindId);
      cancelCurrent();
      const searched = options.searchedScope(request.scope, request.mindId);
      const documentIds = options.scopeDocuments(searched, request.mindId);
      if (!options.enabled()) {
        return { kind: "off", scopeHasDocuments: options.searchableCount(documentIds) > 0 };
      }
      const controller = new AbortController();
      current = { requestId: request.requestId, controller };
      try {
        return await suggestFor(request, documentIds, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return NONE;
        // Nothing to show while typing; the log says why (never the User's text).
        options.reportError(
          new Error(
            `A suggestion couldn't be made: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          ),
        );
        return NONE;
      } finally {
        if (current?.requestId === request.requestId) current = null;
      }
    },

    cancel(requestId: unknown): void {
      if (typeof requestId !== "string") throw new InvalidInputError("requestId must be text.");
      if (current?.requestId === requestId) cancelCurrent();
    },

    /** Turning suggestions off: the request in flight stops. */
    stop: cancelCurrent,

    accept(input: unknown): void {
      if (!isRecord(input) || typeof input.suggestionId !== "string") {
        throw new InvalidInputError("acceptSuggestion needs a suggestion's id.");
      }
      const characters =
        typeof input.characters === "number" && Number.isInteger(input.characters)
          ? Math.max(0, input.characters)
          : 0;
      const suggestion = given.get(input.suggestionId);
      if (!suggestion) return;
      given.delete(input.suggestionId);
      count("accepted");
      options.events.emit("suggestion.accepted", {
        suggestionId: input.suggestionId,
        ...suggestion,
        characters,
        acceptedAt: options.now().toISOString(),
      });
    },

    async status(): Promise<SuggestionStatus> {
      const { shown, accepted } = counts();
      return {
        today: { shown, accepted },
        paused: options.enabled() ? await pausedFor(options.model()) : null,
      };
    },

    /**
     * Before suggestions are turned on: asks the User to allow the
     * "suggestions" flow to the default chat model's service, again if they
     * declined it before, since turning them on is asking for it. Nothing is
     * asked with no model, one on this computer, or in local mode, where
     * nothing will be sent. False if they decline.
     */
    async allow(): Promise<boolean> {
      const service = chat.defaultService();
      if (!service || options.localOnly()) return true;
      if (consent.status("suggestions", service) === "declined") {
        consent.revoke("suggestions", service.id);
      }
      try {
        await consent.ensure("suggestions", service);
        return true;
      } catch (error) {
        if (error instanceof ConsentDeclinedError) return false;
        if (error instanceof LocalModeError) return true;
        throw error;
      }
    },
  };
}

export type Suggestions = ReturnType<typeof createSuggestions>;
