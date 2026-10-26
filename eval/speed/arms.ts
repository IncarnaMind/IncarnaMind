/**
 * The two paths a paired run compares (README.md › Paired runs), each an arm. Both run in one
 * core, item after item, so an arm changes what the core does only through what a run can switch
 * between two items: the settings it saves, as the User saves them, and each model request as it
 * is sent (a prompt's wording, a provider option).
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory, Core } from "../../src/core";
import { WRITE_THEN_CITE } from "../../src/core/answers/prompt";

export interface Arm {
  id: string;
  /** What it runs, for the report. */
  label: string;
  /** Before each of its items: the settings it needs. */
  prepare?(core: Core): Promise<void>;
  /** Each model request while the arm runs, as it is sent. */
  request?(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions;
}

const CITING = "Cite every claim you draw from a Passage:\n";
const LAST_LINE = "- Write nothing before a search: only the Answer, once you have what it needs.";
const SAME_REPLY =
  "- Then, in the same reply, right after the Answer's text, call cite once with a record for each marker: its number (1, 2, …), ";
const IN_THE_TEXT = ". Your thinking isn't shown: the whole Answer goes in the text.";
const WRITE_NOW = [
  " Write the Answer now if your reply's text hasn't given it yet (your thinking isn't shown); don't repeat it.",
  " Write the Answer now if you haven't yet; don't repeat it.",
] as const;
const QUOTED =
  /^- Use quotation marks only around a Document's exact words, in its own language: copy them.*$/m;

/** The Tool loop's citing lines before #489, the records first, in the order they were. */
function citingFirst(system: string): string {
  const quoted = system.replace(
    QUOTED,
    "- Use quotation marks only around a Document's exact words, in its own language, the same as the record's quote, never a translation of them: that goes after the closing mark, as “…”（译：…）.",
  );
  const from = quoted.indexOf(CITING) + CITING.length;
  const to = quoted.indexOf(LAST_LINE, from);
  if (from < CITING.length) return quoted;
  const lines = quoted.slice(from, to).split("\n");
  const record = lines
    .find((line) => line.startsWith(SAME_REPLY) && line.endsWith(IN_THE_TEXT))
    ?.slice(SAME_REPLY.length, -IN_THE_TEXT.length);
  if (to < 0 || !record || !WRITE_THEN_CITE.every((line) => lines.includes(line))) {
    throw new Error("cite-first: the Tool loop's citing lines aren't the ones this arm replaces.");
  }
  const kept = (start: string) => lines.filter((line) => line.startsWith(start));
  return [
    quoted.slice(0, from),
    [
      `- Before writing the Answer, call cite once with a record for each quote you will use: a marker number (1, 2, …), ${record}.`,
      ...kept("- Copy each quote as one unbroken stretch"),
      ...kept("- Use quotation marks only around"),
      "- In the Answer, put the marker as [^1] right after each claim it supports, in a table's cell too. Use only markers you recorded, and add no list of sources.",
      ...kept("- A Citation shown with an id"),
      "- Write nothing before your Tool calls: only the Answer, after them.",
    ].join("\n"),
    quoted.slice(to + LAST_LINE.length),
  ].join("");
}

export const ARMS: readonly Arm[] = [
  { id: "today", label: "today's path, as the branch runs it" },
  {
    id: "cite-first",
    label: "the Tool loop's records first, then the Answer, as before #489",
    request: (params) => ({
      ...params,
      prompt: params.prompt.map((message) => {
        if (message.role === "system") return { ...message, content: citingFirst(message.content) };
        if (message.role !== "tool") return message;
        return {
          ...message,
          content: message.content.map((part) =>
            part.type === "tool-result" && part.output.type === "text"
              ? {
                  ...part,
                  output: { ...part.output, value: part.output.value.replace(...WRITE_NOW) },
                }
              : part,
          ),
        };
      }),
    }),
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
