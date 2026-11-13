/**
 * The two paths a paired run compares (README.md › Paired runs), each an arm. Each runs in a core
 * of its own, opened the same way, so an arm changes what its core does only through the settings
 * it saves, as the User saves them, each model as it is made (how it thinks), each model request
 * as it is sent (a prompt's wording, a provider option), and which Answer paths a model takes
 * instead of the lists beside the catalog (src/core/providers/catalog/answerPaths).
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type {
  AnswerPathsOverride,
  ChatModelFactory,
  CheckPathsOverride,
  Core,
} from "../../src/core";
import { isSentenceBatch, readBatch } from "../../src/core/answers/checks/sentenceBatch";
import { estimateTokens } from "../../src/core/answers/context";
import { replyJson } from "../../src/core/answers/judge";
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
  paths?: {
    writesThenCites?: boolean;
    retrievesFirst?: boolean;
  };
  /** Whether the quick model looks first at every written sentence (#1667); unset: the list's. */
  checks?: { quickFirstLook?: boolean };
  /** Whether a call's notes start before its speakers are told apart (#2773); unset: the core's default. */
  notes?: { beforeSpeakers?: boolean };
  /** Whether call help's own form may be judged the model's working, as before #2778; unset: it isn't. */
  helpFormJudged?: boolean;
  /** Whether found quotes show as the model gave them, as before #2739; unset: their whole sentences. */
  quotesAsGiven?: boolean;
  /** Whether call help's ✓ comes from a found quote alone, its sentences not judged (#2847); unset: judged. */
  helpMarksQuoteOnly?: boolean;
  /** Whether call help writes a cited fact and its own conclusion in one sentence, as before #2847's rule. */
  callHelpWritingAsBefore?: boolean;
}

/** The most of the live transcript `newest-stretch` keeps: some three minutes of talk. */
const STRETCH_TOKENS = 400;

/** A request's live transcript cut to its newest Passages within `STRETCH_TOKENS`, the newest at least. */
export function newestStretch(text: string): string {
  return text.replace(/<live-transcript>\n([\s\S]*?)\n<\/live-transcript>/, (_, shown: string) => {
    const passages = shown.match(/<passage [^>]*>\n[\s\S]*?\n<\/passage>/g) ?? [];
    const kept: string[] = [];
    let left = STRETCH_TOKENS;
    for (const passage of [...passages].reverse()) {
      const cost = estimateTokens(passage);
      if (kept.length > 0 && cost > left) break;
      kept.unshift(passage);
      left -= cost;
    }
    return `<live-transcript>\n${kept.join("\n\n")}\n</live-transcript>`;
  });
}

