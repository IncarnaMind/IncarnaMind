import { type LanguageModelMiddleware, StreamProviderError, wrapLanguageModel } from "ai";
import type { ProviderErrorKind } from "../api";
import { isRecord } from "../errors";
import type { ChatLanguageModel } from "./models";
import { classifyProviderError, refusesFeature } from "./providerErrors";

/** How a provider says this key or plan doesn't reach a model: not found, not allowed, not served here. */
const MODEL_REFUSED: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  "model",
  "blocked",
  "region",
  "data-retention",
]);

/** A model busy for now: its limit for the minute, or its server overloaded or failing. */
const BUSY: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>(["rate-limit", "provider"]);

/** Why a model gave way to another: refused for the model itself, or busy for now. */
export type GaveWay = "refused" | "busy";

/**
 * Whether `error` refuses the model itself, and so would refuse it again: a request the model
 * can't take as it is built (a Tool, a format, a temperature) is the engine's to send another way,
 * and a refusal of the request's shape would fail on any model.
 */
function refusesTheModel(error: unknown): boolean {
  const { kind, status, message } = classifyProviderError(error);
  if (MODEL_REFUSED.has(kind)) return true;
  // 401 is the key itself, which no other model on it gets past.
  if (kind === "auth") return status === 403;
  return (
    kind === "refused" &&
    /\bmodel\b/i.test(message) &&
    !(["tools", "structured-output", "temperature"] as const).some((feature) =>
      refusesFeature(error, feature),
    )
  );
}

const whyGivesWay = (error: unknown): GaveWay | null =>
  refusesTheModel(error) ? "refused" : BUSY.has(classifyProviderError(error).kind) ? "busy" : null;

/** Anthropic's words for a server too busy, which a stream may say with no status. */
const OVERLOADED = /^\s*(?:model )?overloaded(?: error)?\s*$/i;

/**
 * An error a stream sends as one of its parts, as the error a request is turned away with: a
 * provider's own record, e.g. Anthropic's `overloaded_error`, with its status where it gives one.
 */
function partError(error: unknown): unknown {
  if (error instanceof Error || !isRecord(error) || typeof error.message !== "string") return error;
  const status =
    typeof error.statusCode === "number"
      ? error.statusCode
      : OVERLOADED.test(error.message)
        ? 529
        : undefined;
  return new StreamProviderError({
    message: error.message,
    ...(status !== undefined && { statusCode: status }),
    data: error,
  });
}

type Wrapped = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type StreamResult = Awaited<ReturnType<Wrapped["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

/** The parts a stream opens with before any of its reply: nothing of them reaches the User. */
const BEFORE_REPLY: ReadonlySet<StreamPart["type"]> = new Set<StreamPart["type"]>([
  "stream-start",
  "response-metadata",
  "raw",
]);

/**
 * `model`, whose requests go to `instead` from the first its provider refuses for the model itself
 * or turns away as busy, before anything of its reply comes back (a stream that opens with such an
 * error included), and for every request after it. `switched` hears of it, with the error and
 * why, as the request goes to `instead`; `refused`, once `instead` has taken a request the provider
 * refused for the model, so a request `instead` refuses too fails as it would have.
 */
export function refusedGoesTo(
  model: ChatLanguageModel,
  instead: ChatLanguageModel,
  {
    switched,
    refused,
  }: { switched(error: unknown, why: GaveWay): void; refused(error: unknown): void },
): ChatLanguageModel {
  const other = wrapLanguageModel({ model: instead, middleware: [] });
  let away = false;
  const giveWay = async <T>(error: unknown, others: () => PromiseLike<T>): Promise<T> => {
    const why = whyGivesWay(error);
    if (why === null) throw error;
    away = true;
    switched(error, why);
    const taken = await others();
    if (why === "refused") refused(error);
    return taken;
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        if (away) return other.doGenerate(params);
        try {
          return await doGenerate();
        } catch (error) {
          return giveWay(error, () => other.doGenerate(params));
        }
      },
      wrapStream: async ({ doStream, params }) => {
        if (away) return other.doStream(params);
        let result: StreamResult;
        try {
          result = await doStream();
        } catch (error) {
          return giveWay(error, () => other.doStream(params));
        }
        const reader = result.stream.getReader();
        const opening: StreamPart[] = [];
        let failed: unknown = null;
        try {
          for (;;) {
            const read = await reader.read();
            if (read.done) break;
            const part = read.value;
            if (part.type === "error" && whyGivesWay(partError(part.error)) !== null) {
              failed = partError(part.error);
              break;
            }
            opening.push(part);
            if (!BEFORE_REPLY.has(part.type)) break;
          }
        } catch (error) {
          failed = error;
        }
        if (failed !== null) {
          await reader.cancel().catch(() => {});
          return giveWay(failed, () => other.doStream(params));
        }
        const stream = new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of opening) controller.enqueue(part);
          },
          async pull(controller) {
            const read = await reader.read();
            if (read.done) controller.close();
            else controller.enqueue(read.value);
          },
          cancel: (reason) => reader.cancel(reason),
        });
        return { ...result, stream };
      },
    },
  });
}
