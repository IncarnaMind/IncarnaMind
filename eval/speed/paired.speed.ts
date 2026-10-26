/**
 * `npm run eval:speed` with INCARNAMIND_EVAL_SPEED_PAIRED (README.md › Paired runs): each item of
 * the sets named, on each model, runs on two arms in one core, today's path and a new one, the
 * order turning item by item. Both are read the same way and compared item by item; the run
 * stops at the new arm's first false Supported that today's didn't give. Writes
 * eval/results/speed-paired-<time>/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { test } from "vitest";
import type { SaveChatProviderInput } from "../../src/core";
import { costOf } from "../../src/core/cost/price";
import { catalogFacts } from "../../src/core/providers/catalog";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { commitOf } from "../lib/commit";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { armNamed, armSwitch } from "./arms";
import { gradeAnswer } from "./judge";
import {
  type ArmRun,
  checksSet,
  everydaySet,
  gatingSet,
  hardSet,
  type Language,
  type PairedGroup,
  type PairedItem,
  runOnArm,
  SET_IDS,
  type SetId,
} from "./paired";
import {
  itemTable,
  newFalseSupported,
  outcomeOf,
  type PairedRow,
  pairedSection,
  seconds,
} from "./pairedReport";
import { percentile } from "./report";
import { env, list, modelNamed, modelsAsked, spentUsd } from "./settings";

const ROOT = resolve(__dirname, "../..");
const ANSWER_TIMEOUT_MS = 5 * 60_000;
/** An error kind no later item would get past (src/core/api.ts, ProviderErrorKind). */
const KEY_REFUSED = /^(?:out-of-credit|auth):/;

/** The judge, never a model under test, with what it has cost from the catalog's price. */
function judgeOf(models: readonly SaveChatProviderInput[]) {
  const sonnet = models.some((each) => each.modelId === "claude-sonnet-5-5");
  const named = modelNamed(
    env("JUDGE") ?? `anthropic/${sonnet ? "claude-opus-5-5" : "claude-sonnet-5-5"}`,
    "JUDGE",
  );
  if (models.some((each) => each.kind === named.kind && each.modelId === named.modelId)) {
    throw new Error("INCARNAMIND_EVAL_SPEED_JUDGE: the judge can't be a model under test.");
  }
  const price = catalogFacts(named.kind, named.modelId)?.price;
  let spent = 0;
  const counting: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      if (price) {
        const { inputTokens, outputTokens } = result.usage;
        spent += costOf(
          {
            inputTokens: inputTokens.total ?? 0,
            cachedInputTokens: inputTokens.cacheRead ?? 0,
            cacheWriteTokens: inputTokens.cacheWrite ?? 0,
            outputTokens: outputTokens.total ?? 0,
          },
          price,
          new Date(),
          { cacheWrites: named.kind === "anthropic" },
        );
      }
      return result;
    },
  };
  const model = wrapLanguageModel({
    model: createAiSdkChatModel({
      kind: named.kind,
      modelId: named.modelId,
      apiKey: named.apiKey ?? null,
      baseUrl: null,
      endpoint: named.endpoint ?? null,
      thinking: "off",
    }),
    middleware: counting,
  });
  return { name: `${named.kind}/${named.modelId}`, model, spent: () => spent };
}

function groupsOf(set: SetId, cacheDir: string): PairedGroup[] {
  switch (set) {
    case "gating":
      return gatingSet(ROOT, ANSWER_TIMEOUT_MS);
    case "hard":
      return hardSet(ROOT, cacheDir, ANSWER_TIMEOUT_MS);
    case "everyday":
      return everydaySet(ROOT, cacheDir);
    case "checks":
      return checksSet(ROOT);
  }
}

