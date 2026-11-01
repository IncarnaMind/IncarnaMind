/**
 * `npm run eval`: the retrieval and Citation evaluation (eval/README.md, #31).
 *
 * It drives the core's public interface in Node, as the desktop app's UI
 * would: a new temporary data folder, embeddings turned on (they are off by
 * default) so the evaluation set's Documents are also processed with the real
 * built-in embedding model (on a worker thread), then searches for each
 * Question: keyword search's top 20 reranked by the real built-in reranking
 * model, as the search Tool does by default, hybrid search's candidates
 * reranked as with embeddings on, other ways to find the candidates with
 * embeddings off (./lib/searches), and the plain search modes, reported only.
 * Then embeddings are turned off again, as Users have them, and the search
 * Tool itself is run for each Question: what it hands the model is the gate.
 * When a chat model is given, Answers and their Citations are scored.
 * Then the same for the every-format set (#70), on a library of its own,
 * reported per format and never gating.
 * It runs under Vitest only for its TypeScript and worker-thread handling
 * (eval/vitest.config.ts); `npm test` never runs it.
 */
import { arch, cpus, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  BUILT_IN_EMBEDDING_MODEL,
  BUILT_IN_RERANKING_MODEL,
  DATABASE_FILE,
  type RerankingModelDefinition,
} from "../src/core";
import { openDatabase } from "../src/core/storage";
import {
  type CitationRun,
  checkQuestionIds,
  evalOllamaModels,
  questionsToAsk,
  runCitations,
  summariseGroup,
} from "./lib/citations";
import { commitOf } from "./lib/commit";
import { type EvalConfig, readConfig } from "./lib/config";
import { cloudEmbeddingProvider, createWorkerEmbedder } from "./lib/embedder";
import { type EvalQuestion, FORMATS_SET, isGating, loadEvaluationSet } from "./lib/evaluationSet";
import { type FormatsReport, formatOf, summariseFormats } from "./lib/formats";
import { type Library, openLibrary } from "./lib/library";
import { createLog, type Log } from "./lib/log";
import { type OtherSearches, openOtherSearches } from "./lib/otherSearches";
import { type EvalReport, terminalSummary, writeReports } from "./lib/report";
import {
  createWorkerCrossEncoder,
  openReranker,
  prepareGpuFile,
  type RerankerInfo,
} from "./lib/rerank";
import {
  type CandidateSource,
  candidateCounts,
  GATING_LABEL,
  GATING_MODE,
  HYBRID,
  KEYWORD_RANK_DEPTH,
  OTHER_SEARCHES,
  RERANKED_SEARCHES,
  type RerankedSearch,
  type RetrievalMode,
  type RetrievalRun,
  rerankedLabel,
  rerankMode,
  retrievalFailures,
  runReranked,
  runRetrieval,
  SEARCH_DESCRIPTIONS,
  SEARCH_LABELS,
  summarise,
  TOOL_LABEL,
  TOOL_MODE,
  TOP_K,
} from "./lib/retrieval";
import { runSearchTool } from "./lib/searchToolScore";
import { answerOptionsOf } from "./lib/timing";

const root = fileURLToPath(new URL("..", import.meta.url));

