/**
 * `INCARNAMIND_EVAL_SPEED_RERANK=1 npm run eval:speed` (README.md › The reranker's throughput):
 * the built-in reranker on this computer, scoring the searches Check this Note makes for its ten
 * sentences over the mixed sample set, in English and Chinese, as its GPU file was downloaded and
 * as the app opens it now, with the copies between host and GPU memory read as Identity
 * (src/core/reranking/hostCopies.ts). The two take turns, `RUNS` times each (5 by default).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { CrossEncoder, RerankingModelFiles } from "../../src/core/adapters";
import { BUILT_IN_RERANKING_MODEL } from "../../src/core/reranking/model";
import { createOnnxCrossEncoder, createOrtSession } from "../../src/core/reranking/onnx";
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
const AT_ONCE = 12;

interface Search {
  query: string;
  texts: string[];
}

/** The searches a check makes for each of the Note's ten sentences: the queries and the texts its reranker is given. */
async function noteSearches(): Promise<Search[]> {
  const log = createLog();
  const config = readConfig(ROOT);
  const searches: Search[] = [];
  for (const { language, sets } of LANGUAGES) {
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-rerank-throughput-"));
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
      name: "rerank-throughput",
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
      for (const { text } of sentences.slice(0, 10)) await library.core.searchEvidence(text);
    } finally {
      await library.close();
      await rm(folder, { recursive: true, force: true });
    }
  }
  return searches;
}

const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const range = (values: readonly number[]) =>
  `${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))}`;

const timedThroughput = env("RERANK") === "1" ? test : test.skip;

timedThroughput(
  "the built-in reranker's throughput, with and without its GPU file's host copies",
  async () => {
    const log = createLog();
    const config = readConfig(ROOT);
    const searches = await noteSearches();
    const runs = Number(env("RUNS") ?? "5");
    const { gpu, folder, files: paths, maxTokens } = BUILT_IN_RERANKING_MODEL;
    if (!gpu) throw new Error("The built-in reranking model has no GPU file.");
    const models = join(config.cacheDir, "models");
    const files: RerankingModelFiles = {
      model: join(models, folder, paths.model),
      tokenizer: join(models, folder, paths.tokenizer),
      tokenizerConfig: join(models, folder, paths.tokenizerConfig),
      maxTokens,
      gpu: { model: join(models, gpu.folder, gpu.file.path), check: gpu.check },
    };
    const arms = {
      "as downloaded": () => createOnnxCrossEncoder({ createSession: createOrtSession }),
      "host copies as Identity": () => createOnnxCrossEncoder(),
    };
    type Arm = keyof typeof arms;
    const times = new Map<Arm, { load: number[]; oneByOne: number[]; atOnce: number[] }>();
    const scores = new Map<Arm, number[][]>();
    for (let run = 0; run < runs; run++) {
      const order = Object.keys(arms) as Arm[];
      for (const arm of run % 2 === 0 ? order : order.reverse()) {
        const crossEncoder = arms[arm]();
        const begun = performance.now();
        const device = await crossEncoder.load(files);
        if (device.device !== "gpu")
          throw new Error(`The reranker loaded on the ${device.device}.`);
        const loaded = performance.now();
        const scored: number[][] = [];
        for (const { query, texts } of searches)
          scored.push(await crossEncoder.score(query, texts));
        const oneByOne = performance.now();
        await Promise.all(
          searches.slice(0, AT_ONCE).map(({ query, texts }) => crossEncoder.score(query, texts)),
        );
        const atOnce = performance.now();
        crossEncoder.close();
        const entry = times.get(arm) ?? { load: [], oneByOne: [], atOnce: [] };
        times.set(arm, entry);
        entry.load.push(loaded - begun);
        entry.oneByOne.push(oneByOne - loaded);
        entry.atOnce.push(atOnce - oneByOne);
        const first = scores.get(arm);
        if (!first) scores.set(arm, scored);
        else if (scored.flat().some((score, at) => !Object.is(score, first.flat()[at])))
          throw new Error(`${arm} scored differently in run ${run + 1} than in its first.`);
        log(
          `${arm}, run ${run + 1}: ${Math.round(oneByOne - loaded)} ms one by one, ${Math.round(atOnce - oneByOne)} ms twelve at once`,
        );
      }
    }
    const downloaded = scores.get("as downloaded")?.flat() ?? [];
    const identity = scores.get("host copies as Identity")?.flat() ?? [];
    const differing = identity.filter((score, at) => !Object.is(score, downloaded[at])).length;
    const rows = [...times].map(
      ([arm, each]) =>
        `| ${arm} | ${Math.round(median(each.load))} (${range(each.load)}) | ${Math.round(median(each.oneByOne))} (${range(each.oneByOne)}) | ${Math.round(median(each.atOnce))} (${range(each.atOnce)}) |`,
    );
    const report = [
      "# The built-in reranker's throughput",
      "",
      `${new Date().toISOString()} · ${searches.length} searches of ${searches.map((each) => each.texts.length).join(", ")} Passages · ${runs} runs an arm, taking turns · milliseconds, median (range)`,
      "",
      `| Arm | Load | ${searches.length} searches one by one | The first ${AT_ONCE} at once |`,
      "|---|--:|--:|--:|",
      ...rows,
      "",
      `Scores that differ between the arms: ${differing} of ${identity.length}.`,
    ].join("\n");
    console.log(report);
    const out = join(
      config.resultsDir,
      `rerank-throughput-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "report.md"), report);
    log(`Report in ${out}`);
  },
);
