/**
 * The two paths a paired run compares (README.md › Paired runs), each an arm. Both run in one
 * core, item after item, so an arm changes what the core does only through what a run can switch
 * between two items: the settings it saves, as the User saves them, each model as it is made
 * (how it thinks), each model request as it is sent (a prompt's wording, a provider option), and
 * which Answer paths a model takes instead of the lists beside the catalog
 * (src/core/providers/catalog/answerPaths).
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { AnswerPathsOverride, ChatModelFactory, Core } from "../../src/core";
import type { ChatModelSpec } from "../../src/core/providers/models";

export interface Arm {
  id: string;
  /** What it runs, for the report. */
  label: string;
  /** Before each of its items: the settings it needs. */
  prepare?(core: Core): Promise<void>;
  /** Each model made while the arm runs: one is made for each Answer, before its first request. */
  spec?(spec: ChatModelSpec): ChatModelSpec;
  /** Each model request while the arm runs, as it is sent. */
  request?(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions;
  /** Answer paths every model takes or doesn't while the arm runs; unset: the lists'. */
  paths?: { writesThenCites?: boolean; retrievesFirst?: boolean };
}

// An arm that compares one Answer path keeps every other as the Tool loop has it from its first
// call: a model the retrieve-first list names would otherwise write first in both citation arms.
export const ARMS: readonly Arm[] = [
  { id: "today", label: "today's path, as the branch runs it" },
  {
    id: "cite-first",
    label: "the Tool loop's records first, then the Answer",
    paths: { writesThenCites: false, retrievesFirst: false },
  },
  {
    id: "write-then-cite",
    label: "the Answer, then its records in the same reply (#489)",
    paths: { writesThenCites: true, retrievesFirst: false },
  },
  {
    id: "loop",
    label: "the Tool loop from its first call, whatever the lists say",
    paths: { retrievesFirst: false },
  },
  {
    id: "default-effort",
    label:
      "every call that thinks at its provider's default effort: what Tasks sent on every provider, and every call to DeepSeek, before #1631; not Claude's Answers, which were at low (careful ones at high) before it too",
    spec: (spec) =>
      spec.thinking === undefined || spec.thinking === "off"
        ? spec
        : { ...spec, thinking: "summary" },
  },
  {
    id: "retrieve-first",
    label:
      "the Question searched before the first call, answered in one call unless it needs more (#1633)",
    paths: { retrievesFirst: true },
  },
];

export function armNamed(id: string): Arm {
  const arm = ARMS.find((each) => each.id === id);
  if (!arm) {
    throw new Error(
      `INCARNAMIND_EVAL_SPEED_PAIRED: no arm "${id}"; the arms are ${ARMS.map((each) => each.id).join(", ")} (eval/speed/arms.ts).`,
    );
  }
  return arm;
}

/** The chat models and Answer paths of a core that runs both arms, as the arm in use has them. */
export function armSwitch() {
  let current: Arm | null = null;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    transformParams: async ({ params }) => current?.request?.(params) ?? params,
  };
  const answerPaths: AnswerPathsOverride = {
    writesThenCites: () => current?.paths?.writesThenCites,
    retrievesFirst: () => current?.paths?.retrievesFirst,
  };
  return {
    chatModels:
      (inner: ChatModelFactory): ChatModelFactory =>
      (spec) =>
        wrapLanguageModel({ model: inner(current?.spec?.(spec) ?? spec), middleware }),
    answerPaths,
    use(arm: Arm): void {
      current = arm;
    },
  };
}