async function retrieve(
  library: Library,
  embedding: string,
  gating: boolean,
  questions: Parameters<typeof runRetrieval>[1],
  log: Log,
  rerank: {
    candidates: readonly RerankingModelDefinition[];
    cacheDir: string;
    onCpu: boolean;
    /** The other ways to find candidates, run with the built-in reranking model. */
    others?: OtherSearches;
  } | null = null,
): Promise<RetrievalRun> {
  const ids = new Map([...library.documents].map(([key, document]) => [key, document.id]));
  const results = await runRetrieval(library.core, questions, ids);
  const line = (mode: RetrievalMode, label: string) => {
    const summary = summarise(results, [mode])[mode];
    if (!summary) return;
    const translated = summary.crossLingualTranslated;
    const paraphrase = summary.paraphrase.all;
    log(
      `${embedding}, ${label}: English ${summary.en.hits}/${summary.en.total}, Chinese ${summary.zh.hits}/${summary.zh.total}, cross-lingual ${summary.crossLingual.hits}/${summary.crossLingual.total}${translated ? ` (${translated.hits}/${translated.total} with a translated second query)` : ""}${paraphrase.total > 0 ? `, paraphrase ${paraphrase.hits}/${paraphrase.total}` : ""}`,
    );
  };
  line("keyword", "keyword");
  line(HYBRID, HYBRID);

  // Reranked modes, one model at a time: each is downloaded once into the model cache. Each
  // model reranks keyword search's top 20 (keyword + rerank, the Tool's order), then hybrid
  // search's candidates, opened afresh for each so the timings are the mode's own. The
  // built-in model then reranks the other searches' candidates, the Questions' own only.
  const rerankers: RerankerInfo[] = [];
  const rerankWith = async (
    candidate: RerankingModelDefinition,
    search: RerankedSearch,
    source?: CandidateSource,
  ) => {
    const mode = rerankMode(candidate, search);
    const label = rerankedLabel(search, candidate.name);
    log(`Reranking ${SEARCH_DESCRIPTIONS[search]} with ${candidate.name}`);
    const reranker = await openReranker(
      candidate,
      rerank?.cacheDir ?? "",
      log,
      mode,
      rerank?.onCpu,
    );
    try {
      const found = await runReranked(
        library.core,
        questions,
        ids,
        reranker,
        results,
        source ? { source, translated: false } : {},
      );
      const info = { ...reranker.info(), candidates: found };
      rerankers.push(info);
      line(mode, label);
      log(
        `${label}: per search, ${found.mean.toFixed(0)} ms to find the candidates and ${info.latency.mean.toFixed(0)} ms to rerank them on average (95th percentile ${found.p95.toFixed(0)} and ${info.latency.p95.toFixed(0)} ms); the model loaded in ${info.loadSeconds.toFixed(1)} s`,
      );
    } finally {
      reranker.close();
    }
  };
  for (const candidate of rerank?.candidates ?? []) {
    for (const search of RERANKED_SEARCHES) await rerankWith(candidate, search);
    const others = rerank?.others;
    if (!others || candidate.id !== BUILT_IN_RERANKING_MODEL.id) continue;
    for (const search of OTHER_SEARCHES) {
      const source = others.sources[search];
      if (source) await rerankWith(candidate, search, source);
      else log(`${SEARCH_LABELS[search]}: skipped, ${others.report.skipped[search] ?? ""}`);
    }
  }

  const candidates = [...RERANKED_SEARCHES, ...OTHER_SEARCHES].flatMap(
    (search) => candidateCounts(results, search) ?? [],
  );
  for (const counts of candidates) {
    const { gating: reached, paraphrase } = counts.reached;
    log(
      `${SEARCH_LABELS[counts.search]} + rerank searches had ${counts.mean.toFixed(1)} candidates on average (${counts.min} to ${counts.max}, over ${counts.searches} searches); they held the expected Passage for ${reached.hits}/${reached.total} gating and ${paraphrase.hits}/${paraphrase.total} paraphrase Questions`,
    );
  }
  // How deep the reranked order's misses are in plain keyword search: whether more candidates could reach them.
  for (const result of results) {
    const reranked = result.modes[GATING_MODE];
    if (!reranked || reranked.hit || result.keywordRank === undefined) continue;
    log(
      `${result.id}, missed by ${GATING_LABEL}: keyword search ranks its expected Passage ${result.keywordRank === null ? `below ${KEYWORD_RANK_DEPTH}` : `at ${result.keywordRank}`}`,
    );
  }

  return {
    embedding,
    gating,
    passageCount: library.passageCount,
    processingSeconds: library.processingSeconds,
    questions: results,
    summary: summarise(results),
    ...(rerankers.length > 0 && { rerankers }),
    ...(candidates.length > 0 && { candidates }),
    ...(rerank?.others && { otherSearches: rerank.others.report }),
  };
}

/**
 * Why a set's Questions aren't asked: no chat model, or none of them among
 * INCARNAMIND_EVAL_QUESTIONS. Null when some are asked.
 */
function notAsked(config: EvalConfig, questions: readonly EvalQuestion[]): string | null {
  if (!config.chat) {
    return "no chat model was given. Set INCARNAMIND_EVAL_CHAT_KIND, INCARNAMIND_EVAL_CHAT_MODEL and INCARNAMIND_EVAL_CHAT_KEY (eval/README.md).";
  }
  if (questionsToAsk(questions, config.questionIds).length === 0) {
    return "none of the Questions INCARNAMIND_EVAL_QUESTIONS names is in this set.";
  }
  return null;
}