// An arm that compares one Answer path keeps every other as the Tool loop has it from its first
// call: a model the retrieve-first list names would otherwise search first in both citation arms.
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
    id: "no-quick-look",
    label: "every written sentence checked by the check's Run, as before #1667",
    checks: { quickFirstLook: false },
  },
  {
    id: "quick-look",
    label:
      "the quick-tasks model looks first at a written sentence, and only its plain yes stands (#1667)",
    checks: { quickFirstLook: true },
  },
  {
    id: "default-effort",
    label:
      "every call that thinks at its provider's default effort, as Tasks were sent before #1631; not what Claude's Answers were sent before it, at low (careful ones at high)",
    spec: (spec) =>
      spec.thinking === undefined || spec.thinking === "off"
        ? spec
        : { ...spec, thinking: "summary" },
  },
  {
    id: "notes-without-thinking",
    label:
      "every call that would think as an Answer made with thinking off: in the meeting-notes set, the fill's request alone (#2773)",
    spec: (spec) => (spec.thinking === "answer" ? { ...spec, thinking: "off" } : spec),
  },
  {
    id: "speakers-first",
    label: "a call's notes wait for its speakers to be told apart, as before #2773",
    notes: { beforeSpeakers: false },
  },
  {
    id: "notes-before-speakers",
    label:
      "a call's notes start once its words are final, while its speakers are told apart, and are written once the pass ends (#2773)",
    notes: { beforeSpeakers: true },
  },
  {
    id: "notes-low-effort",
    label:
      "every DeepSeek request that thinks does so at reasoning_effort low, one level down from its default high: in the meeting-notes set, the fill's requests and the claims' checks (#2773)",
    request: (params) => {
      const deepseek = params.providerOptions?.deepseek;
      const thinking = deepseek?.thinking;
      const off =
        typeof thinking === "object" &&
        thinking !== null &&
        "type" in thinking &&
        thinking.type === "disabled";
      return off
        ? params
        : {
            ...params,
            providerOptions: {
              ...params.providerOptions,
              deepseek: { ...deepseek, reasoningEffort: "low" },
            },
          };
    },
  },
  {
    id: "newest-stretch",
    label: `call help reads only the newest ${STRETCH_TOKENS} tokens of the live transcript, the newest Passage at least (#2526)`,
    request: (params) => ({
      ...params,
      prompt: params.prompt.map((message) =>
        message.role === "user"
          ? {
              ...message,
              content: message.content.map((part) =>
                part.type === "text" ? { ...part, text: newestStretch(part.text) } : part,
              ),
            }
          : message,
      ),
    }),
  },
  {
    id: "help-answers-model",
    label: "call help on the Answers model: Settings › Meetings' Same as Answers, as before #2526",
    prepare: async (core) => {
      await core.updateSettings({ user: { callHelpModel: "answers" } });
    },
  },
  {
    id: "help-fastest",
    label:
      "call help on the quick model of the Answers model's provider: Settings › Meetings' Fastest, the User's choice since #2526",
    prepare: async (core) => {
      await core.updateSettings({ user: { callHelpModel: "fastest" } });
    },
  },
  {
    id: "help-form-judged",
    label:
      "call help's own options, readings and short lines judged as the model's working, as before #2778",
    helpFormJudged: true,
  },
  {
    id: "quotes-as-given",
    label:
      "found quotes shown as the model gave them, and nothing said of two records with one quote, as before #2739",
    quotesAsGiven: true,
  },
  {
    id: "help-marks-quote-only",
    label: "call help's ✓ beside every found quote, its sentences not judged",
    helpMarksQuoteOnly: true,
  },
  {
    id: "call-help-writing-as-before",
    label:
      "call help writes a cited fact and the User's own advice, conclusion or \"no\" in one sentence, as before #2847's own-sentence rule",
    callHelpWritingAsBefore: true,
  },
  {
    id: "retrieve-first",
    label:
      "the Question searched before the first call, answered from those Passages unless it needs more (#1633)",
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

/** A request as sent, for a run that holds two arms to sending the same one. */
export interface SentRequest {
  /** Its whole prompt, the system prompt and every message, as `sameRequestOf` compares it. */
  prompt: string;
  /** The model, the system prompt, the Tools and every parameter but the messages. */
  setup: string;
  /** Its messages after the system prompt. */
  messages: string;
}

/** A sentence check's reply as the run read it: how many sentences it was asked, how many it read. */
export interface CheckReply {
  sentences: number;
  read: number;
}

/** The sentence check's reply to `params`, read as the check reads it; null when it isn't one. */
function checkReplyOf(params: LanguageModelV4CallOptions, text: string): CheckReply | null {
  const system = params.prompt.find((message) => message.role === "system");
  if (!system || !isSentenceBatch(system.content)) return null;
  const sentences = JSON.stringify(params.prompt).match(/<sentence number=/g)?.length ?? 0;
  return { sentences, read: readBatch(replyJson(text), sentences)?.size ?? 0 };
}

/** The chat models and Answer paths of a core, as the arm it runs has them. */
export function armSwitch() {
  let current: Arm | null = null;
  const sent: SentRequest[] = [];
  const checks: CheckReply[] = [];
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
      const reply = checkReplyOf(params, text.join(""));
      if (reply) checks.push(reply);
      return result;
    },
    transformParams: async ({ params, model }) => {
      const next = current?.request?.(params) ?? params;
      const { prompt, abortSignal: _signal, headers: _headers, ...rest } = next;
      sent.push({
        prompt: JSON.stringify(prompt),
        setup: JSON.stringify({
          model: `${model.provider}/${model.modelId}`,
          system: prompt.filter((message) => message.role === "system"),
          ...rest,
        }),
        messages: JSON.stringify(prompt.filter((message) => message.role !== "system")),
      });
      return next;
    },
  };
  const answerPaths: AnswerPathsOverride = {
    writesThenCites: () => current?.paths?.writesThenCites,
    retrievesFirst: () => current?.paths?.retrievesFirst,
  };
  const checkPaths: CheckPathsOverride = {
    quickFirstLook: () => current?.checks?.quickFirstLook,
  };
  return {
    chatModels:
      (inner: ChatModelFactory): ChatModelFactory =>
      (spec) =>
        wrapLanguageModel({ model: inner(current?.spec?.(spec) ?? spec), middleware }),
    answerPaths,
    checkPaths,
    notesBeforeSpeakers: () => current?.notes?.beforeSpeakers,
    helpFormJudged: () => current?.helpFormJudged,
    quotesAsGiven: () => current?.quotesAsGiven,
    helpMarksQuoteOnly: () => current?.helpMarksQuoteOnly,
    callHelpWritingAsBefore: () => current?.callHelpWritingAsBefore,
    /** The requests sent since it was last asked, oldest first. */
    takeSent: (): SentRequest[] => sent.splice(0),
    /** The sentence check's replies since it was last asked, oldest first. */
    takeChecks: (): CheckReply[] => checks.splice(0),
    use(arm: Arm): void {
      current = arm;
    },
  };
}
