/**
 * The judgement of an Answer's sentences against the words they quote, on a real model (#2739).
 * Each case of ../helpers/quoteStatesSentenceCases is asked in the assistant in a data folder of
 * its own: the Answer is scripted to the case's sentence and quote, so it is searched, cited and
 * quote-checked as usual, and only the batch that judges its sentences goes to the model.
 *
 * The bar: a sentence the case says ends with no green check never shows one, and every held-out
 * sentence its quote states keeps it. The issue's ten found Citations count how many show a quote
 * that states them.
 *
 * INCARNAMIND_LIVE_ANTHROPIC_KEY runs it, on INCARNAMIND_LIVE_ANTHROPIC_MODEL (Claude Haiku 5.5 by
 * default). INCARNAMIND_LIVE_REPORT appends a line per case with what was spent so far, and
 * INCARNAMIND_LIVE_MAX_USD (1 by default) starts no case past it.
 */
import { appendFile } from "node:fs/promises";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { MarkedCitation } from "../../src/core";
import { isSentenceBatch } from "../../src/core/answers/checks/sentenceBatch";
import type { ChatModelFactory } from "../../src/core/providers/models";
import { answerEnded, answerJudged } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { billedModels } from "../helpers/liveBilling";
import { scriptedModel } from "../helpers/models";
import {
  answering,
  type Case,
  CHINESE,
  DECOY_CHINESE,
  DECOY_ENGLISH,
  documentOf,
  ENGLISH,
  holds,
  STATED_CHINESE,
  STATED_ENGLISH,
} from "../helpers/quoteStatesSentenceCases";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const MAX_USD = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? 1);
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const { createChatModel, spent } = billedModels(MODEL);

const systemOf = (options: unknown): string => {
  const prompt = (options as { prompt?: { role?: string; content?: unknown }[] }).prompt ?? [];
  const system = prompt.find((message) => message.role === "system")?.content;
  return typeof system === "string" ? system : "";
};

/**
 * `scripted` for everything but the batch that judges the Answer's sentences, which `real` gets;
 * each batch's reply lands in `heard`.
 */
function judgedByReal(
  scripted: MockLanguageModelV4,
  real: ChatModelFactory,
  heard: string[],
): ChatModelFactory {
  return (spec) => {
    const judge = real(spec);
    return new Proxy(scripted, {
      get(target, property, receiver) {
        if (property === "doGenerate" || property === "doStream")
          return (options: unknown) => {
            const model = isSentenceBatch(systemOf(options)) ? judge : target;
            const method = Reflect.get(model, property) as (options: unknown) => Promise<unknown>;
            if (model !== judge) return method.call(model, options);
            return method.call(model, options).then((result) => {
              const content = (result as { content?: { type: string; text?: string }[] }).content;
              heard.push(content?.map((part) => part.text ?? "").join("") ?? "");
              return result;
            });
          };
        return Reflect.get(target, property, receiver);
      },
    });
  };
}

async function judged(
  each: Case,
  chinese: boolean,
  heard: string[],
): Promise<MarkedCitation | undefined> {
  const scripted = scriptedModel(answering(each), {
    generate: () => ({ text: '{"claims":[]}' }),
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: judgedByReal(scripted, createChatModel, heard),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
  const document = documentOf(each, chinese);
  await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), document.name, document.contents),
  ]);
  const asked = await core.askInConversation({
    text: chinese ? "这份报告怎么说？" : "What does the report say?",
  });
  if (!asked.asked) throw new Error("Not asked.");
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error("The Answer failed.");
  const answer = await answerJudged(core, asked.conversation.id, asked.answerId);
  return answer.citations.find((citation) => citation.marker === 1);
}

const SETS = [
  ["the ten, in English", ENGLISH, false],
  ["the ten, in Chinese", CHINESE, true],
  ["held out, stated, English Documents", STATED_ENGLISH, false],
  ["held out, stated, Chinese Documents", STATED_CHINESE, true],
  ["held out, a figure given to the wrong thing, English", DECOY_ENGLISH, false],
  ["held out, a figure given to the wrong thing, Chinese", DECOY_CHINESE, true],
] as const;

describe.each(SETS)(`${MODEL}, live: %s`, (_, cases, chinese) => {
  test.skipIf(KEY === undefined).each(cases.map((each) => ({ ...each })))(
    "a quote that $name: no green check unless it is to end found",
    { timeout: 300_000 },
    async (each) => {
      if (spent() >= MAX_USD) throw new Error(`Spent $${spent().toFixed(2)}, the cap.`);
      const heard: string[] = [];
      const citation = await judged(each, chinese, heard);
      const states = each.states.every((words) => holds(citation?.quote ?? "", words));
      if (REPORT) {
        await appendFile(
          REPORT,
          `${JSON.stringify({
            model: MODEL,
            name: each.name,
            chinese,
            ends: each.ends,
            check: citation?.check ?? null,
            states,
            quote: citation?.quote ?? null,
            verdict: citation?.verdict ?? null,
            judged: heard.join(" "),
            spent: Number(spent().toFixed(4)),
          })}\n`,
        );
      }
      if (each.ends === "found") expect(citation?.check).toBe("found");
      else expect(citation?.check).not.toBe("found");
    },
  );
});
