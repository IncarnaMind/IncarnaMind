import { wrapLanguageModel } from "ai";
import type { ProviderErrorKind } from "../api";
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

/**
 * `model`, whose requests go to `instead` from the first its provider refuses for the model itself
 * or turns away as busy, before anything comes back, and for every request after it. `switched`
 * hears of it as the request goes to `instead`; `refused`, once `instead` has taken a request the
 * provider refused for the model, so a request `instead` refuses too fails as it would have.
 */
export function refusedGoesTo(
  model: ChatLanguageModel,
  instead: ChatLanguageModel,
  { switched, refused }: { switched(): void; refused(error: unknown): void },
): ChatLanguageModel {
  const other = wrapLanguageModel({ model: instead, middleware: [] });
  let away = false;
  const goesTo = async <T>(own: () => PromiseLike<T>, others: () => PromiseLike<T>): Promise<T> => {
    if (away) return others();
    try {
      return await own();
    } catch (error) {
      const refusal = refusesTheModel(error);
      if (!refusal && !BUSY.has(classifyProviderError(error).kind)) throw error;
      away = true;
      switched();
      const taken = await others();
      if (refusal) refused(error);
      return taken;
    }
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: ({ doGenerate, params }) => goesTo(doGenerate, () => other.doGenerate(params)),
      wrapStream: ({ doStream, params }) => goesTo(doStream, () => other.doStream(params)),
    },
  });
}
