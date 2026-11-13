/**
 * What a replay of an Answer's citing step needs (#3059), kept with each Answer of a run so a
 * count of how its Citations came about can be made from the run's file: the Answer as the model
 * wrote it, the Passages it was shown, the model's own Citation records, whether the app asked
 * once more for Citations and what came back, and where each finished Citation came from with its
 * check's verdict.
 *
 * A harness wraps the Library's chat models with `watchCiting().chatModels`, calls `begin()` before
 * an Answer is asked and `end()` once it has ended, then `citingRecord(watched, answer)` with the
 * Answer as it stands once its sentences are judged. Nothing is sent or stored by the app for it:
 * the watcher only reads the requests the Answer makes and their replies.
 */
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type {
  ChatModelFactory,
  CitationCheck,
  CitationCheckReason,
  ConversationAnswer,
} from "../../src/core";
import { parseRecords } from "../../src/core/answers/engine";
import { questionOf } from "../../src/core/answers/judge";
import { takeToolText } from "../../src/core/answers/toolText";
import { matchUnmarked, parseAsked } from "../../src/core/answers/unmarkedQuotes";
import { markersIn } from "../../src/shared/answerBlocks";
import { shownPassages } from "../../tests/helpers/citations";

/**
 * Where a finished Citation came from:
 * - "model": the model's own record for its marker;
 * - "request": the one request for Citations gave it;
 * - "app-marked": the app's own match, on a sentence that carried a marker the model gave no
 *   record for;
 * - "app-unmarked": the app's own match, on a sentence with no marker;
 * - "figure": an input of a calculated figure, recorded with the figure and never shown as a
 *   marker in the text.
 */
export type CitationOrigin = "model" | "request" | "app-marked" | "app-unmarked" | "figure";

export interface CitingRecord {
  /**
   * The Answer as the model wrote it: each reply, in order (a check asking again starts another).
   * Before its citing step the app places the markers of the model's own records, so a replay
   * places them first (`withMissingMarkers`), or starts from `asked.answer` when there was an ask.
   */
  written: string[];
  /** The Passages its requests showed it, each once, as the model read them. */
  passages: { id: string; document: string; location: string | null; text: string }[];
  /** The model's own Citation records: from its `cite` calls, its structured reply or `<cite>` text. */
  records: { marker: number; passage: string; quote: string }[];
  /** The markers its last reply wrote with no record behind them, each once. */
  unrecorded: number[];
  /**
   * The one request for Citations: null when none went out. `answer` is the Answer as the citing
   * step read it, its own records' markers placed (a replay starts there, not from `written`);
   * `given` what the reply gave; `failed` when no reply came.
   */
  asked: {
    answer: string;
    given: { sentence: string; passage: string; quote: string }[];
    failed: boolean;
  } | null;
  /** The finished Answer's Citations, in its order. */
  citations: {
    marker: number;
    document: string;
    quote: string;
    from: CitationOrigin;
    check: CitationCheck;
    checkReason: CitationCheckReason | null;
    /** The Answer's own check judged its sentence (`judgedAt`), beyond finding its quote. */
    judged: boolean;
  }[];
}

/** A request of one Answer as the watcher heard it. */
interface Exchange {
  kind: "answer" | "ask";
  /** The text of what it was sent, where the Passages are. */
  prompt: string;
  /** Who wrote its last message: "user" for a Question or a check asking again, "tool" for a Tool loop's next step. */
  lastRole: string;
  /** It asked for the structured reply ({answer, citations}) instead of offering Tools. */
  structured: boolean;
  text: string;
  calls: { tool: string; input: string }[];
  /** Its reply came whole; false while it streams, and for one the provider refused or that broke off. */
  replied: boolean;
}

/** What a watcher heard of one Answer, from `begin()` to `end()`. */
export interface Watched {
  exchanges: Exchange[];
}

