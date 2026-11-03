import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  NoOutputGeneratedError,
  RetryError,
  StreamProviderError,
  TypeValidationError,
  UnsupportedFunctionalityError,
} from "ai";
import type { Money, ProviderError, ProviderErrorKind, SignInRouteProblem } from "../api";
import {
  ConsentDeclinedError,
  ConsentRevokedError,
  isRecord,
  LocalModeError,
  TranslatableError,
} from "../errors";
import { OAuthTokenError } from "../oauth";
import { isSignInUnreadable } from "../oauthAccount";
import { KeyCharacterError } from "./apiKey";
import { ChatGptPlanError, ChatGptSignInRequiredError } from "./chatgpt/errors";
import { JevRequestError } from "./jev";
import { CutShortError } from "./outputLimits";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function keyCharacterOf(message: string): KeyCharacterError | null {
  const code =
    /Cannot convert argument to a ByteString because the character at index \d+ has a value of (\d+)/.exec(
      message,
    )?.[1];
  return code === undefined ? null : new KeyCharacterError(String.fromCharCode(Number(code)));
}

/** A local model can't take a request, found before anything is sent: e.g. it isn't a chat model. */
export class LocalModelError extends Error {
  constructor(
    readonly kind: Extract<ProviderErrorKind, "model" | "too-long">,
    message: string,
  ) {
    super(message);
    this.name = "LocalModelError";
  }
}

export class OllamaNotRunningError extends TranslatableError {
  override name = "OllamaNotRunningError";
  constructor() {
    super({ key: "error.provider.ollamaNotRunning" });
  }
}

/** A request could pass the User's monthly cap, so it wasn't sent (see ../cost/meter). */
export class CostCapError extends Error {
  override name = "CostCapError";
  constructor() {
    super("The monthly cap would be passed, so nothing was sent.");
  }
}

/**
 * A request would take its Run past the most the User agreed it may spend (`budget`): nothing was
 * sent. `spent`: what the Run's requests had settled at.
 */
export class RunBudgetError extends Error {
  override name = "RunBudgetError";
  constructor(
    readonly budget: Money,
    readonly spent: Money,
  ) {
    super(
      `The Run's budget of ${budget.amount} ${budget.currency} would be passed, so nothing was sent.`,
    );
  }
}

/**
 * A plan's own allowance stopped a request: an Ollama Cloud account's usage is
 * used up. (The ChatGPT plan's limit is `ChatGptPlanError`.)
 */
export class PlanLimitError extends Error {
  override name = "PlanLimitError";
  constructor(
    message: string,
    /** When the limit resets (epoch milliseconds), when the provider says. */
    readonly resetsAt: number | null = null,
  ) {
    super(message);
  }
}

/**
 * A route signed in with the User's own account (a Claude account, Copilot)
 * stopped, for one of the reasons its own lines and ways back explain (./signInRoutes).
 */
export class SignInRouteError extends Error {
  override name = "SignInRouteError";
  constructor(
    readonly problem: Exclude<SignInRouteProblem, "sign-in-cancelled">,
    message: string,
    /** When the plan's limit resets (epoch milliseconds), when the provider says. */
    readonly resetsAt: number | null = null,
  ) {
    super(message);
  }
}

/**
 * A Claude account's plan limit, which tagging waits out (../library/planPace).
 * Copilot's is a monthly allowance, so its tagging fails instead.
 */
export class ClaudePlanLimitError extends SignInRouteError {
  constructor(message: string, resetsAt: number | null) {
    super("plan-limit", message, resetsAt);
  }
}

const ROUTE_KINDS: Record<SignInRouteError["problem"], ProviderErrorKind> = {
  "signed-out": "not-signed-in",
  "sign-in-expired": "not-signed-in",
  refused: "blocked",
  "plan-limit": "plan-limit",
  "unexpected-response": "provider",
  "no-plan": "blocked",
  "policy-blocked": "blocked",
  "model-unavailable": "model",
  "rate-limited": "rate-limit",
};

