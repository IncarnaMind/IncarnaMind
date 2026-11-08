import { wrapLanguageModel } from "ai";
import type { ProviderErrorKind } from "../api";
import type { ChatLanguageModel } from "./models";
import { classifyProviderError } from "./providerErrors";

/**
 * How a provider refuses a model this key or plan doesn't reach: not found, not allowed, not
 * served here. A limit, a lapse in the connection or a request too long is no refusal of the
 * model, so the same request would fare no better on another.
 */
const REFUSED: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  "model",
  "refused",
  "auth",
  "blocked",
  "region",
  "data-retention",
]);

/**
 * `model`, whose requests go to `instead` from the first one its provider refuses before anything
 * comes back. `onRefused` hears of it once `instead` has taken that request: a request `instead`
 * refuses too fails as it would have, and `model` is asked again next time.
 */
export function refusedGoesTo(
  model: ChatLanguageModel,
  instead: ChatLanguageModel,
  onRefused: (error: unknown) => void,
): ChatLanguageModel {
  const other = wrapLanguageModel({ model: instead, middleware: [] });
  let refused = false;
  const goesTo = async <T>(own: () => PromiseLike<T>, others: () => PromiseLike<T>): Promise<T> => {
    if (refused) return others();
    try {
      return await own();
    } catch (error) {
      if (!REFUSED.has(classifyProviderError(error).kind)) throw error;
      const taken = await others();
      refused = true;
      onRefused(error);
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
