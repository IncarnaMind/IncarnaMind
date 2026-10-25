/**
 * The two paths a paired run compares (README.md › Paired runs), each an arm. Both run in one
 * core, item after item, so an arm changes what the core does only through what a run can switch
 * between two items: the settings it saves, as the User saves them, and each model request as it
 * is sent (a prompt's wording, a provider option).
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory, Core } from "../../src/core";

export interface Arm {
  id: string;
  /** What it runs, for the report. */
  label: string;
  /** Before each of its items: the settings it needs. */
  prepare?(core: Core): Promise<void>;
  /** Each model request while the arm runs, as it is sent. */
  request?(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions;
}

export const ARMS: readonly Arm[] = [{ id: "today", label: "today's path, as the branch runs it" }];

export function armNamed(id: string): Arm {
  const arm = ARMS.find((each) => each.id === id);
  if (!arm) {
    throw new Error(
      `INCARNAMIND_EVAL_SPEED_PAIRED: no arm "${id}"; the arms are ${ARMS.map((each) => each.id).join(", ")} (eval/speed/arms.ts).`,
    );
  }
  return arm;
}

/** The chat models of a core that runs both arms: each request goes as the arm in use has it. */
export function armSwitch() {
  let current: Arm | null = null;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    transformParams: async ({ params }) => current?.request?.(params) ?? params,
  };
  return {
    chatModels:
      (inner: ChatModelFactory): ChatModelFactory =>
      (spec) =>
        wrapLanguageModel({ model: inner(spec), middleware }),
    use(arm: Arm): void {
      current = arm;
    },
  };
}