/** When a reached limit resets, as ISO 8601, from an error that says (epoch milliseconds). */
function resetsAtOf(error: Error): { resetsAt?: string } {
  const at = "resetsAt" in error && typeof error.resetsAt === "number" ? error.resetsAt : null;
  return at === null ? {} : { resetsAt: new Date(at).toISOString() };
}

/**
 * Ollama's refusal of a request longer than the model's context window (sent
 * with `truncate: false`): "request (6029 tokens) exceeds the available
 * context size (4096 tokens)". The counts, when it gives them.
 */
export function contextOverflow(
  error: unknown,
): { promptTokens: number | null; windowTokens: number | null } | null {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(cause) || cause.statusCode !== 400) return null;
  const text = `${cause.message} ${cause.responseBody ?? ""}`;
  if (!/exceeds? the available context size|exceed_context_size/i.test(text)) return null;
  const count = (pattern: RegExp) => {
    const found = pattern.exec(text);
    return found ? Number(found[1]) : null;
  };
  return {
    promptTokens: count(/request \((\d+) tokens?\)/i),
    windowTokens: count(/context size \((\d+) tokens?\)/i),
  };
}

/**
 * Whether a provider refused a request because the model can't use `feature`:
 * e.g. Ollama's "model does not support tools", vLLM's "--enable-auto-tool-choice",
 * a server that rejects `response_format`, or OpenAI's "Unsupported parameter:
 * 'temperature'" for a reasoning model. Auth, rate limits and outages never count.
 */
export function refusesFeature(
  error: unknown,
  feature: "tools" | "structured-output" | "temperature",
): boolean {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const subject =
    feature === "tools"
      ? /tool|function/i
      : feature === "temperature"
        ? /temperature/i
        : /response_format|response format|json_schema|json schema|json mode|json_object|structured output|format/i;
  if (UnsupportedFunctionalityError.isInstance(cause)) return subject.test(cause.functionality);
  if (!APICallError.isInstance(cause)) return false;
  const status = cause.statusCode;
  if (status === undefined || [401, 403, 404, 408, 429].includes(status) || status >= 502) {
    return false;
  }
  const text = `${cause.message} ${cause.responseBody ?? ""}`;
  const refusal =
    /not support|unsupported|doesn't support|does not support|not enabled|not available|isn't available|requires --|requires the --|not allowed|is invalid|invalid value|unknown (?:field|parameter|argument)|unrecognized/i;
  // A temperature is also refused as deprecated, or as other than the default.
  const temperatureRefusal = /deprecated|only the default/i;
  return (
    subject.test(text) &&
    (refusal.test(text) || (feature === "temperature" && temperatureRefusal.test(text)))
  );
}

/**
 * Sorts a failed provider request into a kind the UI can explain: a bad key,
 * an unknown model, rate limiting, no connection, a request the provider
 * refused, a reply that couldn't be read, or the provider's own error. Keeps
 * the provider's HTTP status, when it gave one, for the log.
 * For the ChatGPT plan, also a missing or expired sign-in, a reached plan
 * limit, or OpenAI refusing the sign-in; for a route signed in with the
 * User's own account (Claude, Copilot), its own problems (`signInRoute`); for an Ollama Cloud model, its
 * used-up allowance; for any priced model, the monthly cap. Jev's errors come sorted already.
 * For a local model, a request too long for its context window.
 * Answers (#29) reuse it for errors shown inside an Answer.
 */
export function classifyProviderError(error: unknown): ProviderError {
  const retried = RetryError.isInstance(error) ? error.lastError : error;
  // A plan's refusal that ends a stream arrives wrapped in the AI SDK's own error.
  const cause =
    retried instanceof Error &&
    (retried.cause instanceof ChatGptPlanError ||
      retried.cause instanceof PlanLimitError ||
      retried.cause instanceof SignInRouteError)
      ? retried.cause
      : retried;
  const sorted = sortedError(cause);
  const status = isRecord(cause) ? (cause.statusCode ?? cause.status) : undefined;
  return typeof status === "number" ? { ...sorted, status } : sorted;
}

