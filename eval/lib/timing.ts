/**
 * Where an Answer's time went (#488): each model call, each search and the
 * reranker within it, the first text that stayed in the Answer, the computer's
 * load. Recorded through the core's own seams (the chat model factory, the
 * Answer engine and `AnswerSearchTuning`), which pass everything on unchanged.
 * Only numbers are kept: no key, request or Passage text reaches a report.
 */
import { loadavg } from "node:os";
import type { LanguageModelMiddleware } from "ai";
import { wrapLanguageModel } from "ai";
import type { AnswerSearchTuning, ChatModelFactory, ObservedSearch } from "../../src/core";
import {
  type AnswerEngine,
  type AnswerEngineEvent,
  createAiSdkAnswerEngine,
} from "../../src/core/answers/engine";
import type { WindowedPassage } from "../../src/core/documents/search";

/** One model call, in milliseconds from the moment the Question was asked. */
export interface ModelCallTiming {
  startMs: number;
  /** The first part of the response after the request was accepted; null if none came. */
  firstByteMs: number | null;
  /** Null when the call was cut off (the Answer was stopped). */
  endMs: number | null;
  /** What the provider counted; null for a count it did not give. */
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

export interface SearchTiming {
  startMs: number;
  endMs: number;
  /** The reranker's own time within the search; null when it did not rerank. */
  rerankMs: number | null;
  /** How many Passages the search handed the model. */
  passages: number;
}

export interface AnswerTiming {
  /** The computer's one-minute load average when the Question was asked. */
  loadAverage: number;
  /** From asking the Question to the Answer being finished. */
  totalMs: number;
  /** The first text that stayed in the Answer; a preamble taken back doesn't count. Null: none stayed. */
  firstTextMs: number | null;
  /** The Answer was written twice, word for word, Citation markers aside. */
  writtenTwice: boolean;
  modelCalls: ModelCallTiming[];
  searches: SearchTiming[];
}

/** What a recording holds when an Answer ends, beyond what the report keeps. */
export interface Recording {
  modelCalls: ModelCallTiming[];
  searches: SearchTiming[];
  textEvents: TextEvent[];
  /** The Passages every search handed the model. */
  handed: WindowedPassage[];
  loadAverage: number;
}

export type TextEvent =
  | { type: "text-delta"; atMs: number; length: number }
  | { type: "text-retracted"; atMs: number; length: number };

/**
 * When the first text that stayed in the Answer came: text taken back
 * (`text-retracted` removes the last characters) doesn't count.
 */
export function firstKeptText(events: readonly TextEvent[]): number | null {
  const kept: { atMs: number; length: number }[] = [];
  for (const event of events) {
    if (event.type === "text-delta") {
      kept.push({ atMs: event.atMs, length: event.length });
      continue;
    }
    let left = event.length;
    while (left > 0 && kept.length > 0) {
      const last = kept[kept.length - 1] as { atMs: number; length: number };
      if (last.length <= left) {
        left -= last.length;
        kept.pop();
      } else {
        last.length -= left;
        left = 0;
      }
    }
  }
  return kept.find((each) => each.length > 0)?.atMs ?? null;
}

const MARKER = /\[\^\d{1,4}\]/g;
/** A paragraph this short may repeat on purpose ("Yes.", a heading). */
const REPEAT_MIN_LENGTH = 30;

/**
 * Whether the Answer says the same paragraph twice, word for word, Citation
 * markers aside: a model that wrote its Answer, then called a Tool, and wrote
 * it again (#488). `text` is the Answer's blocks, a paragraph each.
 */
export function isWrittenTwice(text: string): boolean {
  const seen = new Set<string>();
  for (const paragraph of text.split(/\n+/)) {
    const key = paragraph.replace(MARKER, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (key.length < REPEAT_MIN_LENGTH) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export interface TimingRecorder {
  /** Wraps a chat model factory so each call is timed; the requests are the factory's own. */
  chatModels(inner: ChatModelFactory): ChatModelFactory;
  /** The Answer engine the core uses, with the text it streams timed. */
  engine: AnswerEngine;
  /** Called by the core after each search of an Answer. */
  observe(search: ObservedSearch): void;
  /** Starts recording an Answer: the moment the Question is asked. */
  begin(): void;
  /** Stops recording and gives what was seen. */
  end(): Recording;
}

const now = () => performance.now();

export function createTimingRecorder(): TimingRecorder {
  let origin = now();
  let calls: ModelCallTiming[] = [];
  let searches: SearchTiming[] = [];
  let events: TextEvent[] = [];
  let handed: WindowedPassage[] = [];
  let load = 0;
  const since = () => now() - origin;

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream }) => {
      const call = open();
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        call.endMs = since();
        throw error;
      }
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (call.firstByteMs === null && part.type !== "stream-start") {
              call.firstByteMs = since();
            }
            if (part.type === "finish") count(call, part.usage);
            controller.enqueue(part);
          },
          flush() {
            call.endMs = since();
          },
        }),
      );
      return { ...result, stream };
    },
    wrapGenerate: async ({ doGenerate }) => {
      const call = open();
      try {
        const result = await doGenerate();
        call.firstByteMs = call.endMs = since();
        count(call, result.usage);
        return result;
      } catch (error) {
        call.endMs = since();
        throw error;
      }
    },
  };

  function open(): ModelCallTiming {
    const call: ModelCallTiming = {
      startMs: since(),
      firstByteMs: null,
      endMs: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
    };
    calls.push(call);
    return call;
  }

  const inner = createAiSdkAnswerEngine();
  const engine: AnswerEngine = {
    async *generate(request) {
      for await (const event of inner.generate(request)) {
        const text = textEventOf(event, since());
        if (text) events.push(text);
        yield event;
      }
    },
  };

  return {
    chatModels: (factory) => (spec) => wrapLanguageModel({ model: factory(spec), middleware }),
    engine,
    observe(search) {
      searches.push({
        startMs: search.startedAt - origin,
        endMs: search.endedAt - origin,
        rerankMs: search.rerankMs,
        passages: search.passages.length,
      });
      handed.push(...search.passages);
    },
    begin() {
      origin = now();
      calls = [];
      searches = [];
      events = [];
      handed = [];
      load = loadavg()[0] ?? 0;
    },
    end() {
      return {
        modelCalls: calls,
        searches,
        textEvents: events,
        handed,
        loadAverage: load,
      };
    },
  };
}

