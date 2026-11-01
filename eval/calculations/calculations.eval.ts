/**
 * The calculations evaluation (eval/calculations/README.md, #441), part of
 * `npm run eval`: 80 Questions in English and Chinese over made-up reports,
 * a deck, a Word file, a workbook and a survey, each asked in the assistant
 * as the app asks it, and scored result by result.
 *
 * With a chat model (INCARNAMIND_EVAL_CHAT_*), each Question is asked with
 * the calculate Tool offered and again with it withheld, as the baseline.
 * Without one, a scripted model answers as the set says, with no key and no
 * network: a check of the set and the scoring, not a score of any model.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { ChatModelFactory, ConversationAnswer, Core } from "../../src/core";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { catalogModel, modelsProviderOfKind } from "../../src/core/providers/catalog";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readCalculatedFigureAttributes } from "../../src/shared/calculatedFigures";
import { readFigures } from "../../src/shared/figures";
import { queryDatabase } from "../../tests/helpers/core";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { CALCULATION_CASES, type CalculationCase } from "./cases";
import { writeCalculationDocuments } from "./documents";
import { calculationOracle } from "./oracle";
import {
  type Arm,
  type ArmRun,
  type CalculationsReport,
  summaryLines,
  writeCalculationsReport,
} from "./report";
import { type ObservedAnswer, type ObservedFigure, scoreCase } from "./score";

const root = fileURLToPath(new URL("../..", import.meta.url));

const SCRIPTED = { kind: "anthropic", modelId: "claude-haiku-5-5", apiKey: "scripted" } as const;

/** The Questions to ask: INCARNAMIND_EVAL_CALC_CASES names them; a real model skips the Analysis ones unless asked. */
function chosenCases(scripted: boolean): CalculationCase[] {
  const ids = process.env.INCARNAMIND_EVAL_CALC_CASES?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids?.length) {
    const unknown = ids.filter((id) => !CALCULATION_CASES.some((each) => each.id === id));
    if (unknown.length)
      throw new Error(
        `INCARNAMIND_EVAL_CALC_CASES names unknown Questions: ${unknown.join(", ")}.`,
      );
    return CALCULATION_CASES.filter((each) => ids.includes(each.id));
  }
  // No Analysis runtime runs outside the app (ADR-0023): a real model's Answers to these measure nothing yet.
  const analysis = scripted || process.env.INCARNAMIND_EVAL_CALC_ANALYSIS === "on";
  return CALCULATION_CASES.filter((each) => analysis || !each.analysis);
}

function chosenArms(scripted: boolean): Arm[] {
  const raw = process.env.INCARNAMIND_EVAL_CALC_ARMS?.trim();
  if (!raw) return scripted ? ["on"] : ["on", "off"];
  const arms = raw.split(",").map((each) => each.trim());
  if (!arms.every((each): each is Arm => each === "on" || each === "off")) {
    throw new Error(`INCARNAMIND_EVAL_CALC_ARMS must list "on", "off" or both, not "${raw}".`);
  }
  return arms;
}

/** Text as the User reads it: each calculated figure as shown, or `figure` in its place. */
const textOf = (nodes: readonly NodeJSON[], figure?: string): string =>
  nodes
    .map((node) =>
      node.type === "text"
        ? (node.text ?? "")
        : node.type === "calculatedFigure"
          ? (figure ?? readCalculatedFigureAttributes(node.attrs)?.figure.shown ?? "")
          : `${textOf(node.content ?? [], figure)} `,
    )
    .join("");