/** The items asked: in the languages and with the ids named, then at most `each` of a kind, the languages taking turns. */
function chosen(
  items: readonly PairedItem[],
  languages: readonly Language[] | null,
  ids: readonly string[] | null,
  each: number | null,
): PairedItem[] {
  const wanted = items.filter(
    (item) => (!languages || languages.includes(item.language)) && (!ids || ids.includes(item.id)),
  );
  if (each === null) return wanted;
  const kept = new Set<PairedItem>();
  for (const kind of new Set(wanted.map((item) => item.kind))) {
    const ofKind = wanted.filter((item) => item.kind === kind);
    const turns = [...new Set(ofKind.map((item) => item.language))].map((language) =>
      ofKind.filter((item) => item.language === language),
    );
    const picked: PairedItem[] = [];
    for (let index = 0; picked.length < each && index < ofKind.length; index++) {
      for (const next of turns.map((turn) => turn[index])) {
        if (next && picked.length < each) picked.push(next);
      }
    }
    for (const item of picked) kept.add(item);
  }
  return wanted.filter((item) => kept.has(item));
}

const line = (id: string, run: ArmRun) =>
  `${id} ${seconds(run.firstWordsMs)} words, ${seconds(run.doneMs)} done, ${run.modelCalls} calls ${outcomeOf(run)}`;

