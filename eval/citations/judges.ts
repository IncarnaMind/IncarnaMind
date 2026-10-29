/**
 * "Supported": whether the Passage a Citation names supports its sentence, as
 * two independent model judges say with one fixed prompt. Each judge's
 * verdicts go into a file of their own beside the run's, one line a Citation,
 * so judging resumes where it stopped and scoring reads them without asking
 * again. Where the judges disagree, a person settles it in `settled.json`.
 * A judge is anything that answers `judge`: a model through the app's own
 * provider code, or, to check the pipeline at no cost, a scripted stand-in.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "ai";
import { createAiSdkChatModel } from "../../src/core";
import { type ChatSettings, chatModelSpecOf } from "../lib/config";
import { capProblem, labelOf, priceOf, usdOf } from "./cost";
import { modelSlug, noTokens, type RunCitation, sha256, type Tokens } from "./runs";
import type { FinalVerdict } from "./scorers";

export type Verdict = "supported" | "not supported";

export interface JudgeInput {
  question: string;
  sentence: string;
  quote: string;
  documentName: string;
  passage: string;
}

export interface Judgement {
  key: string;
  verdict: Verdict | "unread";
  reason: string;
  judge: string;
  prompt: string;
  at: string;
  tokens: Tokens;
  usd: number | null;
}

export interface Judge {
  /** "anthropic/claude-opus-5-5", or a scripted stand-in's name. */
  id: string;
  /** The run models it may not judge: its own. */
  kind: string | null;
  modelId: string | null;
  judge(
    input: JudgeInput,
  ): Promise<{ verdict: Verdict | "unread"; reason: string; tokens: Tokens }>;
  price: ReturnType<typeof priceOf>;
}

/** The one prompt every model judge gets; its hash is kept with each verdict. */
export const JUDGE_INSTRUCTIONS = [
  "You check one sentence of an Answer against the Passage it cites from a Document.",
  "Say whether the Passage supports the sentence: everything the sentence claims, its figures, units, years, names and who did what, is stated in the Passage or follows from it directly.",
  "A sentence that adds a claim, a figure or a cause the Passage doesn't state is not supported, even when the claim is true. A sentence in another language than the Passage is judged by its meaning.",
  'Reply with JSON and nothing else: {"verdict": "supported" or "not supported", "reason": one short sentence}.',
].join("\n");

export const PROMPT_SHA256 = sha256(JUDGE_INSTRUCTIONS);

const promptFor = (input: JudgeInput) =>
  [
    `<question>${input.question}</question>`,
    `<sentence>${input.sentence}</sentence>`,
    `<passage document="${input.documentName}">`,
    input.passage,
    "</passage>",
    `<quote>${input.quote}</quote>`,
    "Does the Passage support the sentence?",
  ].join("\n");

/** The verdict in a judge's reply: its JSON, else the last verdict it names. */
export function readVerdict(text: string): { verdict: Verdict | "unread"; reason: string } {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as { verdict?: unknown; reason?: unknown };
      const verdict = String(parsed.verdict).toLowerCase().trim();
      if (verdict === "supported" || verdict === "not supported") {
        return { verdict, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
      }
    } catch {
      // Not JSON after all: read the words below.
    }
  }
  const word = text
    .toLowerCase()
    .match(/\bnot supported\b|\bsupported\b/g)
    ?.at(-1);
  if (word === "supported" || word === "not supported") return { verdict: word, reason: "" };
  return { verdict: "unread", reason: text.slice(0, 200) };
}

/** A model judge, asked through the app's own provider code. Every call costs money. */
export function modelJudge(settings: ChatSettings): Judge {
  const model = createAiSdkChatModel(chatModelSpecOf(settings));
  return {
    id: labelOf(settings),
    kind: settings.kind,
    modelId: settings.modelId,
    price: priceOf(settings),
    async judge(input) {
      const result = await generateText({
        model,
        instructions: JUDGE_INSTRUCTIONS,
        prompt: promptFor(input),
        maxOutputTokens: 400,
        maxRetries: 2,
      });
      const usage = result.usage;
      return {
        ...readVerdict(result.text),
        tokens: {
          requests: 1,
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        },
      };
    },
  };
}

/** Words, and pairs of Chinese characters, as a scripted judge compares them. */
const terms = (text: string): string[] => {
  const plain = text.normalize("NFKC").toLowerCase();
  const words = plain.match(/[a-z0-9.]{3,}/g) ?? [];
  const han = [...plain.replace(/[^\p{Script=Han}]/gu, "")];
  return [...words, ...han.slice(1).map((char, index) => `${han[index]}${char}`)];
};

