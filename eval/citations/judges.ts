/**
 * "Supported": whether the Passage a Citation names supports its sentence, as
 * two independent model judges say with one fixed prompt. Each judge's
 * verdicts go into a file of their own beside the run's, one line a Citation,
 * so judging resumes where it stopped and scoring reads them without asking
 * again. A verdict holds for the Citation it read, by the SHA-256 of what the
 * judge was given, and for the prompt it was given: an Answer asked again, or
 * a changed prompt, is judged again. Where the judges disagree, a person
 * settles it in `settled.json`. A judge is anything that answers `judge`: a
 * model through the app's own provider code, or, to check the pipeline at no
 * cost, a scripted stand-in.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "ai";
import { createAiSdkChatModel } from "../../src/core";
import { inCurrency, promptTokensOf, reservationOf } from "../../src/core/cost/price";
import { type ChatSettings, chatModelSpecOf } from "../lib/config";
import { capProblem, labelOf, priceOf, usdOf } from "./cost";
import { modelSlug, noTokens, type RunAnswer, type RunCitation, sha256, type Tokens } from "./runs";
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
  /** The SHA-256 of the `JudgeInput` it read. */
  input: string;
  /** The SHA-256 of the instructions it was given. */
  prompt: string;
  at: string;
  tokens: Tokens;
  usd: number | null;
}

export interface Judge {
  /** "anthropic/claude-opus-5-5", or a scripted stand-in's name. */
  id: string;
  kind: string | null;
  /** Who made the model (`makerOf`): it may not judge that maker's models. Null for a scripted stand-in. */
  maker: string | null;
  judge(
    input: JudgeInput,
  ): Promise<{ verdict: Verdict | "unread"; reason: string; tokens: Tokens }>;
  price: ReturnType<typeof priceOf>;
  /** The most one verdict may cost, in US dollars, every attempt at it included; 0 without a price. */
  mostUsd(input: JudgeInput): number;
}

/** Model names by their makers. */
const MAKERS: readonly (readonly [RegExp, string])[] = [
  [/^claude/, "Anthropic"],
  [/^(?:gpt|chatgpt|codex|o\d)/, "OpenAI"],
  [/^(?:gemini|gemma)/, "Google"],
  [/^(?:kimi|moonshot)/, "Moonshot AI"],
  [/^deepseek/, "DeepSeek"],
  [/^(?:qwen|qwq)/, "Alibaba"],
  [/^llama/, "Meta"],
  [/^(?:mistral|mixtral|magistral|ministral|codestral|devstral)/, "Mistral AI"],
  [/^grok/, "xAI"],
  [/^glm/, "Zhipu AI"],
  [/^minimax/, "MiniMax"],
];

/**
 * Who made a model, from its id, whichever service serves it: "claude-opus-5-5"
 * and "anthropic/claude-sonnet-5-5" are both Anthropic's. Two models of one
 * maker are no independent judges of each other. Null when the id doesn't
 * say: a router's alias ("openrouter/auto") may send to any maker's model.
 */