export interface CitingWatch {
  chatModels(inner: ChatModelFactory): ChatModelFactory;
  begin(): void;
  end(): Watched;
}

type Message = LanguageModelV4Prompt[number];

function messageText(message: Message): string {
  if (message.role === "system") return message.content;
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool-call")
        return typeof part.input === "string" ? part.input : JSON.stringify(part.input);
      if (part.type !== "tool-result") return "";
      const { output } = part;
      if (output.type === "text" || output.type === "error-text") return output.value;
      if (output.type === "json" || output.type === "error-json")
        return JSON.stringify(output.value);
      if (output.type === "content") {
        return output.value.map((each) => (each.type === "text" ? each.text : "")).join("\n");
      }
      return "";
    })
    .join("\n");
}

/** Whether a request asks for the structured Answer: a JSON object with its text and its records. */
function asksForStructuredAnswer(options: LanguageModelV4CallOptions): boolean {
  const format = options.responseFormat;
  if (format?.type !== "json") return false;
  const properties = (format.schema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return properties !== undefined && "answer" in properties && "citations" in properties;
}

function kindOf(options: LanguageModelV4CallOptions): Exchange["kind"] | null {
  const question = questionOf(options);
  if (question === "unmarked-quotes") return "ask";
  if (question !== undefined) return null;
  const offersCite = (options.tools ?? []).some((tool) => tool.name === "cite");
  return offersCite || asksForStructuredAnswer(options) ? "answer" : null;
}

function exchangeOf(kind: Exchange["kind"], options: LanguageModelV4CallOptions): Exchange {
  return {
    kind,
    prompt: options.prompt.map(messageText).join("\n\n"),
    lastRole: options.prompt.at(-1)?.role ?? "user",
    structured: asksForStructuredAnswer(options),
    text: "",
    calls: [],
    replied: false,
  };
}

/** Watches the Answer requests and the one request for Citations of each Answer begun. */
export function watchCiting(): CitingWatch {
  let exchanges: Exchange[] = [];
  /** A request is heard as it is sent, so one refused or broken off still counts as made. */
  const sent = (options: LanguageModelV4CallOptions): Exchange | null => {
    const kind = kindOf(options);
    if (!kind) return null;
    const exchange = exchangeOf(kind, options);
    exchanges.push(exchange);
    return exchange;
  };
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const exchange = sent(params);
      const result = await doGenerate();
      if (exchange) {
        const content: LanguageModelV4Content[] = result.content;
        exchange.text = content.map((part) => (part.type === "text" ? part.text : "")).join("");
        exchange.calls = content.flatMap((part) =>
          part.type === "tool-call" ? [{ tool: part.toolName, input: part.input }] : [],
        );
        exchange.replied = true;
      }
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const exchange = sent(params);
      const result = await doStream();
      if (!exchange) return result;
      let broke = false;
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta") exchange.text += part.delta;
            else if (part.type === "tool-call")
              exchange.calls.push({ tool: part.toolName, input: part.input });
            else if (part.type === "error") broke = true;
            else if (part.type === "finish") exchange.replied = !broke;
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream };
    },
  };
  return {
    chatModels: (inner) => (spec) => wrapLanguageModel({ model: inner(spec), middleware }),
    begin() {
      exchanges = [];
    },
    end() {
      const watched = { exchanges };
      exchanges = [];
      return watched;
    },
  };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  } catch {
    return undefined;
  }
}

const recordsOf = (value: unknown): CitingRecord["records"] =>
  parseRecords(value).map(({ marker, passage, quote }) => ({
    marker,
    passage,
    quote: quote ?? "",
  }));

const comparable = (text: string) => text.replace(/\s+/g, " ").trim();

/** A quote is the Citation's: one holds the other, as a quote is widened to its sentence. */
function sameQuote(given: string, citation: ConversationAnswer["citations"][number]): boolean {
  const asked = comparable(given);
  return [citation.quote, citation.given ?? ""]
    .map(comparable)
    .some((each) => each !== "" && asked !== "" && (each.includes(asked) || asked.includes(each)));
}

