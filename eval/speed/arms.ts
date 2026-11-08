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
import { estimateTokens } from "../../src/core/answers/context";
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
  /** Whether call help's unmarked Citations are placed and added, as before #2847; unset: they aren't. */
  helpMarksPlaced?: boolean;
}

/** Call help's form as it was worded before #2847, each line as worded since, then as before. */
const MARKS_BEFORE: readonly (readonly [string, string])[] = [
  [
    "one sentence of at most 25 words with no quotation marks around it (the panel shows it as a quote); then",
    "one sentence of at most 25 words with no quotation marks around it (the panel shows it as a quote), its Citation markers at its end; then",
  ],
  [
    "each one sentence of at most 20 words.\n",
    "each one sentence of at most 20 words, its Citation markers at its end.\n",
  ],
  [
    "\n- A sentence with a Citation marker says only what its quotes state, beside what the User would promise, offer or ask now: put each marker right after the words its quote supports, give each other fact from the Documents or the call its own line's marker right after it, and leave out a fact or a conclusion that no quote states. An option that only buys time has no marker.",
    "",
  ],
  [
    "★ We can extend the pilot to 60 days [^1], but Enterprise stays at list price",
    "★ We can't go below list for Enterprise, but we can extend the pilot to 60 days [^1]",
  ],
  [
    "★ 我们可以把试用延长到 60 天 [^1]，但企业版价格没法低于标价",
    "★ 企业版价格没法低于标价，但我们可以把试用延长到 60 天 [^1]",
  ],
];

/** A request's text with call help's form worded as it was before #2847. */
export const marksAsBefore = (text: string): string =>
  MARKS_BEFORE.reduce((worded, [since, before]) => worded.replaceAll(since, before), text);

/** Each user message's text of a request, through `reworded`. */
const userText =
  (reworded: (text: string) => string) =>
  (params: LanguageModelV4CallOptions): LanguageModelV4CallOptions => ({
    ...params,
    prompt: params.prompt.map((message) =>
      message.role === "user"
        ? {
            ...message,
            content: message.content.map((part) =>
              part.type === "text" ? { ...part, text: reworded(part.text) } : part,
            ),
          }
        : message,
    ),
  });

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
    request: userText(newestStretch),
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
    id: "help-marks-as-before",
    label:
      "call help's Citations placed and added by the core where the model wrote no marker, and its form's markers at each option's end, as before #2847",
    helpMarksPlaced: true,
    request: userText(marksAsBefore),
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

/** The chat models and Answer paths of a core, as the arm it runs has them. */
export function armSwitch() {
  let current: Arm | null = null;
  /** Each request's prompt as sent, for a run that holds two arms to sending the same one. */
  const sent: string[] = [];
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const next = current?.request?.(params) ?? params;
      sent.push(JSON.stringify(next.prompt));
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
    helpMarksPlaced: () => current?.helpMarksPlaced,
    /** The prompts sent since it was last asked, oldest first. */
    takeSent: (): string[] => sent.splice(0),
    use(arm: Arm): void {
      current = arm;
    },
  };
}