function textEventOf(event: AnswerEngineEvent, atMs: number): TextEvent | null {
  if (event.type === "text-delta") return { type: event.type, atMs, length: event.text.length };
  if (event.type === "text-retracted") return { type: event.type, atMs, length: event.length };
  return null;
}

interface FinishUsage {
  inputTokens: { total: number | undefined; cacheRead: number | undefined };
  outputTokens: { total: number | undefined };
}

function count(call: ModelCallTiming, usage: FinishUsage): void {
  call.inputTokens = usage.inputTokens.total ?? null;
  call.cachedInputTokens = usage.inputTokens.cacheRead ?? null;
  call.outputTokens = usage.outputTokens.total ?? null;
}

/** The library options for a run: Answers' search settings, and recording when a chat model is asked. */
export function answerOptionsOf(config: {
  chat: unknown;
  rerankDepth: number | "off" | null;
  maxPassages: number | null;
}): {
  answerSearch: Pick<AnswerSearchTuning, "rerankDepth" | "maxPassages">;
  recordTimings: boolean;
} {
  return {
    answerSearch: {
      ...(config.rerankDepth !== null && { rerankDepth: config.rerankDepth }),
      ...(config.maxPassages !== null && { maxPassages: config.maxPassages }),
    },
    recordTimings: config.chat !== null,
  };
}

/** What the library gives the core so an Answer's searches are tuned and timed, from the run's settings. */
export function answerSearchOf(
  settings: Pick<AnswerSearchTuning, "rerankDepth" | "maxPassages">,
  recorder: TimingRecorder | null,
): AnswerSearchTuning | undefined {
  const tuned = settings.rerankDepth !== undefined || settings.maxPassages !== undefined;
  if (!tuned && !recorder) return undefined;
  return {
    ...(settings.rerankDepth !== undefined && { rerankDepth: settings.rerankDepth }),
    ...(settings.maxPassages !== undefined && { maxPassages: settings.maxPassages }),
    ...(recorder && { observe: (search: ObservedSearch) => recorder.observe(search) }),
  };
}

