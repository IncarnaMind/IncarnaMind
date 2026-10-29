/**
 * The two paths a paired run compares (README.md › Paired runs), each an arm. Both run in one
 * core, item after item, so an arm changes what the core does only through what a run can switch
 * between two items: the settings it saves, as the User saves them, each model request as it is
 * sent (a prompt's wording, a provider option), and which Answer paths a model takes instead of
 * the lists beside the catalog (src/core/providers/catalog/answerPaths).
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { AnswerPathsOverride, ChatModelFactory, Core } from "../../src/core";

export interface Arm {
  id: string;
  /** What it runs, for the report. */
  label: string;
  /** Before each of its items: the settings it needs. */
  prepare?(core: Core): Promise<void>;
  /** Each model request while the arm runs, as it is sent. */
  request?(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions;
  /** Answer paths every model takes or doesn't while the arm runs; unset: the lists'. */
  paths?: { writesThenCites?: boolean; retrievesFirst?: boolean };
}

const WRITES: ReadonlySet<string> = new Set(["add_to_mind", "create_mind", "edit_mind"]);

/** The Minds' write Tools as they were before #1635, offering no `done`: every write gets its closing reply. */
function withoutDone(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  return {
    ...params,
    tools: params.tools?.map((tool) => {
      if (tool.type !== "function" || !WRITES.has(tool.name)) return tool;
      const { done: _done, ...properties } = tool.inputSchema.properties ?? {};
      return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
    }),
  };
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
    id: "write-replies",
    label:
      "every write followed by its closing reply, as before #1635 (the write Tools offer no done)",
    request: withoutDone,
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
        wrapLanguageModel({ model: inner(spec), middleware }),
    answerPaths,
    use(arm: Arm): void {
      current = arm;
    },
  };
}
