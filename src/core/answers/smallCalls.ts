import type { ChatLanguageModel } from "../providers/models";
import type { AnswerRequest } from "./engine";

/** The model a call that doesn't write the Answer goes to, with the temperature it gets. */
export interface SmallCallModel {
  model: ChatLanguageModel;
  temperature: number | undefined;
}

/**
 * The model for the small calls, else the Answer's (see `AnswerRequest.quickModel`).
 * Another model than the Answer's runs at its provider's own temperature.
 */
export async function smallCallModel(
  request: Pick<AnswerRequest, "model" | "quickModel" | "signal">,
  temperature: number | undefined,
): Promise<SmallCallModel> {
  if (request.quickModel) {
    try {
      const quick = await request.quickModel();
      const sameModel =
        quick.provider === request.model.provider && quick.modelId === request.model.modelId;
      return { model: quick, temperature: sameModel ? temperature : undefined };
    } catch (error) {
      if (!request.signal.aborted) {
        console.error(
          `The quick-tasks model couldn't be used: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return { model: request.model, temperature };
}