export function makerOf(modelId: string): string | null {
  const name = (modelId.toLowerCase().split("/").at(-1) ?? "").trim();
  return MAKERS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** Why two model judges can't judge together, or null when they can. */
export function judgePairProblem(judges: readonly Judge[]): string | null {
  const unknown = judges.find((judge) => judge.maker === null);
  if (unknown) {
    return `Who makes ${unknown.id} can't be told from its name, so it can't be shown to be of another maker than a run's: name a model, not a router's alias.`;
  }
  const [first, second] = judges;
  if (first?.maker === second?.maker) {
    return `The two judges are both ${first?.maker}'s models: name judges of two makers, so they judge independently.`;
  }
  return null;
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
      // "partially supported" would read as supported below: a hedge is no verdict.
      return { verdict: "unread", reason: text.slice(0, 200) };
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

/** A verdict is asked at most this many times when the provider fails, each a request that may bill. */
const JUDGE_ATTEMPTS = 3;
const JUDGE_OUTPUT_TOKENS = 400;

/** A model judge, asked through the app's own provider code. Every call costs money. */
export function modelJudge(settings: ChatSettings): Judge {
  const model = createAiSdkChatModel(chatModelSpecOf(settings));
  const price = priceOf(settings);
  return {
    id: labelOf(settings),
    kind: settings.kind,
    maker: makerOf(settings.modelId),
    price,
    mostUsd(input) {
      if (!price) return 0;
      const prompt = [{ content: JUDGE_INSTRUCTIONS }, { content: promptFor(input) }];
      const most = reservationOf(
        {
          promptTokens: promptTokensOf(prompt),
          outputTokens: JUDGE_OUTPUT_TOKENS,
          cacheWrites: settings.kind === "anthropic",
        },
        price,
        new Date(),
      );
      return JUDGE_ATTEMPTS * inCurrency(most, price.currency, "USD");
    },
    async judge(input) {
      const result = await generateText({
        model,
        instructions: JUDGE_INSTRUCTIONS,
        prompt: promptFor(input),
        maxOutputTokens: JUDGE_OUTPUT_TOKENS,
        maxRetries: JUDGE_ATTEMPTS - 1,
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
    maker: null,
    price: null,
    mostUsd: () => 0,
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
    maker: null,
    price: null,
    mostUsd: () => 0,
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

/** A judge's id names a scripted stand-in, not a model. */
export const isScriptedJudge = (id: string) => SCRIPTED_JUDGES.some((judge) => judge.id === id);

export const judgementsFile = (runsDir: string, runFile: string, judge: string) =>
  join(runsDir, "judgements", `${runFile.replace(/\.json$/, "")}.${modelSlug(judge)}.jsonl`);

/** The files of every judge's verdicts on a run, in the folder. */
export function judgeFiles(runsDir: string, runFile: string): string[] {
  const folder = join(runsDir, "judgements");
  if (!existsSync(folder)) return [];
  const base = runFile.replace(/\.json$/, "");
  return readdirSync(folder)
    .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(folder, name));
}

/**
 * Why a pair of judges leaves a run for another pair, or null when it judges
 * it: one of them is the maker's of the run's model, the run's model's maker
 * isn't known, or another judge has begun on the run, whose verdicts would
 * make three. The scripted stand-ins judge any run.
 */
export function leftFor(
  runsDir: string,
  runFile: string,
  modelId: string,
  judges: readonly Judge[],
): string | null {
  if (judges.some((judge) => judge.maker !== null)) {
    const maker = makerOf(modelId);
    if (maker === null) {
      return `who makes ${modelId} can't be told from its name, so no judge can be shown to be of another maker`;
    }
    const own = judges.find((judge) => judge.maker === maker);
    if (own) return `${own.id} is ${maker}'s, as the run's model is: judge it with another pair`;
  }
  const pair = new Set(judges.map((judge) => judgementsFile(runsDir, runFile, judge.id)));
  const others = judgeFiles(runsDir, runFile).filter((path) => !pair.has(path));
  if (others.length === 0) return null;
  const by = others.map((path) => [...readJudgements(path).values()][0]?.judge ?? path);
  return `${by.join(" and ")} began judging it: judge it with that pair`;
}

/** What a judge is given of a Citation of an Answer. */
export const judgeInputOf = (
  answer: Pick<RunAnswer, "question">,
  citation: RunCitation,
): JudgeInput => ({
  question: answer.question,
  sentence: citation.sentence,
  quote: citation.quote,
  documentName: citation.documentName,
  passage: citation.passageText ?? "",
});

export const inputSha256 = (input: JudgeInput) => sha256(JSON.stringify(input));

/** A verdict that holds for this input under today's prompt; undefined for none or a stale one. */
export function currentVerdict(
  judged: ReadonlyMap<string, Judgement>,
  key: string,
  input: JudgeInput,
): Judgement | undefined {
  const judgement = judged.get(key);
  return judgement?.input === inputSha256(input) && judgement.prompt === PROMPT_SHA256
    ? judgement
    : undefined;
}

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

/** What every verdict in a judgements file cost, those asked again included, in US dollars. */
export function judgementsUsd(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .reduce((sum, line) => sum + ((JSON.parse(line) as Judgement).usd ?? 0), 0);
}

/** What all the judging in a runs folder has cost, every judge's and every run's, in US dollars. */
export function judgingUsd(runsDir: string): number {
  const folder = join(runsDir, "judgements");
  if (!existsSync(folder)) return 0;
  return readdirSync(folder)
    .filter((name) => name.endsWith(".jsonl"))
    .reduce((sum, name) => sum + judgementsUsd(join(folder, name)), 0);
}

export interface Settlement {
  verdict: Verdict;
  /** The `input` of the Citation as `disagreements.json` lists it, so a settlement holds for that Citation only. */
  input: string;
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
  input: JudgeInput;
}

/**
 * Has `judge` read every Citation it has no current verdict on, appending
 * each verdict as it comes; stops before a verdict whose most the cap
 * couldn't cover. Gives what it spent.
 */
export async function judgeAll(
  judge: Judge,
  tasks: readonly JudgeTask[],
  path: string,
  cap: { capUsd: number | null; spentUsd: number },
  log: (line: string) => void,
): Promise<{ spentUsd: number; judged: number; stopped: string | null }> {
  const done = readJudgements(path);
  let spent = cap.spentUsd;
  let judged = 0;
  for (const task of tasks) {
    // A reply that couldn't be read is asked again; the later line replaces it.
    const current = currentVerdict(done, task.key, task.input);
    if (current && current.verdict !== "unread") continue;
    const refused = capProblem(cap.capUsd, judge.price, spent, {
      usd: judge.mostUsd(task.input),
      what: "the next verdict may cost up to",
    });
    if (refused) return { spentUsd: spent, judged, stopped: refused };
    const reply = await judge.judge(task.input);
    const usd = usdOf(reply.tokens, judge.price, judge.kind ?? "");
    spent += usd ?? 0;
    const line: Judgement = {
      key: task.key,
      verdict: reply.verdict,
      reason: reply.reason,
      judge: judge.id,
      input: inputSha256(task.input),
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