/**
 * Turns embeddings off in a library before its Answers are asked, so they
 * search as Users' do by default: keyword search, reranked. The vectors made
 * for the hybrid and vector modes stay, unused.
 */
async function searchAsByDefault(library: Library, log: Log): Promise<void> {
  await library.core.saveEmbeddingProvider({ kind: "off" });
  log("Embeddings off for the Answers, as by default: keyword search, reranked");
}

/**
 * The every-format set (#70): its own library of Word, PowerPoint, Excel,
 * CSV, Markdown, text and PDF Documents, searched as the gating set is and,
 * with a chat model, each Question asked once. Reported per format; it never
 * gates, so its Citation targets aren't failures either.
 */
async function runFormats(config: EvalConfig, log: Log): Promise<FormatsReport> {
  const set = loadEvaluationSet(root, FORMATS_SET);
  log(`Every format: ${set.questions.length} Questions over ${set.documents.length} Documents`);
  const library = await openLibrary({
    name: "formats",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents: set.documents,
    keep: config.keepData,
    ...answerOptionsOf(config),
    log,
    // A scanned page has no text: the Questions about it are known gaps.
    allowUnprocessed: true,
  });
  try {
    const unprocessed = set.documents.filter(
      ({ key }) =>
        library.documents.get(key)?.status !== "ready" &&
        !set.questions.some((question) => question.expected.document === key && question.knownGap),
    );
    if (unprocessed.length > 0) {
      throw new Error(
        `Documents didn't process: ${unprocessed.map(({ path }) => path).join(", ")}`,
      );
    }
    const retrieval = await retrieve(
      library,
      `${BUILT_IN_EMBEDDING_MODEL.name} (built-in)`,
      false,
      set.questions,
      log,
      {
        candidates: [BUILT_IN_RERANKING_MODEL],
        cacheDir: config.cacheDir,
        onCpu: config.rerankOnCpu,
      },
    );
    const skipped = notAsked(config, set.questions);
    if (config.chat && !skipped) await searchAsByDefault(library, log);
    const citations: CitationRun | { skipped: string } =
      config.chat && !skipped
        ? {
            ...(await runCitations(
              library,
              set.questions,
              config.chat,
              { ...config, maxRounds: 1 },
              log,
              "Unit",
            )),
            failures: [],
          }
        : { skipped: skipped ?? "" };
    return {
      source: set.source,
      documents: set.documents.map(({ key, path, kind }) => {
        const document = library.documents.get(key);
        return {
          key,
          name: document?.name ?? key,
          format: formatOf(path, document?.kind ?? kind),
          status: document?.status ?? "failed",
        };
      }),
      retrieval,
      formats: summariseFormats(set, retrieval, citations),
      crossLingualCitations:
        "skipped" in citations
          ? null
          : summariseGroup(citations.answers.filter((answer) => answer.crossLingual)),
      citations,
    };
  } finally {
    await library.close();
  }
}