/**
 * Two scripted stand-ins for the pipeline check, never for published numbers:
 * one says supported when most of the sentence's words are in the Passage,
 * the other when its quote is in the Passage and every number the sentence
 * writes is too. They disagree often, which is what the check needs.
 */
export const SCRIPTED_JUDGES: readonly Judge[] = [
  {
    id: "scripted-words",
    kind: null,
    modelId: null,
    price: null,
    async judge(input) {
      const wanted = terms(input.sentence);
      const passage = new Set(terms(input.passage));
      const shared = wanted.filter((term) => passage.has(term)).length;
      const supported = wanted.length > 0 && shared / wanted.length >= 0.6;
      return {
        verdict: supported ? "supported" : "not supported",
        reason: `${shared} of ${wanted.length} of the sentence's words are in the Passage`,
        tokens: noTokens(),
      };
    },
  },
  {
    id: "scripted-numbers",
    kind: null,
    modelId: null,
    price: null,
    async judge(input) {
      const passage = input.passage.normalize("NFKC").replaceAll(",", "");
      const numbers =
        input.sentence
          .normalize("NFKC")
          .replaceAll(",", "")
          .match(/\d+(?:\.\d+)?/g) ?? [];
      const quoted = passage.includes(input.quote.normalize("NFKC").replaceAll(",", "").trim());
      const missing = numbers.filter((number) => !passage.includes(number));
      return {
        verdict: quoted && missing.length === 0 ? "supported" : "not supported",
        reason: quoted
          ? missing.length === 0
            ? "the quote and every number are in the Passage"
            : `${missing.join(", ")} isn't in the Passage`
          : "the quote isn't in the Passage",
        tokens: noTokens(),
      };
    },
  },
];

export const judgementsFile = (runsDir: string, runFile: string, judge: string) =>
  join(runsDir, "judgements", `${runFile.replace(/\.json$/, "")}.${modelSlug(judge)}.jsonl`);

export function readJudgements(path: string): Map<string, Judgement> {
  const judged = new Map<string, Judgement>();
  if (!existsSync(path)) return judged;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const judgement = JSON.parse(line) as Judgement;
    judged.set(judgement.key, judgement);
  }
  return judged;
}

export interface Settlement {
  verdict: Verdict;
  /** Why, in a sentence: what the person read in the Passage. */
  why: string;
  date: string;
}

export const settledFile = (runsDir: string) => join(runsDir, "settled.json");

/** The settlements of a runs folder, by run file and Citation key. */
export function readSettled(runsDir: string): Record<string, Record<string, Settlement>> {
  const path = settledFile(runsDir);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, Settlement>>;
}

/** Both judges' verdict where they agree, else the person's, else unsettled. */
export function finalVerdict(
  first: Judgement | undefined,
  second: Judgement | undefined,
  settled: Settlement | undefined,
): FinalVerdict {
  if (!first || !second || first.verdict === "unread" || second.verdict === "unread") {
    return settled?.verdict ?? "unjudged";
  }
  if (first.verdict === second.verdict) return first.verdict;
  return settled?.verdict ?? "unsettled";
}

export interface JudgeTask {
  key: string;
  citation: RunCitation;
  question: string;
}

/**
 * Has `judge` read every Citation it hasn't yet, appending each verdict as it
 * comes; stops before a call the cap couldn't cover. Gives what it spent.
 */
export async function judgeAll(
  judge: Judge,
  tasks: readonly JudgeTask[],
  path: string,
  cap: { capUsd: number | null; spentUsd: number; perCallUsd: number },
  log: (line: string) => void,
): Promise<{ spentUsd: number; judged: number; stopped: string | null }> {
  const done = readJudgements(path);
  let spent = cap.spentUsd;
  let judged = 0;
  for (const task of tasks) {
    if (done.has(task.key)) continue;
    const refused = capProblem(cap.capUsd, judge.price, spent, cap.perCallUsd);
    if (refused) return { spentUsd: spent, judged, stopped: refused };
    const { citation } = task;
    const reply = await judge.judge({
      question: task.question,
      sentence: citation.sentence,
      quote: citation.quote,
      documentName: citation.documentName,
      passage: citation.passageText ?? "",
    });
    const usd = usdOf(reply.tokens, judge.price, judge.kind ?? "");
    spent += usd ?? 0;
    const line: Judgement = {
      key: task.key,
      verdict: reply.verdict,
      reason: reply.reason,
      judge: judge.id,
      prompt: PROMPT_SHA256,
      at: new Date().toISOString(),
      tokens: reply.tokens,
      usd,
    };
    appendFileSync(path, `${JSON.stringify(line)}\n`);
    judged++;
    if (reply.verdict === "unread") log(`${judge.id} on ${task.key}: its reply couldn't be read`);
  }
  return { spentUsd: spent, judged, stopped: null };
}
