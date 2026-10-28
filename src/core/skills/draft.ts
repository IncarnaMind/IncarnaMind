/**
 * Make this a Skill: the chat model reads what the User just did in a Mind
 * (its Notes, Questions and Answers, the latest at the end) and drafts a Skill
 * for the same kind of task, as a name, when to use it and its steps. The
 * User edits the draft in the window; nothing is saved here.
 *
 * The request goes the way a Question does: the Mind's own chat model, else
 * the default; consent for the "chat" flow before anything is sent; and in
 * local mode only a model on this computer. The reply is plain text in three
 * labelled parts, which small local models keep to better than JSON.
 */
import { generateText } from "ai";
import { skillNameFrom } from "../../shared/skillName";
import { createWindowBudget } from "../answers/window";
import type {
  ChatModelChoice,
  ChatReadiness,
  DraftSkillResult,
  ProviderError,
  SkillDraft,
} from "../api";
import { ChatNotReadyError, ConsentDeclinedError, InvalidInputError, isRecord } from "../errors";
import { parseMindId } from "../minds";
import type { PreparedChatModel } from "../providers/chat";
import { classifyProviderError } from "../providers/providerErrors";
import { MAX_DESCRIPTION_LENGTH, oneLine } from "./write";

/** The most of the Mind sent, in characters: the end of it, where the latest work is. */
const MAX_MIND_CHARACTERS = 40_000;
/** What a draft may take to write, in tokens: a name, a sentence and up to eight steps. */
const DRAFT_TOKENS = 900;
/** A request that takes longer than this (a local model loading a long text) fails. */
const REQUEST_TIMEOUT_MS = 180_000;
/** What a name falls back to when the model gave none in the format's characters. */
const FALLBACK_NAME = "new-skill";

export const DRAFT_INSTRUCTIONS = [
  "You turn what the User just did in their notes into a Skill: instructions an assistant can follow the next time they ask for the same kind of task.",
  "Their notes are between <mind> and </mind>: their text, their Questions (marked as such) and the Answers they got, the latest at the end. Look at what they just did, mostly in the last part, and write the Skill for that kind of task, not for these particular facts.",
  "",
  "Reply in exactly this form and nothing else:",
  "NAME: two to four lowercase English words joined by hyphens, such as supplier-contract-review",
  "WHEN: one sentence saying what the Skill does and when to use it, in the language the notes are written in",
  "STEPS:",
  "1. the first step, in the language the notes are written in",
  "2. the next, and so on, three to eight steps in all, in the same language as the notes",
  "",
  "Each step is one short instruction that starts with a verb and could be followed on a different Mind. If the work cited their Documents, one step says to cite each finding. Don't copy names, numbers or quotes from the notes unless the task is about them. No preamble, no Markdown headings, no code fence.",
].join("\n");

const prompt = (mind: string) => ["<mind>", mind, "</mind>"].join("\n");

/** The label's text on its line, without the Markdown a model may put round it. */
function labelled(reply: string, label: string): string | null {
  const match = new RegExp(`^[ \\t>*#_-]*${label}[ \\t*_]*[:：][ \\t*_]*(.*)$`, "im").exec(reply);
  return match ? (match[1] ?? "").replace(/[*_]+$/, "").trim() : null;
}

/**
 * The draft in a model's reply, or null when it has no steps or no sentence of
 * when to use it. A name that isn't in the format's characters is made so.
 */
export function readDraft(text: string): SkillDraft | null {
  const reply = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```\w*\n?|\n?```$/gm, "")
    .trim();
  const when = labelled(reply, "WHEN");
  const stepsAt = /^[ \t>*#_-]*STEPS[ \t*_]*[:：][ \t*_]*$/im.exec(reply);
  const inline = labelled(reply, "STEPS");
  const steps = (stepsAt ? reply.slice(stepsAt.index + stepsAt[0].length) : (inline ?? "")).trim();
  if (!when || !steps) return null;
  const description = oneLine(when).slice(0, MAX_DESCRIPTION_LENGTH);
  return {
    name: skillNameFrom(labelled(reply, "NAME") ?? "") || FALLBACK_NAME,
    description,
    steps,
  };
}