function observe(
  answer: ConversationAnswer,
  language: CalculationCase["language"],
  names: ReadonlyMap<string, string>,
  seconds: number,
  requests: number,
): ObservedAnswer {
  const blocks = answerBlocks(answer);
  const figures = answer.figures.map(
    (figure): ObservedFigure => ({
      value: figure.value,
      unit: figure.unit.kind,
      currency: figure.unit.kind === "currency" ? figure.unit.code : null,
      shown: figure.shown,
      inputs: figure.inputs.map((input) => {
        const place = input.citation.location;
        const pages = place && (place.kind === "page" || place.kind === "slide") ? place : null;
        return {
          document: names.get(input.citation.documentId) ?? input.citation.documentName,
          value: input.number.value,
          currency:
            input.number.unit.kind === "currency"
              ? input.number.unit.code
              : (input.unitStatement?.currency ?? null),
          pageFrom: pages?.from ?? input.citation.pageFrom,
          pageTo: pages?.to ?? input.citation.pageTo,
        };
      }),
      literals: figure.literals.map((literal) => literal.value),
    }),
  );
  const written = readFigures(textOf(blocks, " ¤ "), {
    language: language === "zh" ? "zh-CN" : "en",
  }).map((figure) => ({
    chars: figure.chars,
    value: figure.value,
    unit: figure.unit.kind,
    currency: figure.unit.kind === "currency" ? figure.unit.code : null,
  }));
  return {
    status: answer.status,
    error: answer.errorMessage,
    text: textOf(blocks).replace(/\s+/g, " ").trim(),
    figures,
    written,
    seconds,
    requests,
  };
}

/** Asks in a new conversation, in `scope`, and waits until its Answer has ended. */
async function ask(core: Core, question: string, documentIds: readonly string[] | null) {
  const started = Date.now();
  const result = await core.askInConversation({
    text: question,
    ...(documentIds && { scope: { folderIds: [], tagIds: [], documentIds: [...documentIds] } }),
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done()),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
    ];
    function done() {
      for (const stop of stops) stop();
      resolve();
    }
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer, seconds: (Date.now() - started) / 1000 };
}

