/**
 * `INCARNAMIND_EVAL_SPEED_RERANK=wait npm run eval:speed` (README.md › Where a rerank's time goes):
 * the built-in reranker on this computer, over searches made as a check makes them on the mixed
 * sample set, in English and Chinese, to find why a rerank takes longer at twelve checks at once
 * than at six (#2532). No model request; nothing leaves this computer. `RUNS` rounds (3 by default),
 * the order turning each round, the load read before each part:
 * - **The app's line:** the core's reranking queue over the model on a worker thread, as the app
 *   runs it, with 1, 6 and 12 searches asked at once: each rerank's wait in the line and its work.
 * - **The model at once:** the same model in this process, 1, 2 and 4 searches scored at once
 *   with no line, for whether the device does more when given more.
 * - **Where a search's work goes:** its texts' tokens, its tensors and the model's runs, by the
 *   number of texts a GPU run holds (8, as the app runs it, then 16, 32 and 64), with every score
 *   beside 8's.
 * - **The CPU:** the same searches on the CPU file, one at a time.
 * `INCARNAMIND_EVAL_SPEED_RERANK=padding`: how much of a search's GPU work is padding, and the same
 * texts longest first and as found, against today's order and scores.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { CrossEncoder, RerankingModelFiles } from "../../src/core/adapters";
import { TOKENIZERS } from "../../src/core/engineModules";
import { BUILT_IN_RERANKING_MODEL } from "../../src/core/reranking/model";
import {
  createOnnxCrossEncoder,
  createOrtSession,
  pairEncoder,
} from "../../src/core/reranking/onnx";
import { createRerankQueue } from "../../src/core/reranking/order";
import { normaliseText } from "../../src/shared/text";
import { buildPdf } from "../../tests/helpers/pdf";
import { reports } from "../everyday/asking";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import type { EvalDocument } from "../lib/evaluationSet";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { SETS, writeDocuments } from "../repeats/cases";
import { env } from "./settings";
import { HELD_OUT_DOCUMENTS } from "./writtenHeldOut";

const ROOT = resolve(__dirname, "../..");
const LANGUAGES = [
  { language: "en", sets: ["en", "en-paraphrases"] },
  { language: "zh-CN", sets: ["zh", "zh-paraphrases"] },
] as const;
const PER_LANGUAGE = 24;

interface Search {
  query: string;
  texts: string[];
}

/** The searches a check of the sample sentences makes, as the reranker is given them: normalised, as `rerankText` gives them. */
async function sampleSearches(): Promise<Search[]> {
  const log = createLog();
  const config = readConfig(ROOT);
  const searches: Search[] = [];
  for (const { language, sets } of LANGUAGES) {
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-rerank-wait-"));
    const documents: EvalDocument[] = [
      ...(await writeDocuments(folder, { id: sets[0], language })),
      ...(await reports()),
    ];
    for (const document of HELD_OUT_DOCUMENTS) {
      if (document.language !== language || !document.libraries.includes("terms")) continue;
      const path = join(folder, document.file);
      await writeFile(path, buildPdf(document.pages));
      documents.push({ key: document.file, path });
    }
    const inner = createWorkerCrossEncoder();
    const recording: CrossEncoder = {
      load: (files) => inner.load(files),
      score(query, texts) {
        searches.push({ query, texts: [...texts] });
        return inner.score(query, texts);
      },
      close: () => inner.close(),
    };
    const library = await openLibrary({
      name: "rerank-wait",
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker: recording,
      documents,
      embeddings: false,
      keep: false,
      log,
    });
    try {
      const sentences = sets.flatMap((id) => SETS.find((set) => set.id === id)?.sentences ?? []);
      for (const { text } of sentences.slice(0, PER_LANGUAGE))
        await library.core.searchEvidence(text);
    } finally {
      await library.close();
      await rm(folder, { recursive: true, force: true });
    }
  }
  return searches;
}

const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const ms = (values: readonly number[]) =>
  values.length === 0
    ? "–"
    : `${Math.round(median(values))} (${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))})`;
const load = () => loadavg()[0]?.toFixed(1) ?? "–";

/** Runs `each` over `items`, `atOnce` at a time; the wall time. */
async function atOnceOver<T>(
  items: readonly T[],
  atOnce: number,
  each: (item: T) => Promise<void>,
) {
  let next = 0;
  const begun = performance.now();
  await Promise.all(
    Array.from({ length: atOnce }, async () => {
      while (next < items.length) await each(items[next++] as T);
    }),
  );
  return performance.now() - begun;
}

