/**
 * `npm run eval:dump`: writes the dumps (eval/README.md, "Offline scoring") of
 * the gating set, the every-format set and the hard tier, one JSON file each,
 * with keyword search only: no embedding model runs, as in the app by
 * default, in one process. Each set is added to a new temporary data folder
 * (kept with INCARNAMIND_EVAL_KEEP_DATA=1), its Questions (only
 * INCARNAMIND_EVAL_QUESTIONS, if given) are searched, and the dump is scored
 * with eval/score.ts. The same Questions are also scored the way
 * `npm run eval` and `npm run eval:hard` score them, and the run fails if the
 * dump's top 5 for keyword search and for keyword + rerank differ from those.
 * It runs under Vitest only for its TypeScript and worker threads
 * (eval/dumps/vitest.config.ts); neither `npm test` nor `npm run eval` runs it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { BUILT_IN_RERANKING_MODEL, DATABASE_FILE } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { fetchLibrary } from "../hard/lib/fetch";
import { loadManifest } from "../hard/lib/manifest";
import { type HardQuestion, loadHardQuestions, textProblems } from "../hard/lib/questions";
import { rerankAll, searchAll, summariseHard } from "../hard/lib/scoring";
import { storedTextReader } from "../hard/lib/stored";
import { commitOf } from "../lib/commit";
import { type EvalConfig, readConfig } from "../lib/config";
import { buildDump, type DumpInput } from "../lib/dumps";
import { createWorkerEmbedder } from "../lib/embedder";
import {
  EVALUATION_SET,
  type EvalQuestion,
  FORMATS_SET,
  loadEvaluationSet,
} from "../lib/evaluationSet";
import { formatOf } from "../lib/formats";
import { openLibrary } from "../lib/library";
import { createLog, type Log } from "../lib/log";

import {
  createWorkerCrossEncoder,
  openReranker,
  prepareGpuFile,
  type ScoringReranker,
} from "../lib/rerank";
import {
  GATING_MODE,
  KEYWORD_RERANK_DEPTH,
  runReranked,
  runRetrieval,
  summarise,
  type Tally,
} from "../lib/retrieval";

import { type Dump, formatScore, type Order, type ScoreOptions, scoreDump } from "../score";

const root = fileURLToPath(new URL("../..", import.meta.url));

const ORDERS: readonly Order[] = [{ kind: "keyword" }, { kind: "rerank" }];
const TOPS = [5, 8, 10];

interface Context {
  config: EvalConfig;
  log: Log;
  reranker: ScoringReranker;
  commit: string;
  dir: string;
  /** Where the dump's top 5 differs from the run's own scoring. */
  differences: string[];
}

/** What a set's dump says at top 5 for keyword search and keyword + rerank, in the group of Questions the run scores. */
function dumpTop5(dump: Dump, group: { tag: string; value: string } | null) {
  const options: ScoreOptions = { depth: KEYWORD_RERANK_DEPTH, dropNeighbours: false };
  const score = scoreDump(dump, ORDERS, [5], options, group?.tag ?? dump.groupBy);
  const pick = (order: number): Tally => {
    const entry = score.orders[order]?.byTop[0];
    return (group ? entry?.groups[group.value] : entry?.all) ?? { hits: 0, total: 0 };
  };
  return { keyword: pick(0), rerank: pick(1) };
}

function compare(
  context: Context,
  label: string,
  dump: Dump,
  group: { tag: string; value: string } | null,
  run: { keyword: Tally; rerank: Tally },
): void {
  const found = dumpTop5(dump, group);
  for (const [name, mine, theirs] of [
    ["keyword", found.keyword, run.keyword],
    ["keyword + rerank", found.rerank, run.rerank],
  ] as const) {
    const same = mine.hits === theirs.hits && mine.total === theirs.total;
    context.log(
      `${label}, ${name}: dump ${mine.hits}/${mine.total}, run ${theirs.hits}/${theirs.total}${same ? "" : " (DIFFERENT)"}`,
    );
    if (!same) {
      context.differences.push(
        `${label}, ${name}: the dump says ${mine.hits}/${mine.total}, the run's scoring ${theirs.hits}/${theirs.total}`,
      );
    }
  }
}