// What providers say when the account has no credit left: Anthropic's 400, OpenAI's and Kimi's 429,
// DeepSeek's and OpenRouter's 402, xAI's 403, and Zhipu's and Alibaba's by Chinese words or code.
const OUT_OF_CREDIT =
  /credit balance is too low|insufficient[_ ](?:balance|credits?|funds|quota)|exceeded[_ ]current[_ ]quota|billing[_ ]hard[_ ]limit|out of (?:credits?|balance)|used all (?:of )?(?:its |your )?available credits|(?:add|purchase) more credits|balance (?:is |has )?(?:too low|insufficient|exhausted|not enough)|arrearage|余额不足|欠费/i;

// OpenAI's "Country, region, or territory not supported" and Gemini's "User location is not supported".
const NOT_SERVED_HERE =
  /unsupported_country_region_territory|country, region, or territory not supported|(?:country|region|location|territory) (?:is )?not supported|not available in your (?:country|region|location)/i;

// Anthropic's 403 where it isn't available, with nothing more to say: any other words after it are a key's own limits.
const BARE_FORBIDDEN = /^request not allowed\.?$/i;

const TOO_LONG =
  /context[_ ]length|prompt is too long|maximum context|exceeds? the (?:maximum )?(?:number of )?(?:context|tokens)|exceeds? (?:the )?max(?:imum)? length|input token count|token limit|too many tokens/i;

/**
 * What a provider says of a failure, for telling its kind: its message and the code and type of
 * its error, not its whole body, which some servers fill with the request they were sent.
 */
function wordsOf(message: string, body: string | undefined): string {
  let fields: unknown;
  try {
    fields = body ? JSON.parse(body) : undefined;
  } catch {
    // A body that isn't JSON has no code or type to read.
    return message;
  }
  const error = isRecord(fields) && isRecord(fields.error) ? fields.error : fields;
  if (!isRecord(error)) return message;
  const named = [error.code, error.type, error.status].filter(
    (value): value is string => typeof value === "string",
  );
  return [message, ...named].join(" ");
}

