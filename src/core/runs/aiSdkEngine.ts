/**
 * The Run engine on AI SDK 7 (see ./engine): `streamText` with `stopWhen` and
 * `prepareStep`, the loop its `ToolLoopAgent` wraps. It is the loop Answers
 * ran before the seam (#63), moved here unchanged:
 * - the last model call, or one with no room left in the window, is offered
 *   no Tools (`toolChoice: "none"`);
 * - each Tool's `execute` awaits `gate`, then calls the Tool, and fits what
 *   the model reads to the window;
 * - a provider's refusal before any output is a "refused" event, any other
 *   failure a "failed" one, sorted by the model layer (../providers/providerErrors).
 *
 * Steering and compaction go through `prepareStep`. AI SDK 7 carries the
 * messages it returns into the steps after, so each step's history is
 * rebuilt from the Run's own (the initial messages, the responses so far and
 * the steering, where each was taken), never built on what was sent before:
 * a steering message is sent once, and a compacted history is never compacted again.
 */

import {
  jsonSchema,
  type ModelMessage,
  type StopCondition,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
} from "ai";
import Ajv, { type ValidateFunction } from "ajv";
import {
  cacheProviderOptions,
  stablePrefixOf,
  stablePrefixOptions,
  tokenUsageOf,
} from "../providers/promptCache";
import {
  classifyProviderError,
  contextOverflow,
  refusesFeature,
} from "../providers/providerErrors";
import type { RunEngine, RunEvent, RunMessage, RunRequest, RunTool } from "./engine";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks a call's arguments against its Tool's JSON Schema; the AI SDK passes
 * them on unchecked unless the schema has a `validate`. Leniently, as
 * `RunTool` says: formats aren't checked, unknown keywords are ignored, and a
 * copy is checked with what small models send taken as meant (see `asMeant`
 * and `coerceTypes`, which also takes text as the number or true/false a
 * schema wants, and null as any of these).
 */
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: true,
  validateFormats: false,
  logger: false,
});

/** Compiled schemas, by their JSON: null for one Ajv can't compile, whose calls go unchecked. */
const validators = new Map<string, ValidateFunction | null>();

function validatorFor(schema: Record<string, unknown>): ValidateFunction | null {
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (validate === undefined) {
    try {
      validate = ajv.compile(schema);
    } catch {
      validate = null;
    }
    validators.set(key, validate);
  }
  return validate;
}

function readJsonText(value: unknown): unknown {
  let meant = value;
  for (let encodings = 0; typeof meant === "string" && encodings < 2; encodings++) {
    try {
      meant = JSON.parse(meant);
    } catch {
      break;
    }
  }
  return meant;
}

const typeWanted = (schema: Record<string, unknown>, name: string): unknown => {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  return (properties[name] as { type?: unknown } | undefined)?.type;
};

/**
 * A copy of the arguments to check, as a small model meant them: an optional
 * one sent as null is left out, one sent as JSON text where the schema wants
 * an array or an object is parsed, and one object where it wants an array is
 * that array's only item.
 */
function asMeant(input: Record<string, unknown>, schema: Record<string, unknown>) {
  const copy = structuredClone(input);
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const [name, value] of Object.entries(copy)) {
    const wanted = typeWanted(schema, name);
    if (value === null && !required.includes(name)) {
      delete copy[name];
    } else if (wanted === "array" || wanted === "object") {
      const meant = readJsonText(value);
      if (wanted === "array" ? Array.isArray(meant) : isPlainObject(meant)) copy[name] = meant;
      else if (wanted === "array" && isPlainObject(meant)) copy[name] = [meant];
    }
  }
  return copy;
}

/** The arguments a Tool gets: as sent, but an object sent where an array is wanted is that array's only item. */
function forTool(input: Record<string, unknown>, schema: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    const meant = typeWanted(schema, name) === "array" ? readJsonText(value) : null;
    out[name] = isPlainObject(meant) ? [meant] : value;
  }
  return out;
}

/**
 * A Tool's JSON Schema as the AI SDK takes it, checking each call's arguments
 * (see `RunTool`). The Tool gets them as the model sent them.
 */
function checkedSchema(schema: Record<string, unknown>) {
  return jsonSchema<Record<string, unknown>>(schema, {
    validate: (value) => {
      const validate = validatorFor(schema);
      if (!validate || validate(isPlainObject(value) ? asMeant(value, schema) : value)) {
        return { success: true, value: value as Record<string, unknown> };
      }
      return {
        success: false,
        error: new Error(
          `The arguments don't match the Tool's schema: ${ajv.errorsText(validate.errors, { dataVar: "arguments" })}.`,
        ),
      };
    },
  });
}

/**
 * Tools as the AI SDK takes them: each by its name, with its description,
 * JSON Schema and call. Arguments a model sends that aren't an object are
 * taken as none. (The one place Tools meet the loop's library.)
 */