test("retrieval and Citation evaluation", async () => {
  const started = new Date();
  const log = createLog(started.getTime());
  const config = readConfig(root);
  const set = loadEvaluationSet(root);
  log(`${set.questions.length} Questions over ${set.documents.length} Documents`);
  if (config.questionIds) {
    checkQuestionIds(config.questionIds, [
      set.questions,
      ...(config.formats ? [loadEvaluationSet(root, FORMATS_SET).questions] : []),
    ]);
  }
  log(`Embedding model cache: ${config.cacheDir}`);
  await prepareGpuFile(config, log);

  // The core reranks Answers' searches with the built-in reranking model, as the app does by
  // default. The library turns embeddings on, for the hybrid and vector modes reported.
  const ollamaModels = evalOllamaModels(config.chat);
  const builtIn = await openLibrary({
    name: "built-in",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents: set.documents,
    ...(ollamaModels && { ollamaModels }),
    keep: config.keepData,
    ...answerOptionsOf(config),
    log,
  });
  let report: EvalReport;
  let others: OtherSearches | null = null;
  try {
    // The built-in reranking model gates; the other candidates given are compared with it.
    const rerankWith = [
      BUILT_IN_RERANKING_MODEL,
      ...config.rerank.filter((candidate) => candidate.id !== BUILT_IN_RERANKING_MODEL.id),
    ];
    // Other ways to find what the reranker sees, with embeddings off: reported, never gating.
    others = await openOtherSearches(
      builtIn,
      set.questions,
      {
        chat: config.chat,
        resultsDir: config.resultsDir,
        localQueryModes: config.localQueryModes,
      },
      log,
    );
    const runs = [
      await retrieve(
        builtIn,
        `${BUILT_IN_EMBEDDING_MODEL.name} (built-in)`,
        true,
        set.questions,
        log,
        { candidates: rerankWith, cacheDir: config.cacheDir, onCpu: config.rerankOnCpu, others },
      ),
    ];
    // The gate is the search Tool as Users have it, with embeddings off, and so are the Answers.
    await searchAsByDefault(builtIn, log);
    const [gated] = runs;
    if (gated) {
      const ids = new Map([...builtIn.documents].map(([key, document]) => [key, document.id]));
      const db = openDatabase(join(builtIn.dataDir, DATABASE_FILE));
      const reranker = await openReranker(
        BUILT_IN_RERANKING_MODEL,
        config.cacheDir,
        log,
        GATING_MODE,
        config.rerankOnCpu,
      );
      try {
        await runSearchTool(
          { core: builtIn.core, db, reranker },
          set.questions,
          ids,
          gated.questions,
        );
      } finally {
        reranker.close();
        db.close();
      }
      gated.summary = summarise(gated.questions);
      const tool = gated.summary[TOOL_MODE];
      log(
        `${TOOL_LABEL} (gating): English ${tool?.en.hits}/${tool?.en.total}, Chinese ${tool?.zh.hits}/${tool?.zh.total}`,
      );
    }

    const cloud = config.cloudEmbedding;
    if (cloud) {
      const library = await openLibrary({
        name: "cloud",
        embedder: createWorkerEmbedder(),
        embeddingProvider: cloudEmbeddingProvider(cloud),
        documents: set.documents,
        keep: config.keepData,
        log,
      });
      try {
        runs.push(
          await retrieve(library, `${cloud.kind}/${cloud.modelId}`, false, set.questions, log),
        );
      } finally {
        await library.close();
      }
    }

    const skipped = notAsked(config, set.questions);
    const citations: CitationRun | { skipped: string } =
      config.chat && !skipped
        ? await runCitations(builtIn, set.questions, config.chat, config, log)
        : { skipped: skipped ?? "" };

    const failures = [
      ...retrievalFailures(runs[0]?.summary[TOOL_MODE]),
      ...("skipped" in citations ? [] : citations.failures),
    ];
    const cpu = cpus();
    const gating = set.questions.filter(isGating);
    report = {
      result: failures.length === 0 ? "pass" : "fail",
      failures,
      run: {
        startedAt: started.toISOString(),
        seconds: (Date.now() - started.getTime()) / 1000,
        commit: commitOf(root),
        node: process.version,
        platform: `${platform()} ${arch()}`,
        cpu: `${cpu[0]?.model.trim() ?? "unknown CPU"} (${cpu.length} cores)`,
      },
      evaluationSet: {
        source: set.source,
        hitRule: set.hitRule,
        questions: {
          gating: {
            en: gating.filter((question) => question.language === "en").length,
            zh: gating.filter((question) => question.language === "zh").length,
          },
          crossLingual: set.questions.filter((question) => question.crossLingual).length,
          paraphrase: set.questions.filter((question) => question.paraphrase).length,
        },
      },
      documents: set.documents.map(({ key }) => {
        const document = builtIn.documents.get(key);
        return { key, name: document?.name ?? key, pageCount: document?.pageCount ?? null };
      }),
      retrieval: { topK: TOP_K, gatingMode: TOOL_MODE, runs },
      citations,
    };
  } finally {
    others?.close();
    await builtIn.close();
  }
  report.formats = config.formats
    ? await runFormats(config, log)
    : { skipped: "INCARNAMIND_EVAL_FORMATS is off." };
  report.run.seconds = (Date.now() - started.getTime()) / 1000;

  const dir = await writeReports(report, config.resultsDir, root);
  console.log(terminalSummary(report, dir, root));
  expect(report.failures, "The evaluation missed its targets (see the report).").toEqual([]);
});
