/**
 * The size of every request a run would send (#2847), so a gate's cost can be scaled from an
 * earlier run's by request size before anything is paid: a wrapper around the models that keeps
 * each request's characters (its whole prompt and its tools), the app's and the judge's apart.
 * Nothing is sent or changed by it.
 */
import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from "ai";

export interface RequestSize {
  /** The app's request (an Answer's, its check's, its ask for Citations) or the eval's judge's. */
  kind: "app" | "judge";
  chars: number;
}

export function requestSizes() {
  let sizes: RequestSize[] = [];
  const middleware = (kind: RequestSize["kind"]): LanguageModelMiddleware => ({
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      sizes.push({
        kind,
        chars: JSON.stringify({ prompt: params.prompt, tools: params.tools ?? [] }).length,
      });
      return params;
    },
  });
  return {
    /** `model`, its requests' sizes kept as `kind`. */
    wrap: <Model extends Exclude<LanguageModel, string>>(model: Model, kind: RequestSize["kind"]) =>
      wrapLanguageModel({ model, middleware: middleware(kind) }),
    /** The sizes kept since it was last asked. */
    take: (): RequestSize[] => {
      const taken = sizes;
      sizes = [];
      return taken;
    },
  };
}