async function write(context: Context, dump: Dump): Promise<void> {
  await mkdir(context.dir, { recursive: true });
  const file = join(context.dir, `${dump.set}.json`);
  await writeFile(file, JSON.stringify(dump));
  const options: ScoreOptions = { depth: KEYWORD_RERANK_DEPTH, dropNeighbours: false };
  console.log(`\n${formatScore(scoreDump(dump, ORDERS, TOPS, options), dump)}\nWrote ${file}\n`);
}

const subset = <Question extends { id: string }>(
  questions: readonly Question[],
  ids: readonly string[] | null,
) => (ids ? questions.filter((question) => ids.includes(question.id)) : [...questions]);

function inputOf(
  question: EvalQuestion,
  tags: Record<string, string>,
  ids: ReadonlyMap<string, string>,
): DumpInput {
  return {
    id: question.id,
    tags,
    expected: [question.expected],
    expectedDocumentIds: [ids.get(question.expected.document) ?? ""],
    queries: [question.question, ...(question.translatedQuery ? [question.translatedQuery] : [])],
  };
}

/** The gating set or the every-format set: its own library, its Questions dumped and scored as `npm run eval` scores them. */
async function dumpEvaluationSet(
  context: Context,
  name: "gating" | "formats",
  source: string,
  groupBy: string,
): Promise<void> {
  const { config, log } = context;
  const set = loadEvaluationSet(root, source);
  const questions = subset(set.questions, config.questionIds);
  if (questions.length === 0) {
    log(`${name}: none of INCARNAMIND_EVAL_QUESTIONS is in this set; skipped`);
    return;
  }
  log(`${name}: ${questions.length} Questions over ${set.documents.length} Documents`);
  const library = await openLibrary({
    name: `dump-${name}`,
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents: set.documents,
    keep: config.keepData,
    log,
    // A scanned page has no text: the Questions about it are known gaps.
    allowUnprocessed: name === "formats",
    embeddings: false,
  });
  const db = openDatabase(join(library.dataDir, DATABASE_FILE));
  try {
    const ids = new Map([...library.documents].map(([key, document]) => [key, document.id]));
    const documentOf = new Map(set.documents.map((document) => [document.key, document] as const));
    const kind = (question: EvalQuestion) =>
      question.crossLingual ? "cross-lingual" : question.paraphrase ? "paraphrase" : "gating";
    const dump = await buildDump(
      {
        set: name,
        groupBy,
        commit: context.commit,
        core: library.core,
        db,
        reranker: context.reranker,
        rerankerInfo: { id: BUILT_IN_RERANKING_MODEL.id, name: BUILT_IN_RERANKING_MODEL.name },
        log,
      },
      questions.map((question) =>
        inputOf(
          question,
          {
            kind: kind(question),
            language: question.language,
            ...(name === "formats" && {
              format: formatOf(
                documentOf.get(question.expected.document)?.path ?? "",
                documentOf.get(question.expected.document)?.kind,
              ),
            }),
          },
          ids,
        ),
      ),
    );
    const results = await runRetrieval(library.core, questions, ids, ["keyword"]);
    await runReranked(library.core, questions, ids, context.reranker, results);
    const summary = summarise(results, ["keyword", GATING_MODE]);
    compare(
      context,
      name,
      dump,
      { tag: "kind", value: "gating" },
      {
        keyword: summary.keyword?.core ?? { hits: 0, total: 0 },
        rerank: summary[GATING_MODE]?.core ?? { hits: 0, total: 0 },
      },
    );
    await write(context, dump);
  } finally {
    db.close();
    await library.close();
  }
}

