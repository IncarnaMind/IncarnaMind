/**
 * `ask_user` (#1374): the assistant asks the User a question with options when the Answer
 * depends on a choice only the User can make, and waits in the tray for the answer.
 */
import type { UserAnswer, UserQuestion, UserQuestionOption } from "../api";
import { ASK_TOOLS, type Tool, type ToolProviderInfo } from "./index";

const PROVIDER: ToolProviderInfo = { kind: "asks", id: "asks", name: "Questions" };

/** Questions one Answer may ask: more would be an interview, not an Answer. */
export const ASKS_PER_ANSWER = 2;

export interface AskToolOptions {
  /** Asks the User in the tray and waits; rejects if the Answer stops first. */
  ask(toolCallId: string, question: UserQuestion, signal: AbortSignal): Promise<UserAnswer>;
  /**
   * Its card, when the Run hasn't announced the call yet: the question can reach
   * the User first, and the Answer stops at it before the card would come.
   */
  started?(toolCallId: string): void;
  /** The question as its card keeps it: asked, then answered. */
  recorded(toolCallId: string, question: UserQuestion): void;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

/** The question as the model asked it, checked: throws, telling the model what to fix. */
export function questionOf(input: Record<string, unknown>): UserQuestion {
  const question = text(input.question);
  if (!question) throw new Error("Give the question to ask.");
  const given = Array.isArray(input.options) ? input.options : [];
  const options: UserQuestionOption[] = given.map((each) => {
    const option =
      typeof each === "object" && each !== null ? (each as Record<string, unknown>) : {};
    return {
      label: text(option.label),
      description: text(option.description),
      recommended: option.recommended === true,
      preselected: option.preselected === true,
    };
  });
  if (options.length < 2 || options.length > 4) {
    throw new Error("Offer 2 to 4 options.");
  }
  if (options.some((option) => !option.label)) throw new Error("Give every option a label.");
  if (new Set(options.map((option) => option.label.toLowerCase())).size < options.length) {
    throw new Error("Give each option its own label.");
  }
  if (options.filter((option) => option.recommended).length > 1) {
    throw new Error("Mark at most one option recommended.");
  }
  const multiple = input.multiple === true;
  if (!multiple && options.filter((option) => option.preselected).length > 1) {
    throw new Error("Tick at most one option when only one may be chosen.");
  }
  return {
    question,
    detail: text(input.detail) || null,
    options: [
      ...options.filter((option) => option.recommended),
      ...options.filter((option) => !option.recommended),
    ],
    multiple,
    other: input.other === true,
    answer: null,
  };
}

function said(question: UserQuestion, answer: UserAnswer): string {
  if (answer.skipped) {
    const recommended = question.options.find((option) => option.recommended);
    const go = recommended ? `with “${recommended.label}”` : "with your best judgement";
    return `The User skipped the question. Go on ${go}, and say in one sentence what you assumed.`;
  }
  const parts = [
    ...answer.chosen.map((label) => `“${label}”`),
    ...(answer.wrote === null ? [] : [`in their own words: “${answer.wrote}”`]),
  ];
  return `The User answered ${parts.join(" and ")}. Go on with that.`;
}

export function askTool(options: AskToolOptions): Tool {
  let asked = 0;
  // Called at once by the model, its questions still wait in the tray one after the other.
  let turn: Promise<unknown> = Promise.resolve();
  return {
    name: ASK_TOOLS.ask,
    description: `Asks the User one question with 2 to 4 options, and waits for their answer. Ask only when the answer changes what you write or which Documents you read, and the choice is one only the User can make: which Folder, which Documents, which language, whether to search all Documents. When the User names Documents vaguely ("the main documents", "the important ones") and more than two could be meant, ask which, the newest ticked (preselected), rather than guessing. Never ask what you can decide yourself, or what the User already said. One question at a time, at most ${ASKS_PER_ANSWER} in an answer. Mark the option you would go with as recommended. Let the User write their own answer (other) when the options may not cover it.`,
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question, short, as the User would read it.",
        },
        detail: {
          type: "string",
          description: "One optional line under it, such as what is ticked already and why.",
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "A few words." },
              description: { type: "string", description: "One line: what choosing it means." },
              recommended: { type: "boolean" },
              preselected: {
                type: "boolean",
                description: "Ticked already, for the User to change.",
              },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
        multiple: { type: "boolean", description: "More than one option may be chosen." },
        other: { type: "boolean", description: "The User may write their own answer." },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: ASK_TOOLS.ask,
    effects: () => [],
    untrustedResult: false,
    async call(input, { toolCallId, signal }) {
      if (asked >= ASKS_PER_ANSWER) {
        throw new Error(
          `You have asked ${ASKS_PER_ANSWER} questions in this answer: decide the rest yourself, and say what you assumed.`,
        );
      }
      const question = questionOf(input);
      asked++;
      options.started?.(toolCallId);
      options.recorded(toolCallId, question);
      const asking = turn.then(() => options.ask(toolCallId, question, signal));
      turn = asking.catch(() => undefined);
      const answer = await asking;
      options.recorded(toolCallId, { ...question, answer });
      return said(question, answer);
    },
  };
}
