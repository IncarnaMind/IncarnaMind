/**
 * One question to a judge model, and the reading of its reply (#2817). An Answer and its checks ask
 * a model one-shot questions: whether a sentence follows from its Citation, which claims a Note
 * makes, which quotes or figures to ask for again. Each asks here, so each keeps its data from
 * reading as instructions the same way, has an output limit of its own by name, has its reply read
 * so that it fails closed, and counts its tokens where the Answer counts its own.
 *
 * A reply is read only once the model's thinking and a code fence around it are dropped, and only
 * when it holds every field its question asks for: a field missing, misspelt, or given twice with
 * two values is a reply that can't be read, never a default. A model that declines is refused, and
 * a stop is stopped, never a network failure. What a caller makes of each is its own: a check's
 * sentence is Not checked, a retry changes nothing.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type FinishReason,
  type FlexibleSchema,
  generateText,
  type LanguageModelUsage,
  NoObjectGeneratedError,
  Output,
  streamText,
} from "ai";
import { isRecord } from "../../shared/record";
import type { ProviderError } from "../api";
import { asAttribute, asData, type PromptTag } from "../promptData";
import type { ChatLanguageModel } from "../providers/models";
import { CutShortError, type ModelCallKind, outputTokens } from "../providers/outputLimits";
import { tokenUsageOf } from "../providers/promptCache";
import { classifyProviderError } from "../providers/providerErrors";
import type { TokenUsage } from "../runs/engine";

/** Every question a judge is asked, each named by its output limit (../providers/outputLimits). */
export const JUDGE_QUESTIONS = [
  "sentence-batch",
  "quick-check",
  "absence-read",
  "evidence",
  "covered-evidence",
  "confirm",
  "strict",
  "strict-figure",
  "recheck",
  "nearest",
  "parts",
  "presence",
  "strict-presence",
  "rewrite",
  "record-cite",
  "find-claims",
  "claimed-changes",
  "unmarked-quotes",
  "quote-retry",
  "figure-retry",
  "working-text",
] as const satisfies readonly ModelCallKind[];

export type JudgeQuestion = (typeof JUDGE_QUESTIONS)[number];

/** Where a request carries the question it asks: no provider reads this namespace. */
const QUESTION_OPTIONS = "incarnamind";

/** The question a model request asks, as the module names it; undefined for any other request. */
export function questionOf(options: {
  providerOptions?: Record<string, Record<string, unknown> | undefined>;
}): JudgeQuestion | undefined {
  const asked = options.providerOptions?.[QUESTION_OPTIONS]?.question;
  return JUDGE_QUESTIONS.find((each) => each === asked);
}

/**
 * A part of a question: its own words, as a string, or data. Data is in a tag of its own, with
 * attributes that are data too (`inline`: on the tag's line), or on lines of its own.
 */
export type JudgePart =
  | string
  | {
      text: string;
      tag?: PromptTag;
      attributes?: Readonly<Record<string, string>>;
      inline?: true;
    };

/**
 * The question's prompt: its parts a line apart, each data part with no `<` that could open or
 * close its own tag or one of `data`, the question's other tags (#2423).
 */
export function judgePrompt(parts: readonly JudgePart[], data: readonly PromptTag[]): string {
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part.tag) return asData(part.text, data);
      const attributes = Object.entries(part.attributes ?? {})
        .map(([name, value]) => ` ${name}="${asAttribute(value, data)}"`)
        .join("");
      const text = asData(part.text, [part.tag, ...data]);
      const open = `<${part.tag}${attributes}>`;
      const close = `</${part.tag}>`;
      return part.inline ? `${open}${text}${close}` : `${open}\n${text}\n${close}`;
    })
    .join("\n");
}

/** How a reply is read: null when it can't be. Each reader requires every field it reads. */
export type JudgeReply<T> =
  | { kind: "json"; read(value: unknown): T | null }
  | { kind: "lines"; read(text: string): T | null }
  | {
      kind: "structured";
      schema: FlexibleSchema<unknown>;
      name: string;
      read(value: unknown): T | null;
    };

/** A reply that is one JSON value, salvaged from among other words. */
export const json = <T>(read: (value: unknown) => T | null): JudgeReply<T> => ({
  kind: "json",
  read,
});

/** A reply in lines of text. */
export const lines = <T>(read: (text: string) => T | null): JudgeReply<T> => ({
  kind: "lines",
  read,
});

/**
 * A reply in the provider's structured output, read as JSON when the provider doesn't hold to the
 * schema.
 */
export const structured = <T>(
  schema: FlexibleSchema<unknown>,
  name: string,
  read: (value: unknown) => T | null,
): JudgeReply<T> => ({ kind: "structured", schema, name, read });

export type JudgeFailure = "cut-short" | "refused" | "unreadable" | "stopped" | "failed";

/** A question that came to no reading. */
export interface NotJudged {
  ok: false;
  reason: JudgeFailure;
  /** For cut-short and failed: what the provider said. */
  error?: ProviderError;
  usage: TokenUsage | null;
}