/** The hard tier: its library from the cache (fetched if it isn't there), dumped and scored as `npm run eval:hard` scores it. */
async function dumpHard(context: Context): Promise<void> {
  const { config, log } = context;
  const manifest = loadManifest(root);
  const set = loadHardQuestions(root, manifest);
  const fetched = await fetchLibrary(manifest, { root, cacheDir: config.cacheDir, log });
  const available = fetched.documents.filter((document) => document.status === "ready");
  log(`hard: ${available.length} of ${manifest.documents.length} Documents in the cache`);
  const library = await openLibrary({
    name: "dump-hard",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents: available.map((document) => ({ key: document.key, path: document.path as string })),
    keep: config.keepData,
    log,
    allowUnprocessed: true,
    embeddings: false,
  });
  const db = openDatabase(join(library.dataDir, DATABASE_FILE));
  try {
    const ids = new Map([...library.documents].map(([key, document]) => [key, document.id]));
    const readyKeys = new Set(
      [...library.documents]
        .filter(([, document]) => document.status === "ready")
        .map(([key]) => key),
    );
    const stored = storedTextReader(db, ids, readyKeys);
    const scorable: HardQuestion[] = subset(set.questions, config.questionIds).filter(
      (question) =>
        question.expected.length > 0 && textProblems(question, stored, manifest).length === 0,
    );
    log(`hard: ${scorable.length} Questions to dump`);
    if (scorable.length === 0) return;
    const dump = await buildDump(
      {
        set: "hard",
        groupBy: "difficulty",
        commit: context.commit,
        core: library.core,
        db,
        reranker: context.reranker,
        rerankerInfo: { id: BUILT_IN_RERANKING_MODEL.id, name: BUILT_IN_RERANKING_MODEL.name },
        log,
      },
      scorable.map((question) => ({
        id: question.id,
        tags: {
          difficulty: question.difficulty,
          domain: question.domain,
          language: question.language,
        },
        expected: question.expected,
        expectedDocumentIds: question.expected.map((each) => ids.get(each.document) ?? ""),
        queries: [
          question.question,
          ...(question.translatedQuery ? [question.translatedQuery] : []),
        ],
      })),
    );
    const results = await searchAll(library.core, scorable, ids, ["keyword"]);
    await rerankAll(library.core, scorable, ids, context.reranker, results);
    const summary = summariseHard(results, ["keyword", GATING_MODE]);
    compare(context, "hard", dump, null, {
      keyword: summary.keyword?.all ?? { hits: 0, total: 0 },
      rerank: summary[GATING_MODE]?.all ?? { hits: 0, total: 0 },
    });
    await write(context, dump);
  } finally {
    db.close();
    await library.close();
  }
}

test("the dumps", async () => {
  const started = new Date();
  const log = createLog(started.getTime());
  const config = readConfig(root);
  if (config.questionIds) {
    const known = new Set([
      ...loadEvaluationSet(root, EVALUATION_SET).questions.map((question) => question.id),
      ...loadEvaluationSet(root, FORMATS_SET).questions.map((question) => question.id),
      ...loadHardQuestions(root, loadManifest(root)).questions.map((question) => question.id),
    ]);
    const unknown = config.questionIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `INCARNAMIND_EVAL_QUESTIONS names Questions in no set: ${unknown.join(", ")}.`,
      );
    }
  }
  await prepareGpuFile(config, log);
  const reranker = await openReranker(
    BUILT_IN_RERANKING_MODEL,
    config.cacheDir,
    log,
    GATING_MODE,
    config.rerankOnCpu,
  );
  const context: Context = {
    config,
    log,
    reranker,
    commit: commitOf(root),
    dir: join(config.resultsDir, `${started.toISOString().replace(/[:.]/g, "-")}-dumps`),
    differences: [],
  };
  try {
    if (config.dumpSets.includes("gating")) {
      await dumpEvaluationSet(context, "gating", EVALUATION_SET, "kind");
    }
    if (config.dumpSets.includes("formats")) {
      await dumpEvaluationSet(context, "formats", FORMATS_SET, "format");
    }
    if (config.dumpSets.includes("hard")) await dumpHard(context);
  } finally {
    reranker.close();
  }
  expect(context.differences, "The dumps differ from the run's own scoring.").toEqual([]);
});