export function timingOf(recording: Recording, totalMs: number, text: string): AnswerTiming {
  return {
    loadAverage: recording.loadAverage,
    totalMs,
    firstTextMs: firstKeptText(recording.textEvents),
    writtenTwice: isWrittenTwice(text),
    modelCalls: recording.modelCalls,
    searches: recording.searches,
  };
}

// Summaries

/** The median and 95th percentile (nearest rank) of some values, with how many there were. */
export interface Spread {
  median: number;
  p95: number;
  n: number;
}

export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return null;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function spreadOf(values: readonly number[]): Spread | null {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = median(sorted);
  if (middle === null) return null;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] as number;
  return { median: middle, p95, n: sorted.length };
}

/** How many of a group's model calls to give a line each (later ones are one line, "later"). */
export const CALLS_SHOWN = 3;

export interface TimingSummary {
  /** Answers with timings. */
  answers: number;
  /** The median one-minute load average when the Answers began. */
  loadAverage: number | null;
  /** All in seconds. */
  whole: Spread | null;
  firstText: Spread | null;
  /** Each model call, start to end, and its wait for the first byte. */
  modelCall: Spread | null;
  modelCallWait: Spread | null;
  /** The first calls of each Answer, then the rest together as the last entry. */
  modelCallsByOrder: { duration: Spread | null; wait: Spread | null }[];
  search: Spread | null;
  /** The reranker's time in a search that reranked. */
  reranker: Spread | null;
  /** Averages per Answer. */
  modelCallsPerAnswer: number;
  searchesPerAnswer: number;
  writtenTwice: number;
  /** Mean tokens a model call reported (input, cached input, output); null when none reported. */
  tokensPerCall: { input: number; cachedInput: number; output: number } | null;
}

type Timed = { timing?: AnswerTiming | null };

const seconds = (ms: number) => ms / 1000;
const known = (values: readonly (number | null)[]): number[] =>
  values.filter((value): value is number => value !== null);

export function summariseTiming(answers: readonly Timed[]): TimingSummary | null {
  const timings = answers.flatMap((answer) => (answer.timing ? [answer.timing] : []));
  if (timings.length === 0) return null;
  const calls = timings.map((timing) => timing.modelCalls);
  const duration = (call: ModelCallTiming) =>
    call.endMs === null ? null : seconds(call.endMs - call.startMs);
  const wait = (call: ModelCallTiming) =>
    call.firstByteMs === null ? null : seconds(call.firstByteMs - call.startMs);
  const spreadOfCalls = (list: readonly ModelCallTiming[], pick: typeof duration) =>
    spreadOf(known(list.map(pick)));
  const allCalls = calls.flat();
  const order = Array.from({ length: CALLS_SHOWN + 1 }, (_, index) => {
    const at = calls.flatMap((each) =>
      index < CALLS_SHOWN ? (each[index] ? [each[index]] : []) : each.slice(CALLS_SHOWN),
    );
    return { duration: spreadOfCalls(at, duration), wait: spreadOfCalls(at, wait) };
  });
  const searches = timings.flatMap((timing) => timing.searches);
  const withTokens = allCalls.filter((call) => call.inputTokens !== null);
  const mean = (pick: (call: ModelCallTiming) => number | null) =>
    withTokens.reduce((sum, call) => sum + (pick(call) ?? 0), 0) / withTokens.length;
  return {
    answers: timings.length,
    loadAverage: median(timings.map((timing) => timing.loadAverage)),
    whole: spreadOf(timings.map((timing) => seconds(timing.totalMs))),
    firstText: spreadOf(known(timings.map((timing) => timing.firstTextMs)).map(seconds)),
    modelCall: spreadOfCalls(allCalls, duration),
    modelCallWait: spreadOfCalls(allCalls, wait),
    modelCallsByOrder: order,
    search: spreadOf(searches.map((search) => seconds(search.endMs - search.startMs))),
    reranker: spreadOf(known(searches.map((search) => search.rerankMs)).map(seconds)),
    modelCallsPerAnswer: allCalls.length / timings.length,
    searchesPerAnswer: searches.length / timings.length,
    writtenTwice: timings.filter((timing) => timing.writtenTwice).length,
    tokensPerCall:
      withTokens.length === 0
        ? null
        : {
            input: mean((call) => call.inputTokens),
            cachedInput: mean((call) => call.cachedInputTokens),
            output: mean((call) => call.outputTokens),
          },
  };
}