export function toToolSet(
  tools: readonly RunTool[],
  signal: AbortSignal,
  canCallAgain: () => boolean = () => true,
): ToolSet {
  const set: ToolSet = {};
  for (const each of tools) {
    set[each.name] = tool({
      description: each.description,
      inputSchema: checkedSchema(each.inputSchema),
      execute: async (input, { abortSignal, toolCallId }) =>
        each.call(isPlainObject(input) ? forTool(input, each.inputSchema) : {}, {
          toolCallId,
          signal: abortSignal ?? signal,
          canCallAgain,
        }),
    });
  }
  return set;
}

/** Rejects with the signal's reason as soon as it aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** A Tool whose call goes through `gate` first, and whose result is fitted to the window. */
function gated(each: RunTool, { gate, window, signal }: RunRequest): RunTool {
  return {
    ...each,
    async call(input, context) {
      const decision = await raceAbort(
        gate({ id: context.toolCallId, tool: each.name, input }),
        signal,
      );
      const text = decision.run ? await each.call(input, context) : decision.result;
      return window ? window.fitResult(text, each.name) : text;
    },
  };
}

/** A Run's messages as the AI SDK takes them; the results of one step's calls go in one message. */
function toModelMessages(messages: readonly RunMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content: message.text,
        ...(message.stablePrefix && { providerOptions: stablePrefixOptions(message.stablePrefix) }),
      });
    } else if (message.role === "assistant") {
      out.push(
        message.toolCalls.length === 0
          ? { role: "assistant", content: message.text }
          : {
              role: "assistant",
              content: [
                ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
                ...message.toolCalls.map((call) => ({
                  type: "tool-call" as const,
                  toolCallId: call.id,
                  toolName: call.tool,
                  input: call.input,
                })),
              ],
            },
      );
    } else {
      const part = {
        type: "tool-result" as const,
        toolCallId: message.id,
        toolName: message.tool,
        output: {
          type: message.ok ? ("text" as const) : ("error-text" as const),
          value: message.result,
        },
      };
      const last = out.at(-1);
      if (last?.role === "tool") last.content.push(part);
      else out.push({ role: "tool", content: [part] });
    }
  }
  return out;
}

/** What the model read of a Tool result, as text. */
const outputText = (output: unknown): string => {
  const value = isPlainObject(output) && "value" in output ? output.value : output;
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
};

/** The AI SDK's messages in IncarnaMind's form: text, Tool calls and Tool results. */
function fromModelMessages(messages: readonly ModelMessage[]): RunMessage[] {
  const out: RunMessage[] = [];
  const textOf = (content: ModelMessage["content"]) =>
    typeof content === "string"
      ? content
      : content.map((part) => (part.type === "text" ? part.text : "")).join("");
  for (const message of messages) {
    if (message.role === "user") {
      const stablePrefix = stablePrefixOf(message.providerOptions);
      out.push({
        role: "user",
        text: textOf(message.content),
        ...(stablePrefix && { stablePrefix }),
      });
    } else if (message.role === "assistant") {
      const parts = typeof message.content === "string" ? [] : message.content;
      out.push({
        role: "assistant",
        text: textOf(message.content),
        toolCalls: parts.flatMap((part) =>
          part.type === "tool-call"
            ? [
                {
                  id: part.toolCallId,
                  tool: part.toolName,
                  input: isPlainObject(part.input) ? part.input : {},
                },
              ]
            : [],
        ),
      });
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const kind = isPlainObject(part.output) ? part.output.type : undefined;
        out.push({
          role: "tool",
          id: part.toolCallId,
          tool: part.toolName,
          result: outputText(part.output),
          ok: kind !== "error-text" && kind !== "error-json" && kind !== "execution-denied",
        });
      }
    }
  }
  return out;
}

/** Messages with others put in where they were taken: `at` counts the messages before, without them. */
function splice(
  messages: readonly ModelMessage[],
  inserted: readonly { at: number; message: ModelMessage }[],
): ModelMessage[] {
  const out: ModelMessage[] = [];
  let next = 0;
  for (let at = 0; at <= messages.length; at++) {
    while (inserted[next]?.at === at)
      out.push((inserted[next++] as { message: ModelMessage }).message);
    const message = messages[at];
    if (message) out.push(message);
  }
  return out;
}

/**
 * The AI SDK's reasoning parts as "reasoning" events: a block starts with an
 * empty one, and a block after another starts a new paragraph. Null for a
 * part with no text.
 */
export function reasoningReader() {
  let reasoned = false;
  let newParagraph = false;
  return (
    part: { type: "reasoning-start" } | { type: "reasoning-delta"; text: string },
  ): Extract<RunEvent, { type: "reasoning" }> | null => {
    if (part.type === "reasoning-start") {
      newParagraph = reasoned;
      return { type: "reasoning", text: "" };
    }
    if (!part.text) return null;
    const text = newParagraph ? `\n\n${part.text}` : part.text;
    newParagraph = false;
    reasoned = true;
    return { type: "reasoning", text };
  };
}

