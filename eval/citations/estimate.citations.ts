/**
 * `npm run eval:citations:estimate`: the tokens and US dollars each planned
 * model's full run is expected to take, before anything is sent, and the most
 * it may. A model whose runs already started is estimated from what its
 * Questions took. It calls no model.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { ChatProviderKind } from "../../src/core";
import { chatProviderKinds } from "../../src/core";
import { loadCitationSet } from "./checkSet";
import { estimate, labelOf, type ModelRef, PLANNED_JUDGES, PLANNED_MODELS, priceOf } from "./cost";
import { readRun, runFileName } from "./runs";
import { readSettings } from "./settings";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** "anthropic/claude-haiku-5-5,kimi/kimi-k2.6@intl": models to estimate instead of the plan. */
function modelsNamed(raw: string | undefined): ModelRef[] | null {
  if (!raw?.trim()) return null;
  return raw.split(",").map((each) => {
    const [named, endpoint] = each.trim().split("@");
    const slash = named?.indexOf("/") ?? -1;
    const kind = named?.slice(0, slash) as ChatProviderKind;
    if (slash < 1 || !chatProviderKinds.includes(kind)) {
      throw new Error(`"${each}" isn't kind/model, e.g. anthropic/claude-haiku-5-5.`);
    }
    return { kind, modelId: named?.slice(slash + 1) ?? "", endpoint: endpoint ?? null };
  });
}

const usd = (amount: number) => `$${amount.toFixed(2)}`;
const thousands = (tokens: number) => `${Math.round(tokens / 1000).toLocaleString("en-US")}k`;

test("the citation benchmark's cost estimate", async () => {
  const settings = readSettings(root);
  const set = await loadCitationSet(root);
  const models = modelsNamed(process.env.INCARNAMIND_EVAL_CITATIONS_MODELS) ?? [...PLANNED_MODELS];
  const rows: string[] = [
    `| Model | Price in / out per million | Questions | Tokens in / out | Expected, the run | Judges' tokens in / out | Expected, the judges | At most, both | From |`,
    `|---|---|---|---|---|---|---|---|---|`,
  ];
  let runs = 0;
  let judging = 0;
  let most = 0;
  for (const model of models) {
    const label = labelOf(model);
    let tokens = { inputTokens: 0, outputTokens: 0 };
    let answered = 0;
    for (const language of settings.languages) {
      const run = readRun(join(settings.runsDir, runFileName(label, language)));
      for (const answer of run?.answers ?? []) {
        answered++;
        for (const part of [answer.tokens.answer, answer.tokens.check]) {
          tokens = {
            inputTokens: tokens.inputTokens + part.inputTokens,
            outputTokens: tokens.outputTokens + part.outputTokens,
          };
        }
      }
    }
    const questions = set.questions.filter((question) =>
      settings.languages.includes(question.language),
    ).length;
    const measured =
      answered > 0 && tokens.inputTokens > 0
        ? {
            inputTokens: tokens.inputTokens / answered,
            outputTokens: tokens.outputTokens / answered,
          }
        : null;
    const result = estimate(model, questions, {
      check: settings.check,
      judges: PLANNED_JUDGES,
      measured,
    });
    const price = priceOf(model);
    runs += result.runUsd;
    judging += result.judgesUsd;
    most += result.mostUsd;
    rows.push(
      `| ${label}${model.endpoint ? ` (${model.endpoint})` : ""} | ${price ? `${price.currency} ${price.input} / ${price.output}` : "none"} | ${questions} | ${thousands(result.tokens.inputTokens)} / ${thousands(result.tokens.outputTokens)} | ${price ? usd(result.runUsd) : "none"} | ${thousands(result.judgeTokens.inputTokens)} / ${thousands(result.judgeTokens.outputTokens)} | ${usd(result.judgesUsd)} | ${usd(result.mostUsd)} | ${result.basis === "measured" ? `${answered} Questions measured` : "assumed"} |`,
    );
  }
  rows.push(`| **All** | | | | **${usd(runs)}** | | **${usd(judging)}** | **${usd(most)}** | |`);
  console.log(
    [
      `The citation benchmark: ${settings.languages.join(" and ")}, ${settings.check ? "each Note checked" : "no check"}, judged by ${PLANNED_JUDGES.map(labelOf).join(" and ")}.`,
      "Expected: the provider's prompt cache serving 70% of the input where its price has a cache rate. At most: every Question and every verdict taking four times the tokens, none cached.",
      "",
      ...rows,
    ].join("\n"),
  );
  expect(models.length).toBeGreaterThan(0);
});
