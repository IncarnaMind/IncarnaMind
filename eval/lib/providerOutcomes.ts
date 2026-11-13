/**
 * What the provider answered each model request a run sent (#2847's gate, its rule 1): finished,
 * stopped by the app, or the provider's own failure, named from the request's own status. Only a
 * provider's failure leaves a pair out, to be pressed again; a press the app itself failed has its
 * requests finished and stays in. Nothing is sent or changed by it.
 */
import {
  APICallError,
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai";

/**
 * "finished"; "stopped" by the app; the provider's own failure: "rate limited", "overloaded",
 * "server error <status>", "refused <status>", "timeout" or "network failure"; or "failed", an
 * error no provider gave.
 */
export type RequestOutcome = string;

export interface SentOutcome {
  /** The app's request (an Answer's, its check's, its ask for Citations) or the eval's judge's. */
  kind: "app" | "judge";
  outcome: RequestOutcome;
}

type Wrapped = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type StreamPart =
  Awaited<ReturnType<Wrapped["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const NETWORK =
  /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed/i;

/** What a request's error says the provider answered. */
export function outcomeOf(error: unknown): RequestOutcome {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === undefined) return "network failure";
    if (status === 429) return "rate limited";
    if (status === 529) return "overloaded";
    if (status === 408) return "timeout";
    return status >= 500 ? `server error ${status}` : `refused ${status}`;
  }
  // An error a provider streams after its headers: Anthropic's names its type.
  const type = typeof error === "object" && error !== null && "type" in error ? error.type : null;
  if (type === "overloaded_error") return "overloaded";
  if (type === "rate_limit_error") return "rate limited";
  if (type === "api_error") return "server error";
  if (type === "timeout_error") return "timeout";
  if (!(error instanceof Error)) return "failed";
  if (error.name === "TimeoutError") return "timeout";
  if (error.name === "AbortError") return "stopped";
  return NETWORK.test(`${error.message} ${String(error.cause ?? "")}`)
    ? "network failure"
    : "failed";
}

/** Whether `outcome` is the provider's own failure, which leaves its pair out under rule 1. */
export const byProvider = (outcome: RequestOutcome) =>
  outcome !== "finished" && outcome !== "stopped" && outcome !== "failed";

/** A recorder of each request's outcome, the app's and the judge's apart. */
export function providerOutcomes() {
  let kept: SentOutcome[] = [];
  const middleware = (kind: SentOutcome["kind"]): LanguageModelMiddleware => ({
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const sent: SentOutcome = { kind, outcome: "stopped" };
      kept.push(sent);
      try {
        const result = await doGenerate();
        sent.outcome = "finished";
        return result;
      } catch (error) {
        sent.outcome = outcomeOf(error);
        throw error;
      }
    },
    wrapStream: async ({ doStream }) => {
      const sent: SentOutcome = { kind, outcome: "stopped" };
      kept.push(sent);
      let settled = false;
      const settle = (outcome: RequestOutcome) => {
        if (settled) return;
        settled = true;
        sent.outcome = outcome;
      };
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        settle(outcomeOf(error));
        throw error;
      }
      const reader = result.stream.getReader();
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            if (value.type === "finish") settle("finished");
            else if (value.type === "error") settle(outcomeOf(value.error));
            controller.enqueue(value);
          } catch (error) {
            settle(outcomeOf(error));
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
        },
      });
      return { ...result, stream };
    },
  });
  return {
    /** `model`, each of its requests' outcomes kept as `kind`. */
    wrap: <Model extends Exclude<LanguageModel, string>>(model: Model, kind: SentOutcome["kind"]) =>
      wrapLanguageModel({ model, middleware: middleware(kind) }),
    /** The outcomes of the requests sent since it was last asked; one still streaming settles in place. */
    take: (): SentOutcome[] => {
      const taken = kept;
      kept = [];
      return taken;
    },
  };
}
