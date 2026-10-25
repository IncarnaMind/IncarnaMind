/**
 * Arm C of the comparison for #1559, in the evaluation only: before each
 * request, a decision model chooses write, edit or answer, with a
 * confidence. At `FORCED_FROM` or more, a write or an edit is forced: until
 * the Answer has called that command, the model may only call Tools, so it
 * can still search and cite first but can't end with text. Below it, and for
 * an answer, the turn runs as the app's does (arm B). Two providers: OpenAI's
 * Decisions on GPT-6 Luna, and TypeSafe's Jev 1.13.
 */
import type { LanguageModelMiddleware } from "ai";
import { wrapLanguageModel } from "ai";
import type { ChatModelFactory } from "../../src/core";

export type DecisionProvider = "openai" | "jev";
export type Route = "write" | "edit" | "answer";

export interface Decision {
  provider: DecisionProvider;
  choice: Route;
  confidence: number;
  probabilities: Partial<Record<Route, number>>;
  /** The decision call's input tokens, as the provider counted them; null when it doesn't say. */
  inputTokens: number | null;
}

/** The confidence from which a write or an edit is forced. */
export const FORCED_FROM = 0.6;

const INSTRUCTIONS =
  "The User is working beside their page (a Mind) and asks the assistant this. Decide what the request is.";

/** The three kinds, as the app's turn rule says them, the Chinese words beside the English. */
export const ROUTES: Readonly<Record<Route, string>> = {
  write:
    "A piece of writing to keep: they ask to write, draft, summarise, prepare or put together something (写、起草、整理、总结、准备一份), such as a summary, report, memo, notes, plan or letter (总结、报告、备忘录、笔记、计划、信).",
  edit: "A change to their own text on the page: shorten, expand, fix, rewrite, translate, add or remove a part (缩短、扩写、修正、改写、翻译、增加或删去一部分).",
  answer:
    "A question, an explanation, an opinion or ideas (提问、解释、征求意见或想法): answered in the reply, nothing on the page changed.",
};

const ENDPOINTS: Readonly<Record<DecisionProvider, string>> = {
  openai: "https://api.openai.com/v1/decisions",
  jev: "https://api.typesafe.ai/v1/systemone",
};

/** What the decision model reads: the page in front, the conversation so far, then the request. */
export function decisionInput(input: {
  request: string;
  page: "empty" | "text" | "none";
  earlier: readonly string[];
}): string {
  const page =
    input.page === "none"
      ? "No page is open in front."
      : input.page === "empty"
        ? "The page in front is empty."
        : "The page in front already has text.";
  return [
    page,
    ...(input.earlier.length > 0
      ? [
          `Earlier in this conversation the User asked: ${input.earlier.map((each) => `“${each}”`).join(", ")}.`,
        ]
      : []),
    `The request: ${input.request}`,
  ].join("\n");
}

function requestBody(provider: DecisionProvider, text: string): unknown {
  if (provider === "openai") {
    return {
      model: "gpt-6-luna",
      input: text,
      questions: [
        {
          type: "choice",
          name: "route",
          instructions: INSTRUCTIONS,
          choices: (Object.keys(ROUTES) as Route[]).map((value) => ({
            value,
            description: ROUTES[value],
          })),
        },
      ],
    };
  }
  return {
    model: "jev-1.13.0",
    state: text,
    questions: { route: { type: "choice", instructions: INSTRUCTIONS, criteria: ROUTES } },
  };
}

const isRoute = (value: unknown): value is Route =>
  value === "write" || value === "edit" || value === "answer";

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** The decision in a provider's reply, by the shapes of 2026-10-21; throws on one it can't read. */
export function readDecision(provider: DecisionProvider, body: unknown): Decision {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const reply = record(body);
  const answer =
    provider === "openai"
      ? record(Array.isArray(reply.answers) ? reply.answers[0] : undefined)
      : record(record(reply.answers).route);
  if (!isRoute(answer.choice)) {
    throw new Error(`The ${provider} decision has no choice the evaluation knows.`);
  }
  const probabilities: Partial<Record<Route, number>> = {};
  if (Array.isArray(answer.probabilities)) {
    for (const each of answer.probabilities) {
      const entry = record(each);
      if (isRoute(entry.value)) probabilities[entry.value] = numberOr(entry.probability, 0);
    }
  } else {
    for (const [value, probability] of Object.entries(record(answer.probabilities))) {
      if (isRoute(value)) probabilities[value] = numberOr(probability, 0);
    }
  }
  const usage = record(reply.usage);
  return {
    provider,
    choice: answer.choice,
    confidence: numberOr(answer.confidence, 0),
    probabilities,
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
  };
}

/** Asks the decision model; the key is sent to its provider only. */
export async function decide(
  provider: DecisionProvider,
  key: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Decision> {
  const response = await fetchImpl(ENDPOINTS[provider], {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(requestBody(provider, text)),
  });
  if (!response.ok) throw new Error(`The ${provider} decision answered HTTP ${response.status}.`);
  return readDecision(provider, await response.json());
}

type CallOptions = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];

const COMMANDS: Readonly<Record<Exclude<Route, "answer">, readonly string[]>> = {
  write: ["create_mind", "add_to_mind"],
  edit: ["edit_mind"],
};

/** Whether a decision forces its command: a write or an edit, at `FORCED_FROM` or more. */
export const forces = (decision: Decision): boolean =>
  decision.choice !== "answer" && decision.confidence >= FORCED_FROM;

export interface Forcing {
  chatModels(inner: ChatModelFactory): ChatModelFactory;
  /** The decision the next Answer is asked under; null: none, as arm B. */
  begin(decision: Decision | null): void;
  /** How many of the Answer's model requests were forced to call a Tool. */
  end(): number;
}

type Prompt = readonly { role: string; content: unknown }[];

const callsOneOf = (prompt: Prompt, tools: readonly string[]): boolean =>
  prompt.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part: { type?: string; toolName?: string }) =>
          part.type === "tool-call" && tools.includes(part.toolName ?? ""),
      ),
  );

/**
 * The chat model's requests, forced while the decision forces one: each that
 * offers the command and comes before the Answer called it must call a Tool.
 * Anthropic's models can't think on a forced call, so thinking is off on it.
 */
export function forcing(): Forcing {
  let decision: Decision | null = null;
  let from: number | null = null;
  let forced = 0;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    transformParams: async ({ params, model }) => {
      if (!decision || !forces(decision)) return params;
      const commands = COMMANDS[decision.choice as Exclude<Route, "answer">];
      const offered = (params.tools ?? []).map((tool) => tool.name);
      if (!commands.some((command) => offered.includes(command))) return params;
      from ??= params.prompt.length - 1;
      if (callsOneOf(params.prompt.slice(from), commands)) return params;
      forced++;
      const options = params.providerOptions ?? {};
      const forcedParams: CallOptions = {
        ...params,
        toolChoice: { type: "required" },
      };
      const { anthropic } = options;
      if (anthropic || model.provider.startsWith("anthropic")) {
        const { thinking: _thinking, ...withoutThinking } = anthropic ?? {};
        forcedParams.reasoning = "none";
        forcedParams.providerOptions = { ...options, anthropic: withoutThinking };
      }
      return forcedParams;
    },
  };
  return {
    chatModels: (inner) => (spec) => wrapLanguageModel({ model: inner(spec), middleware }),
    begin(next) {
      decision = next;
      from = null;
      forced = 0;
    },
    end: () => forced,
  };
}