const timed = env("RERANK") === "wait" ? test : test.skip;

timed("where a rerank's time goes, at six and at twelve at once", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const rounds = Number(env("RUNS") ?? "3");
  const searches = await sampleSearches();
  const { gpu, folder, files: paths, maxTokens } = BUILT_IN_RERANKING_MODEL;
  if (!gpu) throw new Error("The built-in reranking model has no GPU file.");
  const models = join(config.cacheDir, "models");
  const cpuFiles: RerankingModelFiles = {
    model: join(models, folder, paths.model),
    tokenizer: join(models, folder, paths.tokenizer),
    tokenizerConfig: join(models, folder, paths.tokenizerConfig),
    maxTokens,
  };
  const files: RerankingModelFiles = {
    ...cpuFiles,
    gpu: { model: join(models, gpu.folder, gpu.file.path), check: gpu.check },
  };
  const lines: string[] = [];
  const say = (line: string) => {
    log(line);
    lines.push(line);
  };
  say(
    `${searches.length} searches of ${median(searches.map((each) => each.texts.length))} texts at the median (${Math.min(...searches.map((each) => each.texts.length))}–${Math.max(...searches.map((each) => each.texts.length))}); ${rounds} rounds; load ${load()} at the start; milliseconds, median (range) over the searches of every round`,
  );

  // The app's line: the queue over the worker thread's model.
  const line = new Map<
    number,
    { wait: number[]; work: number[]; wall: number[]; loads: string[] }
  >();
  const worker = createWorkerCrossEncoder();
  const device = await worker.load(files);
  say(`The worker's model runs on the ${device.device}.`);
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? [1, 6, 12] : [12, 6, 1];
    for (const atOnce of order) {
      const inTurn = createRerankQueue();
      const entry = line.get(atOnce) ?? { wait: [], work: [], wall: [], loads: [] };
      line.set(atOnce, entry);
      entry.loads.push(load());
      entry.wall.push(
        await atOnceOver(searches, atOnce, async ({ query, texts }) => {
          const asked = performance.now();
          await inTurn(async () => {
            const started = performance.now();
            await worker.score(normaliseText(query), texts);
            entry.work.push(performance.now() - started);
            entry.wait.push(started - asked);
          });
        }),
      );
    }
  }
  worker.close();
  lines.push(
    "",
    "| The app's line: searches asked at once | Wait in the line | Work | Wait and work | Wall for all, a round | Load at each |",
    "|--:|--:|--:|--:|--:|---|",
    ...[...line].map(([atOnce, each]) => {
      const total = each.wait.map((wait, at) => wait + (each.work[at] ?? 0));
      return `| ${atOnce} | ${ms(each.wait)} | ${ms(each.work)} | ${ms(total)} | ${ms(each.wall)} | ${each.loads.join(", ")} |`;
    }),
  );

  // Two sessions, each taking the next search: a second session on the same GPU, against one. In
  // this process: two sessions on two worker threads stopped the process with SIGSEGV.
  const sessions = new Map<number, { wall: number[]; loads: string[] }>();
  for (let round = 0; round < rounds; round++) {
    for (const count of round % 2 === 0 ? [1, 2] : [2, 1]) {
      const workers = Array.from({ length: count }, () => createOnnxCrossEncoder());
      for (const each of workers) await each.load(files);
      const entry = sessions.get(count) ?? { wall: [], loads: [] };
      sessions.set(count, entry);
      entry.loads.push(load());
      let next = 0;
      const begun = performance.now();
      await Promise.all(
        workers.map(async (each) => {
          while (next < searches.length) {
            const search = searches[next++];
            if (search) await each.score(normaliseText(search.query), search.texts);
          }
        }),
      );
      entry.wall.push(performance.now() - begun);
      for (const each of workers) each.close();
    }
  }
  lines.push(
    "",
    "| GPU sessions in one process | Wall for all, a round | Load at each |",
    "|--:|--:|---|",
    ...[...sessions].map(
      ([count, each]) => `| ${count} | ${ms(each.wall)} | ${each.loads.join(", ")} |`,
    ),
  );

  // The model at once, with no line: does the device do more when given more?
  const inProcess = createOnnxCrossEncoder();
  await inProcess.load(files);
  const baseline: number[][] = [];
  for (const { query, texts } of searches)
    baseline.push(await inProcess.score(normaliseText(query), texts));
  const parallel = new Map<
    number,
    { wall: number[]; each: number[]; loads: string[]; differ: number }
  >();
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? [1, 2, 4] : [4, 2, 1];
    for (const atOnce of order) {
      const entry = parallel.get(atOnce) ?? { wall: [], each: [], loads: [], differ: 0 };
      parallel.set(atOnce, entry);
      entry.loads.push(load());
      const indexed = searches.map((search, index) => ({ ...search, index }));
      entry.wall.push(
        await atOnceOver(indexed, atOnce, async ({ query, texts, index }) => {
          const started = performance.now();
          const scores = await inProcess.score(normaliseText(query), texts);
          entry.each.push(performance.now() - started);
          entry.differ += scores.filter(
            (score, at) => !Object.is(score, baseline[index]?.[at]),
          ).length;
        }),
      );
    }
  }
  inProcess.close();
  lines.push(
    "",
    "| The model at once, no line: searches scored at once | Each search, from its call to its scores | Wall for all, a round | Scores unlike one at a time | Load at each |",
    "|--:|--:|--:|--:|---|",
    ...[...parallel].map(
      ([atOnce, each]) =>
        `| ${atOnce} | ${ms(each.each)} | ${ms(each.wall)} | ${each.differ} | ${each.loads.join(", ")} |`,
    ),
  );

  // Where a search's work goes, by the texts a GPU run holds.
  const { Tokenizer } = await TOKENIZERS.load();
  const tokenizerConfig = JSON.parse(await readFile(cpuFiles.tokenizerConfig, "utf8"));
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(cpuFiles.tokenizer, "utf8")),
    tokenizerConfig,
  );
  const padId = tokenizer.token_to_id(tokenizerConfig.pad_token) ?? 1;
  const gpuFolder = join(models, gpu.folder, "onnx");
  const copy = (await readdir(gpuFolder)).find(
    (name) => name.includes(".webgpu-") && name.endsWith(".onnx"),
  );
  if (!copy) throw new Error("The app's GPU copy isn't in the model cache yet.");
  const session = await createOrtSession(join(gpuFolder, copy), "gpu");
  const parts = new Map<
    number,
    {
      tokens: number[];
      tensors: number[];
      runs: number[];
      calls: number[];
      perThousand: number[];
      loads: string[];
      differ: number;
      maxDiff: number;
    }
  >();
  const asBatch8 = new Map<number, number[]>();
  for (let round = 0; round < rounds; round++) {
    const sizes = round % 2 === 0 ? [8, 16, 32, 64] : [64, 32, 16, 8];
    for (const size of sizes) {
      const entry = parts.get(size) ?? {
        tokens: [],
        tensors: [],
        runs: [],
        calls: [],
        perThousand: [],
        loads: [],
        differ: 0,
        maxDiff: 0,
      };
      parts.set(size, entry);
      entry.loads.push(load());
      const pairs = pairEncoder(tokenizer, maxTokens);
      for (const [index, { query, texts }] of searches.entries()) {
        const begun = performance.now();
        const read = texts.map((text, at) => ({ at, ids: pairs(normaliseText(query), text) }));
        read.sort((a, b) => a.ids.length - b.ids.length);
        const tokened = performance.now();
        let tensorMs = 0;
        let runMs = 0;
        let calls = 0;
        let padded = 0;
        const scores = new Array<number>(texts.length);
        for (let start = 0; start < read.length; start += size) {
          const t0 = performance.now();
          const batch = read.slice(start, start + size);
          const width = Math.max(...batch.map((pair) => pair.ids.length));
          const ids = new BigInt64Array(batch.length * width).fill(BigInt(padId));
          const mask = new BigInt64Array(batch.length * width);
          batch.forEach((pair, row) => {
            pair.ids.forEach((id, column) => {
              ids[row * width + column] = BigInt(id);
              mask[row * width + column] = 1n;
            });
          });
          const t1 = performance.now();
          const logits = await session.run(ids, mask, batch.length, width);
          const t2 = performance.now();
          tensorMs += t1 - t0;
          runMs += t2 - t1;
          calls++;
          padded += batch.length * width;
          batch.forEach((pair, row) => {
            scores[pair.at] = logits[row] ?? Number.NaN;
          });
        }
        entry.tokens.push(tokened - begun);
        entry.tensors.push(tensorMs);
        entry.runs.push(runMs);
        entry.calls.push(calls);
        entry.perThousand.push((runMs / padded) * 1000);
        if (size === 8 && !asBatch8.has(index)) asBatch8.set(index, scores);
        const eight = asBatch8.get(index);
        if (eight)
          scores.forEach((score, at) => {
            const other = eight[at] ?? Number.NaN;
            if (!Object.is(score, other)) entry.differ++;
            entry.maxDiff = Math.max(entry.maxDiff, Math.abs(score - other));
          });
      }
    }
  }
  await session.release();
  lines.push(
    "",
    "| Texts a GPU run holds | Tokens, a search | Tensors, a search | The model's runs, a search | Runs, a search | The model's runs, a thousand tokens with their padding | Scores unlike 8's | Largest difference, logits | Load at each |",
    "|--:|--:|--:|--:|--:|--:|--:|--:|---|",
    ...[...parts].map(
      ([size, each]) =>
        `| ${size} | ${ms(each.tokens)} | ${ms(each.tensors)} | ${ms(each.runs)} | ${median(each.calls)} | ${ms(each.perThousand)} | ${each.differ} | ${each.maxDiff.toFixed(4)} | ${each.loads.join(", ")} |`,
    ),
  );

  // The CPU, one search at a time.
  const cpu = createOnnxCrossEncoder();
  const onCpu = await cpu.load(cpuFiles);
  const cpuWork: number[] = [];
  const cpuLoads: string[] = [];
  for (let round = 0; round < rounds; round++) {
    cpuLoads.push(load());
    for (const { query, texts } of searches) {
      const started = performance.now();
      await cpu.score(normaliseText(query), texts);
      cpuWork.push(performance.now() - started);
    }
  }
  cpu.close();
  lines.push(
    "",
    `The ${onCpu.device}, one search at a time: ${ms(cpuWork)} a search; load ${cpuLoads.join(", ")}.`,
  );

  const report = ["# Where a rerank's time goes", "", ...lines].join("\n");
  console.log(report);
  const out = join(
    config.resultsDir,
    `rerank-wait-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.md"), report);
  await writeFile(
    join(out, "searches.json"),
    JSON.stringify(searches.map((each) => ({ query: each.query, texts: each.texts.length }))),
  );
  log(`Report in ${out}`);
});

type Read = { at: number; ids: number[] };

/** One search's pairs scored on `session` in GPU runs of `size`, in the order `arrange` puts them; each score back at its own text. */
async function scoreArranged(
  session: Awaited<ReturnType<typeof createOrtSession>>,
  pairs: readonly number[][],
  padId: number,
  size: number,
  arrange: (read: Read[]) => Read[],
) {
  const read = arrange(pairs.map((ids, at) => ({ at, ids })));
  const scores = new Array<number>(pairs.length);
  const batches: { real: number; padded: number }[] = [];
  let runMs = 0;
  for (let start = 0; start < read.length; start += size) {
    const batch = read.slice(start, start + size);
    const width = Math.max(...batch.map((pair) => pair.ids.length));
    const ids = new BigInt64Array(batch.length * width).fill(BigInt(padId));
    const mask = new BigInt64Array(batch.length * width);
    batch.forEach((pair, row) => {
      pair.ids.forEach((id, column) => {
        ids[row * width + column] = BigInt(id);
        mask[row * width + column] = 1n;
      });
    });
    const begun = performance.now();
    const logits = await session.run(ids, mask, batch.length, width);
    runMs += performance.now() - begun;
    batches.push({
      real: batch.reduce((total, pair) => total + pair.ids.length, 0),
      padded: batch.length * width,
    });
    batch.forEach((pair, row) => {
      scores[pair.at] = logits[row] ?? Number.NaN;
    });
  }
  return { scores, batches, runMs };
}

/** The texts' order by score, best first, ties in their own order, as `rerank` gives it. */
const orderOf = (scores: readonly number[]) =>
  scores
    .map((score, at) => ({ score, at }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((each) => each.at);

const share = (values: readonly number[]) =>
  values.length === 0
    ? "–"
    : `${median(values).toFixed(1)} (${Math.min(...values).toFixed(1)}–${Math.max(...values).toFixed(1)})`;

const padded = env("RERANK") === "padding" ? test : test.skip;

padded("how much of a search's GPU work is padding, and its texts longest first", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const rounds = Number(env("RUNS") ?? "3");
  const searches = await sampleSearches();
  const { gpu, folder, files: paths, maxTokens } = BUILT_IN_RERANKING_MODEL;
  if (!gpu) throw new Error("The built-in reranking model has no GPU file.");
  const models = join(config.cacheDir, "models");
  const { Tokenizer } = await TOKENIZERS.load();
  const tokenizerConfig = JSON.parse(
    await readFile(join(models, folder, paths.tokenizerConfig), "utf8"),
  );
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(join(models, folder, paths.tokenizer), "utf8")),
    tokenizerConfig,
  );
  const padId = tokenizer.token_to_id(tokenizerConfig.pad_token) ?? 1;
  const gpuFolder = join(models, gpu.folder, "onnx");
  const copy = (await readdir(gpuFolder)).find(
    (name) => name.includes(".webgpu-") && name.endsWith(".onnx"),
  );
  if (!copy) throw new Error("The app's GPU copy isn't in the model cache yet.");
  const session = await createOrtSession(join(gpuFolder, copy), "gpu");
  const encode = pairEncoder(tokenizer, maxTokens);
  const pairs = searches.map(({ query, texts }) =>
    texts.map((text) => encode(normaliseText(query), text)),
  );
  const arms = {
    "today: shortest first": (read: Read[]) =>
      [...read].sort((a, b) => a.ids.length - b.ids.length),
    "longest first": (read: Read[]) => [...read].sort((a, b) => b.ids.length - a.ids.length),
    "as found, unsorted": (read: Read[]) => read,
  };
  type Arm = keyof typeof arms;
  const names = Object.keys(arms) as Arm[];
  const work = new Map<Arm, number[]>();
  const padding = new Map<Arm, number[]>();
  const scored = new Map<Arm, number[][]>();
  const loads: string[] = [];
  for (let round = 0; round < rounds; round++) {
    loads.push(load());
    for (const arm of round % 2 === 0 ? names : [...names].reverse()) {
      const runs: number[][] = [];
      for (const each of pairs) {
        const { scores, batches, runMs } = await scoreArranged(session, each, padId, 8, arms[arm]);
        runs.push(scores);
        work.set(arm, [...(work.get(arm) ?? []), runMs]);
        padding.set(arm, [
          ...(padding.get(arm) ?? []),
          ...batches.map((batch) => ((batch.padded - batch.real) / batch.padded) * 100),
        ]);
      }
      if (!scored.has(arm)) scored.set(arm, runs);
    }
  }
  // The longest text alone: its tokens' share of the search's, its own run against the search's,
  // and the texts the model's limit already cuts.
  const longestTokens: number[] = [];
  const longestTime: number[] = [];
  let cut = 0;
  let texts = 0;
  for (const each of pairs) {
    const lengths = each.map((ids) => ids.length);
    const longest = Math.max(...lengths);
    cut += lengths.filter((length) => length >= maxTokens).length;
    texts += lengths.length;
    longestTokens.push((longest / lengths.reduce((total, length) => total + length, 0)) * 100);
    const whole = await scoreArranged(session, each, padId, 8, arms["today: shortest first"]);
    const alone = await scoreArranged(
      session,
      [each[lengths.indexOf(longest)] ?? []],
      padId,
      8,
      (read) => read,
    );
    longestTime.push((alone.runMs / whole.runMs) * 100);
  }
  await session.release();
  const today = scored.get("today: shortest first") ?? [];
  const gaps = today.map((scores) => {
    const sorted = [...scores].sort((a, b) => b - a);
    return Math.min(...sorted.slice(1).map((score, at) => (sorted[at] ?? 0) - score));
  });
  const lines = [
    `${searches.length} searches of ${median(searches.map((each) => each.texts.length))} texts at the median; GPU runs of 8 texts; ${rounds} rounds; load ${loads.join(", ")}`,
    "",
    "| Arm | The model's runs, a search, ms | Padding of a run's tokens, % | Searches in today's order | Largest score difference against today's, logits |",
    "|---|--:|--:|--:|--:|",
    ...names.map((arm) => {
      const runs = scored.get(arm) ?? [];
      const same = runs.filter(
        (scores, at) => orderOf(scores).join() === orderOf(today[at] ?? []).join(),
      ).length;
      const largest = Math.max(
        0,
        ...runs.flatMap((scores, at) =>
          scores.map((score, index) => Math.abs(score - (today[at]?.[index] ?? Number.NaN))),
        ),
      );
      return `| ${arm} | ${ms(work.get(arm) ?? [])} | ${share(padding.get(arm) ?? [])} | ${same} of ${runs.length} | ${largest.toFixed(4)} |`;
    }),
    "",
    `The closest two scores of a search in today's order, logits: ${share(gaps)}, median (range); a change under half a search's closest gap can't change its order.`,
    `The longest text: ${share(longestTokens)}% of its search's tokens; scored alone, ${share(longestTime)}% of the search's GPU time; ${cut} of ${texts} texts reach the model's ${maxTokens} tokens and are cut.`,
  ];
  const report = ["# How much of a search's GPU work is padding", "", ...lines].join("\n");
  console.log(report);
  const out = join(
    config.resultsDir,
    `rerank-padding-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.md"), report);
  log(`Report in ${out}`);
});