function sortedError(cause: unknown): ProviderError {
  const message = messageOf(cause);

  const badKey = cause instanceof KeyCharacterError ? cause : keyCharacterOf(message);
  if (badKey) {
    return {
      kind: "auth",
      message: badKey.message,
      ...(badKey.wording && { wording: badKey.wording }),
    };
  }
  if (cause instanceof CutShortError) return { kind: "cut-short", message };
  if (cause instanceof ConsentDeclinedError) return { kind: "consent-declined", message };
  if (cause instanceof ConsentRevokedError || cause instanceof LocalModeError) {
    return {
      kind: cause instanceof LocalModeError ? "local-mode" : "consent-revoked",
      message,
      ...(cause.wording && { wording: cause.wording }),
    };
  }
  if (cause instanceof LocalModelError) return { kind: cause.kind, message };
  if (cause instanceof OllamaNotRunningError) {
    return {
      kind: "ollama-not-running",
      message,
      ...(cause.wording && { wording: cause.wording }),
    };
  }
  if (contextOverflow(cause)) return { kind: "too-long", message };
  if (cause instanceof JevRequestError) return { kind: cause.kind, message };
  if (isSignInUnreadable(cause)) {
    return {
      kind: "provider",
      message,
      ...(cause.wording && { wording: cause.wording }),
    };
  }
  if (cause instanceof ChatGptSignInRequiredError) return { kind: "not-signed-in", message };
  if (cause instanceof ChatGptPlanError) return { kind: cause.kind, message, ...resetsAtOf(cause) };
  if (cause instanceof PlanLimitError) return { kind: "plan-limit", message, ...resetsAtOf(cause) };
  if (cause instanceof SignInRouteError) {
    return {
      kind: ROUTE_KINDS[cause.problem],
      message,
      signInRoute: cause.problem,
      ...resetsAtOf(cause),
    };
  }
  if (cause instanceof CostCapError) return { kind: "cost-cap", message };
  if (cause instanceof RunBudgetError) {
    return { kind: "cost-cap", message, budget: { most: cause.budget, spent: cause.spent } };
  }
  // A plan's sign-in couldn't be refreshed for a passing reason (e.g. the provider's server failed).
  if (cause instanceof OAuthTokenError) return { kind: "provider", message };

  // An error the provider sends once its reply has begun, e.g. Anthropic's "Overloaded", has a
  // status as a refused request does.
  const streamed = StreamProviderError.isInstance(cause);
  if (APICallError.isInstance(cause) || streamed) {
    const status = cause.statusCode;
    // No status: the request never got a response, or the provider's error didn't say.
    if (status === undefined) return { kind: streamed ? "provider" : "network", message };
    // A reply cut off partway: the SDK wraps the connection's error (Node's "terminated") in an
    // error that has the status of the reply.
    if (status >= 200 && status < 300 && APICallError.isInstance(cause) && cause.cause) {
      const inner = sortedError(cause.cause);
      if (inner.kind === "network") return inner;
    }
    const said = streamed ? message : `${message} ${cause.responseBody ?? ""}`;
    const words = streamed ? message : wordsOf(message, cause.responseBody);
    // Said with a 402, 429 (OpenAI, Kimi), 400 (Anthropic) or 403 (xAI) alike, so before the key's and the rate limit's.
    if (
      status === 402 ||
      (status >= 400 && status < 500 && status !== 401 && OUT_OF_CREDIT.test(words))
    ) {
      return { kind: "out-of-credit", message };
    }
    if (
      ([400, 403, 451].includes(status) && NOT_SERVED_HERE.test(words)) ||
      (status === 403 && BARE_FORBIDDEN.test(message.trim()))
    ) {
      return { kind: "region", message };
    }
    if (status === 401 || status === 403) return { kind: "auth", message };
    if (status === 413 || ([400, 422].includes(status) && TOO_LONG.test(words))) {
      return { kind: "too-long", message };
    }
    if (status === 400 && /must have data retention enabled/i.test(said)) {
      return { kind: "data-retention", message };
    }
    // Google answers a bad key with 400 "API key not valid", in the body when the message is only the status.
    if (status === 400 && /api[ _-]?key/i.test(said)) return { kind: "auth", message };
    if (status === 404) return { kind: "model", message };
    if (status === 408) return { kind: "network", message };
    if (status === 429) return { kind: "rate-limit", message };
    // The provider answered, but not in a form that can be read.
    if (status >= 200 && status < 300) return { kind: "no-answer", message };
    if (status >= 400 && status < 500) return { kind: "refused", message };
    if (status >= 500) return { kind: "provider", message };
    return { kind: "unknown", message };
  }
  // A reply that couldn't be read. These errors quote the reply, so only their name is kept.
  if (
    JSONParseError.isInstance(cause) ||
    TypeValidationError.isInstance(cause) ||
    InvalidResponseDataError.isInstance(cause) ||
    EmptyResponseBodyError.isInstance(cause) ||
    NoOutputGeneratedError.isInstance(cause)
  ) {
    return { kind: "no-answer", message: `The model's reply couldn't be read (${cause.name}).` };
  }

  if (cause instanceof Error) {
    if (cause.name === "AbortError" || cause.name === "TimeoutError") {
      return { kind: "network", message };
    }
    // Node's fetch says "terminated" when the connection ends partway through a reply.
    if (cause instanceof TypeError && /fetch failed|network|^terminated$/i.test(message)) {
      return { kind: "network", message };
    }
  }
  return {
    kind: "unknown",
    message,
    ...(cause instanceof TranslatableError && cause.wording && { wording: cause.wording }),
  };
}