/** The Mind's text, less its title line, and whether anything is left. */
function mindText(markdown: string): string {
  return markdown.replace(/^#[^\n]*\n?/, "").trim();
}

export interface SkillDraftsOptions {
  /** The Mind as Markdown, Questions and Answers included. Throws if it doesn't exist. */
  mindMarkdown(mindId: string): Promise<string>;
  /** The chat model the Mind was given, if any, else the default. */
  modelFor(mindId: string): ChatModelChoice | null;
  chat: {
    readiness(choice: ChatModelChoice | undefined): Promise<ChatReadiness>;
    prepareModel(
      choice: ChatModelChoice | undefined,
      flow: "chat",
      thinking: "off",
    ): Promise<PreparedChatModel>;
  };
}

function parseInput(input: unknown): { requestId: string; mindId: string } {
  if (!isRecord(input)) throw new InvalidInputError("draftSkillFromMind expects an object.");
  const { requestId } = input;
  if (typeof requestId !== "string" || requestId === "") {
    throw new InvalidInputError("A Skill draft request needs an id.");
  }
  return { requestId, mindId: parseMindId(input.mindId) };
}

/** The end of `text` that fits `room` tokens, cut at a line where it can be. */
function lastThatFits(text: string, tokens: (text: string) => number, room: number): string {
  let kept = text.length > MAX_MIND_CHARACTERS ? text.slice(-MAX_MIND_CHARACTERS) : text;
  while (kept.length > 0 && tokens(kept) > room) {
    const cut = Math.max(1, Math.floor(kept.length * 0.15));
    const next = kept.slice(cut);
    const line = next.indexOf("\n");
    kept = line >= 0 && line < next.length / 2 ? next.slice(line + 1) : next;
  }
  return kept;
}

export function createSkillDrafts(options: SkillDraftsOptions) {
  const running = new Map<string, AbortController>();
  const { chat } = options;

  async function draft(
    input: ReturnType<typeof parseInput>,
    signal: AbortSignal,
  ): Promise<DraftSkillResult> {
    const text = mindText(await options.mindMarkdown(input.mindId));
    if (text === "") return { kind: "empty" };

    const choice = options.modelFor(input.mindId) ?? undefined;
    const readiness = await chat.readiness(choice);
    if (!readiness.ready) return { kind: "not-ready", readiness };

    let prepared: PreparedChatModel;
    try {
      prepared = await chat.prepareModel(choice, "chat", "off");
    } catch (error) {
      if (error instanceof ChatNotReadyError) {
        return { kind: "not-ready", readiness: error.readiness };
      }
      if (error instanceof ConsentDeclinedError) {
        const now = await chat.readiness(choice);
        return now.ready ? { kind: "cancelled" } : { kind: "not-ready", readiness: now };
      }
      throw error;
    }
    if (signal.aborted) return { kind: "cancelled" };

    let mind = text.length > MAX_MIND_CHARACTERS ? text.slice(-MAX_MIND_CHARACTERS) : text;
    let maxOutputTokens = DRAFT_TOKENS;
    if (prepared.window) {
      const budget = createWindowBudget(prepared.window);
      const room = budget.roomBeside([DRAFT_INSTRUCTIONS, prompt("")], DRAFT_TOKENS);
      if (room <= 0) {
        return {
          kind: "failed",
          error: {
            kind: "too-long",
            message: "The model's context window is too small to draft a Skill.",
          },
        };
      }
      mind = lastThatFits(text, budget.tokens, room);
      maxOutputTokens = Math.min(DRAFT_TOKENS, prepared.window.outputTokens);
    }

    let reply: string;
    try {
      const result = await generateText({
        model: prepared.model,
        instructions: DRAFT_INSTRUCTIONS,
        prompt: prompt(mind),
        maxOutputTokens,
        maxRetries: 1,
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      reply = result.text;
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      return { kind: "failed", error: classifyProviderError(error) };
    }
    if (signal.aborted) return { kind: "cancelled" };
    const drafted = readDraft(reply);
    if (!drafted) {
      const error: ProviderError = {
        kind: "provider",
        message: "The model's reply had no steps for a Skill.",
      };
      return { kind: "failed", error };
    }
    return { kind: "drafted", draft: drafted };
  }

  return {
    async draft(raw: unknown): Promise<DraftSkillResult> {
      const input = parseInput(raw);
      running.get(input.requestId)?.abort();
      const controller = new AbortController();
      running.set(input.requestId, controller);
      try {
        return await draft(input, controller.signal);
      } finally {
        if (running.get(input.requestId) === controller) running.delete(input.requestId);
      }
    },

    cancel(requestId: unknown): void {
      if (typeof requestId !== "string") throw new InvalidInputError("requestId must be text.");
      running.get(requestId)?.abort();
    },

    /** The core is closing: requests still waiting stop. */
    stopAll(): void {
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
  };
}