interface Billed {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

const billedIn = (dataDir: string): Billed =>
  queryDatabase<Billed>(
    dataDir,
    `SELECT count(*) AS requests, coalesce(sum(input_tokens), 0) AS inputTokens,
       coalesce(sum(cached_input_tokens), 0) AS cacheReadTokens,
       coalesce(sum(cache_write_tokens), 0) AS cacheWriteTokens,
       coalesce(sum(output_tokens), 0) AS outputTokens
     FROM model_requests WHERE deleted_at IS NULL`,
  )[0] ?? { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

const minus = (after: Billed, before: Billed): Billed => ({
  requests: after.requests - before.requests,
  inputTokens: after.inputTokens - before.inputTokens,
  cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
  cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
  outputTokens: after.outputTokens - before.outputTokens,
});

async function spentOf(core: Core): Promise<Map<string, number>> {
  const spent = new Map<string, number>();
  for (const each of (await core.getCostSummary()).spent) {
    spent.set(each.currency, (spent.get(each.currency) ?? 0) + each.amount);
  }
  return spent;
}

test("calculations evaluation", async () => {
  const started = new Date();
  const log = createLog(started.getTime());
  const config = readConfig(root);
  if (config.questionIds) {
    log(
      "Calculations: skipped, INCARNAMIND_EVAL_QUESTIONS asks for a short run. Run it alone with `npm run eval -- eval/calculations`.",
    );
    return;
  }
  const chat = config.chat;
  const scripted = chat === null;
  const cases = chosenCases(scripted);
  const arms = chosenArms(scripted);
  const runs = Number(process.env.INCARNAMIND_EVAL_CALC_RUNS ?? "1");
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error("INCARNAMIND_EVAL_CALC_RUNS must be a whole number of at least 1.");
  const provider = chat ? chatProviderOf(chat) : SCRIPTED;
  const entry = catalogModel(modelsProviderOfKind(provider.kind), provider.modelId);
  // The calculate fact lives only in the catalog, which has no entry for a local model yet (#441
  // names src/core/providers/catalog/local.ts for it): until then such a model can't be run here.
  if (!entry)
    throw new Error(
      `The catalog has no entry for ${provider.kind}/${provider.modelId}, so the calculate Tool can't be offered or withheld for it.`,
    );
  const offered = entry.calculates;
  log(
    `Calculations: ${cases.length} Questions, ${runs} run(s), Tools ${arms.join(" and ")}, on ${scripted ? "the scripted model" : `${provider.kind}/${provider.modelId}`}`,
  );

  const sources = await mkdtemp(join(tmpdir(), "incarnamind-eval-calculations-sources-"));
  const oracle = scripted ? calculationOracle(cases) : null;
  const library = await openLibrary({
    name: "calculations",
    embedder: createFakeEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    ...(!scripted && { reranker: createWorkerCrossEncoder() }),
    documents: await writeCalculationDocuments(sources),
    embeddings: false,
    keep: config.keepData,
    log,
    ...(oracle && {
      chatModels: (): ChatModelFactory => () => oracle,
      // The scripted model calls its Tools from the first request, whatever the retrieve-first list says.
      answerPaths: { retrievesFirst: () => false },
    }),
  });
  const report: CalculationsReport = {
    run: { startedAt: started.toISOString(), seconds: 0, commit: commitOf(root), runs },
    arms: [],
  };
  try {
    const { core } = library;
    // Setting the variables is the consent to send the Questions and Passages to the chat model.
    core.on("consent.requested", (request) => {
      void core.respondToConsent(request.requestId, true);
    });
    const saved = await core.saveChatProvider(provider);
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    const idOf = (name: string) => {
      const document = library.documents.get(name);
      if (!document) throw new Error(`${name} wasn't added.`);
      return document.id;
    };
    const names = new Map([...library.documents].map(([name, document]) => [document.id, name]));
    for (const arm of arms) {
      // The fact the evaluation decides (#441), set in this process only, as a catalog entry would set it.
      entry.calculates = arm === "on";
      const before = billedIn(library.dataDir);
      const spentBefore = await spentOf(core);
      const armRun: ArmRun = {
        model: `${provider.kind}/${provider.modelId}`,
        arm,
        scripted,
        cases: [],
        usage: before,
        spent: [],
        answers: [],
      };
      for (let run = 1; run <= runs; run++) {
        for (const each of cases) {
          const billed = billedIn(library.dataDir).requests;
          const { answer, seconds } = await ask(core, each.question, each.scope?.map(idOf) ?? null);
          const requests = billedIn(library.dataDir).requests - billed;
          const observed = observe(answer, each.language, names, seconds, requests);
          armRun.cases.push(scoreCase(each, observed));
          armRun.answers.push({ id: each.id, run, observed });
          if (observed.status !== "done")
            log(
              `${each.id}, Tools ${arm}: ${observed.status}${observed.error ? ` (${observed.error})` : ""}`,
            );
        }
        log(`Tools ${arm}, run ${run}: ${cases.length} Questions asked`);
      }
      armRun.usage = minus(billedIn(library.dataDir), before);
      const spentAfter = await spentOf(core);
      armRun.spent = [...spentAfter].map(([currency, amount]) => ({
        currency,
        amount: amount - (spentBefore.get(currency) ?? 0),
      }));
      report.arms.push(armRun);
    }
    entry.calculates = offered;
  } finally {
    await library.close();
    await rm(sources, { recursive: true, force: true });
  }
  report.run.seconds = (Date.now() - started.getTime()) / 1000;
  const dir = await writeCalculationsReport(report, config.resultsDir);
  console.log(summaryLines(report, dir).join("\n"));
  if (scripted) {
    // The scripted model answers as the set says: anything short of every result found is the set's fault.
    for (const arm of report.arms) {
      expect(arm.cases.filter((each) => each.failed).map((each) => each.id)).toEqual([]);
      expect(arm.cases.flatMap((each) => each.falseChecked)).toEqual([]);
      expect(
        arm.cases.flatMap((each) =>
          each.results
            .filter(
              (result) =>
                (result.outcome !== "calculated" && result.outcome !== "written") ||
                result.inputsRight === false,
            )
            .map((result) => `${each.id}: ${result.label} ${result.outcome}`),
        ),
      ).toEqual([]);
      expect(
        arm.cases.filter((each) => each.refusal && !each.refusal.refused).map((each) => each.id),
      ).toEqual([]);
    }
  }
});