test.skipIf(env("PAIRED") === null)("paired runs: today's path against a new one", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const named = list("PAIRED") ?? [];
  if (named.length !== 2) {
    throw new Error(
      "INCARNAMIND_EVAL_SPEED_PAIRED names two arms: today's path, then the new one.",
    );
  }
  const arms = [armNamed(named[0] as string), armNamed(named[1] as string)] as const;
  const models = modelsAsked();
  if (models.length === 0) throw new Error("Set INCARNAMIND_EVAL_SPEED_MODELS.");
  const sets = (list("SETS") ?? ["gating"]).map((set) => {
    const found = SET_IDS.find((known) => known === set);
    if (!found)
      throw new Error(`INCARNAMIND_EVAL_SPEED_SETS: no set "${set}" (${SET_IDS.join(", ")}).`);
    return found;
  });
  const languages = (list("LANGUAGES") as Language[] | null) ?? null;
  const ids = list("ITEMS");
  const each = env("EACH") ? Number(env("EACH")) : null;
  const runs = Number(env("RUNS") ?? "1") || 1;
  const stopUsd = Number(env("STOP_USD") ?? "12");
  const margin = Number(env("MARGIN") ?? "0");
  const judge = judgeOf(models);
  const switcher = armSwitch();
  const reranker = createWorkerCrossEncoder(config.rerankOnCpu);
  const rows: PairedRow[] = [];
  const loads: number[] = [];
  let spentBefore = 0;
  let stopped: string | null = null;

  const bySet = sets.map((set) => groupsOf(set, config.cacheDir));
  // A set's items are chosen across its libraries, so EACH counts a kind once per set.
  const asked = new Set(
    bySet.flatMap((ofSet) =>
      chosen(
        ofSet.flatMap((group) => group.items),
        languages,
        ids,
        each,
      ),
    ),
  );
  run: for (const group of bySet.flat()) {
    if (!group.items.some((item) => asked.has(item))) continue;
    log(`Opening ${group.name}`);
    const opened = await group.open({
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker,
      keep: config.keepData,
      log,
      embeddings: false,
      recordTimings: true,
      chatModels: switcher.chatModels,
      answerPaths: switcher.answerPaths,
    });
    const { core, timings } = opened.library;
    try {
      if (!timings) throw new Error("The library records no timings.");
      // Setting the variables is the consent to send the items and their Passages to each model.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(
          request.requestId,
          request.flow.id === "chat" || request.flow.id === "checks",
        );
      });
      // Items the library can't ask give their place to others of their kind.
      const items = opened.leftOut
        ? chosen(
            group.items.filter((item) => !opened.leftOut?.has(item.id)),
            languages,
            ids,
            each,
          )
        : group.items.filter((item) => asked.has(item));
      for (const model of models) {
        const name = `${model.kind}/${model.modelId}`;
        const provider = await core.saveChatProvider(model);
        const choice = { providerId: provider.id, modelId: model.modelId };
        for (const [index, item] of items.entries()) {
          for (let time = 1; time <= runs; time++) {
            const spent = spentBefore + (await spentUsd(core)) + judge.spent();
            if (spent >= stopUsd) {
              stopped = `Stopped at $${spent.toFixed(2)}, before ${name} · ${item.id}.`;
              break run;
            }
            loads.push(loadavg()[0] ?? 0);
            // The order turns, so neither arm always meets a cache the other warmed.
            const order = (index + time) % 2 === 0 ? [0, 1] : [1, 0];
            const done: ArmRun[] = [];
            for (const which of order) {
              const arm = arms[which as 0 | 1];
              switcher.use(arm);
              await arm.prepare?.(core);
              done[which] = await runOnArm(item, {
                library: opened.library,
                recorder: timings,
                choice,
                model: name,
                arm: arm.id,
                grade: (expected, answer) => gradeAnswer(judge.model, expected, answer),
                claimsJudge: judge.model,
              });
            }
            const row: PairedRow = {
              set: item.set,
              id: item.id,
              kind: item.kind,
              language: item.language,
              model: name,
              run: time,
              baseline: done[0] as ArmRun,
              candidate: done[1] as ArmRun,
            };
            rows.push(row);
            log(
              `${name} · ${item.set} ${item.id} (${item.language}) · ${line(arms[0].id, row.baseline)} · ${line(arms[1].id, row.candidate)}`,
            );
            const refused = [row.baseline, row.candidate].find((each) =>
              KEY_REFUSED.test(each.error ?? ""),
            );
            if (refused) {
              stopped = `Stopped at ${name} · ${item.id}: ${refused.error}`;
              break run;
            }
            if (newFalseSupported(row)) {
              stopped = `${arms[1].id} stopped at ${name} · ${item.id}: a false Supported that ${arms[0].id} didn't give.`;
              break run;
            }
          }
        }
      }
    } finally {
      spentBefore += await spentUsd(core);
      await opened.close();
    }
  }

  const spent = spentBefore + judge.spent();
  const names: [string, string] = [arms[0].id, arms[1].id];
  const groups = [...new Set(rows.map((row) => `${row.model} · ${row.set}`))].map((title) => ({
    title,
    rows: rows.filter((row) => `${row.model} · ${row.set}` === title),
  }));
  const sections = groups.flatMap((group) => [
    `## ${group.title} (${group.rows.length} items)`,
    "",
    pairedSection(group.rows, names, margin),
    "",
  ]);
  const items = groups.flatMap((group) => [
    `### ${group.title}`,
    "",
    itemTable(group.rows, names),
    "",
  ]);
  const report = [
    `# Paired run: ${arms[0].id} against ${arms[1].id}`,
    "",
    `${new Date().toISOString()} · commit ${commitOf(ROOT)} · ${arms[0].id}: ${arms[0].label}; ${arms[1].id}: ${arms[1].label}. Judge: ${judge.name}.`,
    "",
    `This computer: ${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB; one-minute load ${loads.length ? `${Math.min(...loads).toFixed(1)} to ${Math.max(...loads).toFixed(1)}, median ${(percentile(loads, 0.5) ?? 0).toFixed(1)}` : "–"}. Spent: $${spent.toFixed(2)} (the judge $${judge.spent().toFixed(2)}).${stopped ? ` ${stopped}` : ""}`,
    "",
    `Times are from the User's action, median / 90th percentile. A guard counts the items both arms finished; lost: right with the first arm and not the second, gained: the other way round. Cited, judged right and every Citation found hold with up to ${margin} fewer items in 30.`,
    "",
    ...sections,
    "## Item by item",
    "",
    ...items,
  ].join("\n");
  console.log(report);
  const out = join(
    config.resultsDir,
    `speed-paired-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.md"), report);
  await writeFile(join(out, "report.json"), JSON.stringify({ arms: names, rows }, null, 2));
  log(`Report in ${out}`);
});