/** A failed model call as an event: a refusal before any output (see `RunEvent`), or a failure. */
function failure(
  error: unknown,
  request: RunRequest,
  produced: boolean,
): Extract<RunEvent, { type: "refused" | "failed" }> {
  if (!produced) {
    const overflow = request.window ? contextOverflow(error) : null;
    if (overflow) {
      return {
        type: "refused",
        what: "too-long",
        ...(overflow.promptTokens !== null && { promptTokens: overflow.promptTokens }),
      };
    }
    if (request.temperature !== undefined && refusesFeature(error, "temperature")) {
      return { type: "refused", what: "temperature" };
    }
    if (request.tools.length > 0 && refusesFeature(error, "tools")) {
      return { type: "refused", what: "tools" };
    }
  }
  return { type: "failed", error: classifyProviderError(error) };
}

async function* run(request: RunRequest): AsyncGenerator<RunEvent> {
  const { signal, window, maxSteps } = request;
  let canCallAgain = maxSteps > 2;
  const tools = toToolSet(
    request.tools.map((each) => gated(each, request)),
    signal,
    () => canCallAgain && (window === undefined || window.canCallTools()),
  );
  const initial = toModelMessages(request.messages);
  /** Steering messages, where each was taken among the responses. */
  const inserted: { at: number; message: ModelMessage }[] = [];

  const result = streamText({
    model: request.model,
    instructions: request.instructions,
    messages: initial,
    tools,
    temperature: request.temperature,
    providerOptions: cacheProviderOptions(request.cacheKey),
    stopWhen: [
      stepCountIs(maxSteps) as StopCondition<ToolSet>,
      ({ steps }) => {
        const last = steps.at(-1);
        return (
          last !== undefined &&
          (request.endsAfter?.({
            text: last.text,
            calls: last.toolCalls.map((call) => ({ id: call.toolCallId, tool: call.toolName })),
          }) ??
            false)
        );
      },
    ],
    prepareStep: ({ stepNumber, initialMessages, responseMessages }) => {
      if (stepNumber > 0) {
        for (const message of request.steering?.() ?? []) {
          for (const each of toModelMessages([message])) {
            inserted.push({ at: responseMessages.length, message: each });
          }
        }
      }
      const compact = stepNumber > 0 ? window?.compact : undefined;
      let messages: ModelMessage[] | undefined;
      if (inserted.length > 0 || compact) {
        messages = [...initialMessages, ...splice(responseMessages, inserted)];
        if (compact) messages = toModelMessages(compact(fromModelMessages(messages)));
      }
      // The last step must write; so must a step with no room left for a Tool's result.
      const write = stepNumber >= maxSteps - 1 || (window !== undefined && !window.canCallTools());
      canCallAgain = stepNumber + 1 < maxSteps - 1;
      return { ...(messages && { messages }), ...(write && { toolChoice: "none" as const }) };
    },
    abortSignal: signal,
    // Errors arrive as stream parts; don't also log them.
    onError: () => undefined,
  });

  let produced = false;
  const reasoning = reasoningReader();
  /** Inputs being written, by call: their Tool, and their JSON text so far. */
  const inputs = new Map<string, { tool: RunTool; text: string }>();
  try {
    for await (const part of result.fullStream) {
      if (signal.aborted || part.type === "abort") return;
      switch (part.type) {
        case "tool-input-start": {
          const tool = request.tools.find((each) => each.name === part.toolName);
          if (!tool?.streamInput || !request.streamsInput?.(tool.name)) break;
          produced = true;
          inputs.set(part.id, { tool, text: "" });
          yield { type: "tool-input-started", id: part.id, tool: part.toolName };
          break;
        }
        case "tool-input-delta": {
          const input = inputs.get(part.id);
          if (!input) break;
          input.text += part.delta;
          input.tool.streamInput?.(part.id, input.text);
          break;
        }
        case "text-delta":
          if (!part.text) break;
          produced = true;
          yield { type: "text-delta", text: part.text };
          break;
        case "reasoning-start":
        case "reasoning-delta": {
          const event = reasoning(part);
          if (!event) break;
          if (event.text) produced = true;
          yield event;
          break;
        }
        case "tool-call":
          produced = true;
          yield {
            type: "tool-call",
            id: part.toolCallId,
            tool: part.toolName,
            input: isPlainObject(part.input) ? part.input : {},
          };
          break;
        case "tool-result":
          yield { type: "tool-result", id: part.toolCallId, ok: true };
          break;
        case "tool-error":
          yield { type: "tool-result", id: part.toolCallId, ok: false };
          break;
        case "finish-step": {
          const usage = tokenUsageOf(part.usage);
          window?.stepFinished(usage);
          yield { type: "step-finished", usage };
          break;
        }
        case "error":
          yield failure(part.error, request, produced);
          return;
      }
    }
    if (signal.aborted) return;
    const messages = fromModelMessages(splice(await result.responseMessages, inserted));
    yield { type: "finished", messages };
  } catch (error) {
    if (signal.aborted) return;
    yield failure(error, request, produced);
  }
}

/** The Run engine on AI SDK 7. */
export function createAiSdkRunEngine(): RunEngine {
  return { run };
}
