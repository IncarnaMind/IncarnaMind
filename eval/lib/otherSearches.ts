/**
 * The other ways to find candidates (`OTHER_SEARCHES` in ./retrieval), opened
 * on a library: its Passages read into memory (./corpus), small-to-big's
 * sub-chunk index (./subChunks) and, when a chat model is given, its queries
 * for each Question (./rewrites). Each search's candidates are built by
 * ./searches.
 */
import { type ChatSettings, chatProviderOf } from "./config";
import { createCorpus } from "./corpus";
import type { EvalQuestion } from "./evaluationSet";
import type { Library } from "./library";
import type { Log } from "./log";
import {
  type CandidateSource,
  compareAggregations,
  coreSource,
  OTHER_SEARCHES,
  type OtherSearchesReport,
  type RerankedSearch,
} from "./retrieval";
import { chatGenerate, type Generate, prepareQueries, QUERY_MODEL_SEARCHES } from "./rewrites";
import {
  documentFirstCandidates,
  feedbackCandidates,
  fusedQueriesCandidates,
  smallToBigCandidates,
} from "./searches";
import { buildSubChunkIndex } from "./subChunks";

export interface OtherSearches {
  /** Each search's candidates, for the searches that can run. */
  sources: Partial<Record<RerankedSearch, CandidateSource>>;
  /** What the report says about them besides their hits. */
  report: OtherSearchesReport;
  close(): void;
}

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

export async function openOtherSearches(
  library: Library,
  questions: readonly EvalQuestion[],
  options: {
    chat: ChatSettings | null;
    resultsDir: string;
    /** Run the chat-model modes with a local model too. */
    localQueryModes?: boolean;
    generate?: Generate;
  },
  log: Log,
): Promise<OtherSearches> {
  const { core } = library;
  const ids = new Map([...library.documents].map(([key, document]) => [key, document.id]));
  const corpus = createCorpus(library.passages());
  const subChunks = buildSubChunkIndex(corpus, (documentId) => library.pageTexts(documentId));
  const { stats } = subChunks;
  log(
    `Small-to-big: ${stats.subChunks} sub-chunks of ${stats.meanTokens.toFixed(0)} tokens on average (at most ${stats.maxTokens}), indexed in ${stats.buildSeconds.toFixed(1)} s, ${megabytes(stats.indexBytes)} against ${megabytes(stats.passageIndexBytes)} for the Passages' own index${stats.unplaced ? `; ${stats.unplaced} not placed in a Passage, left out` : ""}`,
  );

  const sources: Partial<Record<RerankedSearch, CandidateSource>> = {
    feedback: (query) => feedbackCandidates(core, corpus, query),
    "small-to-big": async (query) => smallToBigCandidates(subChunks, query),
    "document-first": (query) => documentFirstCandidates(core, corpus, query),
  };
  for (const search of OTHER_SEARCHES) {
    const source = coreSource(core, search);
    if (source) sources[search] = source;
  }

  const skipped: OtherSearchesReport["skipped"] = {};
  const queryModel: OtherSearchesReport["queryModel"] = [];
  const { chat } = options;
  // The rule runCitations gates on: a model that sends to no service runs on this computer.
  const local =
    chat !== null &&
    !options.localQueryModes &&
    (await core.saveChatProvider(chatProviderOf(chat))).service === null;
  for (const search of QUERY_MODEL_SEARCHES) {
    if (local && chat) {
      skipped[search] =
        `the chat model, \`${chat.kind}/${chat.modelId}\`, runs on this computer, and a call per Question is slow with a local model (INCARNAMIND_EVAL_LOCAL_QUERY_MODES=on runs it).`;
      continue;
    }
    if (!chat) {
      skipped[search] =
        "no chat model was given (INCARNAMIND_EVAL_CHAT_KIND, INCARNAMIND_EVAL_CHAT_MODEL and INCARNAMIND_EVAL_CHAT_KEY).";
      continue;
    }
    try {
      const { queries, cost } = await prepareQueries({
        search,
        model: `${chat.kind}/${chat.modelId}`,
        generate: options.generate ?? chatGenerate(chat),
        questions,
        documents: corpus.documents,
        resultsDir: options.resultsDir,
        log,
      });
      queryModel.push(cost);
      sources[search] = (query, question) =>
        fusedQueriesCandidates(core, query, queries.get(question.id) ?? []);
    } catch (error) {
      skipped[search] =
        `the chat model failed: ${error instanceof Error ? error.message : String(error)}`;
      log(`${search}: skipped, ${skipped[search]}`);
    }
  }

  return {
    sources,
    report: {
      skipped,
      smallToBig: { ...stats, aggregations: compareAggregations(subChunks, questions, ids) },
      queryModel,
    },
    close: () => subChunks.close(),
  };
}
