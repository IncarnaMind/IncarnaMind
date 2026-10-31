/**
 * What a model can do, as known before IncarnaMind sends it anything. Facts
 * come from several places; when they disagree, the first that says wins:
 *
 * 1. What the User set on the model.
 * 2. What the server reports: Ollama's model details (`/api/show`, see
 *    ./ollamaModels), or a provider's model list where it gives
 *    capabilities (Anthropic's `/v1/models`, see ./modelLists).
 * 3. The catalog's entry for the model (see ./catalog).
 * 4. Unknown. The model still works, marked "capabilities unknown", and an
 *    Answer finds out as it goes, as before the catalog: it starts with
 *    Tools and steps down when they or structured output are refused, sends
 *    a temperature and drops it when refused, sends no images, and isn't
 *    sized to a window.
 *
 * Refusals are server reports too: what an Answer learns of a model (its
 * provider refused Tools, structured output or a temperature) holds over
 * what is known here for the rest of the session (see ../answers).
 */
import type { CitationSupport } from "../api";
import type { ModelFacts } from "./catalog";
import type { ContextWindow } from "./models";
import { LONGEST_OUTPUT } from "./outputLimits";

/** What one source says about a model: a field it leaves out, it doesn't say. */
export type ModelFactsLayer = Partial<ModelFacts>;

export interface FactSources {
  /** What the User set on the model. */
  user?: ModelFactsLayer | undefined;
  /** What the provider's server reports about it. */
  server?: ModelFactsLayer | undefined;
  /** The catalog's entry for it. */
  catalog?: ModelFactsLayer | undefined;
}

/** What a model can do, by the order of precedence. */
export interface ModelCapabilities {
  /** False when no source says anything: "capabilities unknown". */
  known: boolean;
  /** Each fact from the first source that gives it; a field none gives is unknown. */
  facts: ModelFactsLayer;
}

const given = (layer: ModelFactsLayer | undefined): ModelFactsLayer =>
  Object.fromEntries(Object.entries(layer ?? {}).filter(([, value]) => value !== undefined));

/** A model's facts, each from the first source that gives it: the User, the server, the catalog. */
export function resolveCapabilities(sources: FactSources): ModelCapabilities {
  const layers = [sources.catalog, sources.server, sources.user].map(given);
  return {
    known: layers.some((layer) => Object.keys(layer).length > 0),
    facts: Object.assign({}, ...layers),
  };
}

/** Whether the model reads images in a request: only when a source says so. */
export const readsImages = ({ facts }: ModelCapabilities) =>
  facts.input?.includes("image") ?? false;

/**
 * How the model is known to cite before its first request: as measured or
 * decided by the server (`citing`); else in the Tool loop when it calls
 * Tools; with structured output when it can't call them but gives some (or
 * may); not at all when it does neither. Unknown when nothing says whether it
 * calls Tools: an Answer then tries them first.
 */
export function startingSupport({ facts }: ModelCapabilities): CitationSupport | undefined {
  if (facts.citing) return facts.citing;
  if (facts.tools === undefined) return undefined;
  if (facts.tools) return "tools";
  return facts.structuredOutput === "none" ? "none" : "structured-output";
}

/** Whether an Answer offers the model the `calculate` Tool and its steer: only when a source says so. */
export const calculates = ({ facts }: ModelCapabilities): boolean => facts.calculates === true;

/** False when the model is known to give no structured output: an Answer then doesn't try it. */
export const givesStructuredOutput = ({ facts }: ModelCapabilities): boolean | undefined =>
  facts.structuredOutput === undefined ? undefined : facts.structuredOutput !== "none";

/** Room kept for the output when the model's own maximum isn't known, in tokens. */
const DEFAULT_OUTPUT_TOKENS = 4_096;

/**
 * The window a cloud model's requests are kept within, from its context
 * window: room for the longest reply any call asks of it (its own most, at
 * most half of the window and at most `LONGEST_OUTPUT`), and the rest for
 * what a request sends, never more than its input limit where the provider
 * has one. None when the context window isn't known: requests are then sent
 * as they are, and nothing is cut to fit a guess.
 */
export function cloudWindow({ facts }: ModelCapabilities): ContextWindow | undefined {
  const { context, maxInput, maxOutput } = facts;
  if (!context || context <= 0) return undefined;
  const output = Math.min(
    maxOutput ?? DEFAULT_OUTPUT_TOKENS,
    Math.floor(context / 2),
    LONGEST_OUTPUT,
  );
  const input = Math.min(maxInput && maxInput > 0 ? maxInput : context, context - output);
  return { tokens: context, outputTokens: context - input };
}
