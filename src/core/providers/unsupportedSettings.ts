/**
 * A setting a model doesn't take is sent to it once. Some providers refuse such a request, and an
 * Answer sends it again without the setting (../answers/engine). Others take the request, leave
 * the setting out and only say so in the reply's warnings, as OpenAI's reasoning models do with a
 * temperature: nothing fails, so nothing was learnt, and every later request to a model the
 * catalog doesn't know yet carried the setting again. Here the warning is what is learnt: for the
 * rest of the session, requests to that model leave the setting out.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatLanguageModel } from "./models";

/** The sampling settings a request can do without. */
const SETTINGS = [
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
] as const;
type Setting = (typeof SETTINGS)[number];

type Warned = Awaited<
  ReturnType<Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0]["doGenerate"]>
>["warnings"];

const settingOf = (feature: string): Setting | undefined =>
  SETTINGS.find((setting) => setting === feature);

/** What each model, by `key`, has said it doesn't support, for as long as the core runs. */
export function createUnsupportedSettings() {
  const learnt = new Map<string, Set<Setting>>();
  return {
    /** `model`, whose requests leave out each setting a reply of its `key` warned it doesn't support. */
    wrap(model: ChatLanguageModel, key: string): ChatLanguageModel {
      const learn = (warnings: Warned) => {
        for (const warning of warnings ?? []) {
          const setting = warning.type === "unsupported" ? settingOf(warning.feature) : undefined;
          if (setting) learnt.set(key, new Set([...(learnt.get(key) ?? []), setting]));
        }
      };
      return wrapLanguageModel({
        model,
        middleware: {
          specificationVersion: "v4",
          transformParams: async ({ params }) => {
            const without = learnt.get(key);
            if (!without) return params;
            const kept = { ...params };
            for (const setting of without) delete kept[setting];
            return kept;
          },
          wrapGenerate: async ({ doGenerate }) => {
            const result = await doGenerate();
            learn(result.warnings);
            return result;
          },
          wrapStream: async ({ doStream }) => {
            const result = await doStream();
            return {
              ...result,
              stream: result.stream.pipeThrough(
                new TransformStream({
                  transform(part, controller) {
                    if (part.type === "stream-start") learn(part.warnings);
                    controller.enqueue(part);
                  },
                }),
              ),
            };
          },
        },
      });
    },
  };
}