export type Judged<T> = { ok: true; value: T; usage: TokenUsage | null } | NotJudged;

export interface JudgeAsk<T> {
  model: ChatLanguageModel;
  question: { id: JudgeQuestion; instructions: string };
  parts: readonly JudgePart[];
  /** The question's tags: no data part may open or close one. */
  data: readonly PromptTag[];
  reply: JudgeReply<T>;
  /** For a question whose output limit is so much an item: how many items it asks about. */
  items?: number;
  /** How many times the provider's request is sent again when it fails. */
  retries: number;
  signal: AbortSignal;
  /** How long a reply may take: past it, the call failed. */
  timeoutMs?: number;
  temperature?: number;
  /** The reply is streamed, as a model on this computer may need to keep its connection. */
  stream?: true;
  /** Hears the reply's text as it streams, for a caller that reads it early; it streams then. */
  onPartial?(delta: string): void;
}

/** A reply without the thinking a model writes in its text, closed or cut off. */
export const withoutThinking = (raw: string): string =>
  raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");

/** A reply without the model's thinking or a code fence around it. */
export const replyText = (raw: string): string =>
  withoutThinking(raw)
    .replace(/^\s*```(?:json)?[ \t]*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

/**
 * The reply's JSON, inside a code fence, after thinking or among other words; undefined if there is
 * none that parses whole. JSON that is cut off is never repaired (#2275): a repaired record would
 * hold a quote or figure cut short.
 */
export function replyJson(raw: string): unknown {
  const text = replyText(raw);
  const whole = (each: string) => {
    try {
      return { value: JSON.parse(each) as unknown };
    } catch {
      return null;
    }
  };
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  return (whole(text) ?? (start >= 0 && end > start ? whole(text.slice(start, end + 1)) : null))
    ?.value;
}

/** Words a model refuses with, in English and Chinese. */
const REFUSAL =
  /\b(?:I(?:'m| am)? (?:sorry|unable|not able)|I can(?:no|')t (?:help|assist|check|do)|I won't|cannot (?:help|assist|comply))|抱歉|无法(?:协助|帮助|完成|核对)|不能(?:协助|帮助)/i;

/** Whether a reply's words decline: a reply that can't be read and says so was refused. */
export const declines = (reply: string): boolean => REFUSAL.test(reply);

/** A field's value, read; undefined when it isn't one this field takes. */
export type Field<T> = (value: unknown) => T | undefined;

/** One of `words`, exactly. */
export const word =
  <T extends string>(...words: readonly T[]): Field<T> =>
  (value) =>
    words.find((each) => each === value);

export const text: Field<string> = (value) => (typeof value === "string" ? value : undefined);

export const textOrNull: Field<string | null> = (value) =>
  value === null || typeof value === "string" ? value : undefined;

/** A whole number, written as one or as digits. */
export const whole: Field<number> = (value) => {
  const number = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) ? number : undefined;
};

export const list: Field<readonly unknown[]> = (value) =>
  Array.isArray(value) ? value : undefined;

/** True or false, also written as the word in any case, as a provider may send it. */
export const truth: Field<boolean> = (value) => {
  if (typeof value === "boolean") return value;
  const said = typeof value === "string" ? value.trim().toLowerCase() : null;
  return said === "true" ? true : said === "false" ? false : undefined;
};

type FieldsRead<S> = { [K in keyof S]: S[K] extends Field<infer T> ? T : never };

/**
 * A record's fields as `fields` reads each; null unless the record holds every one of them, each a
 * value its field takes. A field left out is never given a value of its own (#2817).
 */
export function fieldsOf<S extends Record<string, Field<unknown>>>(
  value: unknown,
  fields: S,
): FieldsRead<S> | null {
  if (!isRecord(value)) return null;
  const read: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    if (!Object.hasOwn(value, name)) return null;
    const given = field(value[name]);
    if (given === undefined) return null;
    read[name] = given;
  }
  return read as FieldsRead<S>;
}

/**
 * The value a reply gives a field, wherever it gives it; null when it gives none, or two that
 * differ: a reply that changes its mind is read as neither (#2817).
 */
export function oneValue<T>(values: readonly T[]): T | null {
  const [first] = values;
  if (first === undefined) return null;
  const said = JSON.stringify(first);
  return values.every((each) => JSON.stringify(each) === said) ? first : null;
}

/** Where the Answer whose work is running counts the tokens of its judges' calls. */
const tally = new AsyncLocalStorage<(usage: TokenUsage) => void>();

/**
 * `events`, with every judge call made while each is produced counting its tokens to `count`: an
 * Answer's stored usage then holds its retries' and checks' tokens with its own (#2817).
 */
export async function* countingJudges<T>(
  events: AsyncIterable<T>,
  count: (usage: TokenUsage) => void,
): AsyncGenerator<T> {
  const iterator = events[Symbol.asyncIterator]();
  let done = false;
  try {
    for (;;) {
      const step = await tally.run(count, () => iterator.next());
      if (step.done) {
        done = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!done) {
      await tally.run(count, async () => {
        await iterator.return?.();
      });
    }
  }
}

interface Replied {
  text: string;
  /** The provider's own parse of a structured reply, when it held to the schema. */
  parsed?: { value: unknown };
  finishReason?: FinishReason;
  usage: TokenUsage | null;
}

const usageOf = (usage: LanguageModelUsage | undefined): TokenUsage | null =>
  usage ? tokenUsageOf(usage) : null;

function spentBy(error: unknown): TokenUsage | null {
  if (error instanceof CutShortError) return error.usage;
  if (NoObjectGeneratedError.isInstance(error)) return usageOf(error.usage);
  return null;
}

class StoppedStream extends Error {
  override name = "AbortError";
}

/** What every request of a question sends, however it is read. */
interface Call {
  model: ChatLanguageModel;
  instructions: string;
  prompt: string;
  temperature: number | undefined;
  maxRetries: number;
  abortSignal: AbortSignal;
  providerOptions: Record<string, Record<string, string>>;
}

async function streamed<T>(ask: JudgeAsk<T>, call: Call): Promise<Replied> {
  const { reply } = ask;
  const parts =
    reply.kind === "structured"
      ? streamText({
          ...call,
          maxOutputTokens: outputTokens(ask.question.id, ask.items),
          output: Output.object({ schema: reply.schema, name: reply.name }),
          onError: () => undefined,
        }).fullStream
      : streamText({
          ...call,
          maxOutputTokens: outputTokens(ask.question.id, ask.items),
          onError: () => undefined,
        }).fullStream;
  let text = "";
  let finishReason: FinishReason | undefined;
  let usage: TokenUsage | null = null;
  for await (const part of parts) {
    if (part.type === "text-delta") {
      text += part.text;
      ask.onPartial?.(part.text);
    } else if (part.type === "error") throw part.error;
    else if (part.type === "abort") throw new StoppedStream("The reply was stopped.");
    else if (part.type === "finish") {
      finishReason = part.finishReason;
      usage = usageOf(part.totalUsage);
    }
  }
  return { text, usage, ...(finishReason && { finishReason }) };
}

async function generated<T>(ask: JudgeAsk<T>, call: Call): Promise<Replied> {
  const { reply } = ask;
  if (reply.kind !== "structured") {
    const result = await generateText({
      ...call,
      maxOutputTokens: outputTokens(ask.question.id, ask.items),
    });
    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: usageOf(result.totalUsage),
    };
  }
  try {
    const result = await generateText({
      ...call,
      maxOutputTokens: outputTokens(ask.question.id, ask.items),
      output: Output.object({ schema: reply.schema, name: reply.name }),
    });
    return {
      text: result.text,
      parsed: { value: result.output },
      finishReason: result.finishReason,
      usage: usageOf(result.totalUsage),
    };
  } catch (error) {
    // A provider that doesn't hold to the schema still replied: its text is read as JSON.
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    return {
      text: error.text ?? "",
      ...(error.finishReason && { finishReason: error.finishReason }),
      usage: usageOf(error.usage),
    };
  }
}

function readOf<T>(reply: JudgeReply<T>, replied: Replied): T | null {
  if (reply.kind === "lines") return reply.read(replyText(replied.text));
  const value = replied.parsed ? replied.parsed.value : replyJson(replied.text);
  return value === undefined ? null : reply.read(value);
}

/** Asks the judge `ask.question`, and reads its reply as `ask.reply` says. */
export async function judge<T>(ask: JudgeAsk<T>): Promise<Judged<T>> {
  const { signal } = ask;
  const count = tally.getStore();
  const spent = (usage: TokenUsage | null) => {
    if (usage) count?.(usage);
    return usage;
  };
  const call: Call = {
    model: ask.model,
    instructions: ask.question.instructions,
    prompt: judgePrompt(ask.parts, ask.data),
    temperature: ask.temperature,
    maxRetries: ask.retries,
    abortSignal:
      ask.timeoutMs === undefined
        ? signal
        : AbortSignal.any([signal, AbortSignal.timeout(ask.timeoutMs)]),
    providerOptions: { [QUESTION_OPTIONS]: { question: ask.question.id } },
  };
  let replied: Replied;
  try {
    replied = ask.stream || ask.onPartial ? await streamed(ask, call) : await generated(ask, call);
  } catch (error) {
    const usage = spent(spentBy(error));
    if (signal.aborted) return { ok: false, reason: "stopped", usage };
    const failure = classifyProviderError(error);
    return {
      ok: false,
      reason: failure.kind === "cut-short" ? "cut-short" : "failed",
      error: failure,
      usage,
    };
  }
  const usage = spent(replied.usage);
  if (signal.aborted) return { ok: false, reason: "stopped", usage };
  if (replied.finishReason === "content-filter") return { ok: false, reason: "refused", usage };
  const value = readOf(ask.reply, replied);
  if (value === null) {
    return {
      ok: false,
      reason: declines(replyText(replied.text)) ? "refused" : "unreadable",
      usage,
    };
  }
  return { ok: true, value, usage };
}