/** The record of one Answer's citing step, from what the watcher heard and the Answer once its sentences are judged. */
export function citingRecord(watched: Watched, answer: ConversationAnswer): CitingRecord {
  const written: string[] = [];
  const records: CitingRecord["records"] = [];
  const passages = new Map<string, CitingRecord["passages"][number]>();
  const showing = (prompt: string) => {
    for (const passage of shownPassages(prompt)) {
      if (passages.has(passage.id)) continue;
      passages.set(passage.id, {
        id: passage.id,
        document: passage.document,
        location: passage.location ?? (passage.pages ? `pages ${passage.pages}` : null),
        text: passage.text,
      });
    }
  };
  let asked: CitingRecord["asked"] = null;
  for (const exchange of watched.exchanges) {
    showing(exchange.prompt);
    if (exchange.kind === "ask") {
      asked ??= {
        answer: /<answer>\n([\s\S]*?)\n<\/answer>/.exec(exchange.prompt)?.[1] ?? "",
        given: exchange.replied
          ? parseAsked(parsed(exchange.calls[0]?.input ?? exchange.text)).map((each) => ({
              sentence: each.sentence,
              passage: each.passage,
              quote: each.quote,
            }))
          : [],
        failed: !exchange.replied,
      };
      continue;
    }
    if (exchange.structured) {
      const value = parsed(exchange.text) as { answer?: unknown; citations?: unknown } | undefined;
      written.push(typeof value?.answer === "string" ? value.answer : exchange.text);
      records.push(...recordsOf(value?.citations));
      continue;
    }
    if (written.length === 0 || exchange.lastRole === "user") written.push("");
    written[written.length - 1] += exchange.text;
    records.push(...recordsOf(takeToolText(exchange.text).records));
    for (const call of exchange.calls) {
      if (call.tool !== "cite") continue;
      records.push(
        ...recordsOf((parsed(call.input) as { citations?: unknown } | undefined)?.citations),
      );
    }
  }
  const recordedMarkers = new Set(records.map((record) => record.marker));
  const last = written.at(-1) ?? "";
  const unrecorded = [...new Set(markersIn(takeToolText(last).text))].filter(
    (marker) => !recordedMarkers.has(marker),
  );
  const shown = new Set(markersIn(answer.text));
  const passageList = [...passages.values()];
  // The request's reply is taken only for sentences the app hadn't matched first, and it is given
  // the whole Answer, so it often cites those too: which sentences the app matched is told by
  // matching again, as the citing step did, the text it read with the Passages it was shown.
  const appMatched = asked
    ? matchUnmarked(
        asked.answer,
        passageList,
        (id, quote) =>
          comparable(passages.get(id)?.text ?? "").includes(comparable(quote)) && quote !== "",
        (marker) => recordedMarkers.has(marker),
      )
    : null;
  const fromOf = (citation: ConversationAnswer["citations"][number]): CitationOrigin => {
    if (recordedMarkers.has(citation.marker)) return "model";
    if (!shown.has(citation.marker)) return "figure";
    if (appMatched === null) {
      return unrecorded.includes(citation.marker) ? "app-marked" : "app-unmarked";
    }
    const own =
      appMatched.find((match) => match.marker === citation.marker) ??
      appMatched.find((match) => match.marker === undefined && sameQuote(match.quote, citation));
    if (!own) return "request";
    return own.marker === undefined ? "app-unmarked" : "app-marked";
  };
  return {
    written,
    passages: passageList,
    records,
    unrecorded,
    asked,
    citations: answer.citations.map((citation) => ({
      marker: citation.marker,
      document: citation.documentName,
      quote: citation.quote,
      from: fromOf(citation),
      check: citation.check,
      checkReason: citation.checkReason,
      judged: citation.judgedAt !== undefined,
    })),
  };
}
