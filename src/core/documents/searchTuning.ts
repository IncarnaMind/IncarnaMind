import type { WindowedPassage } from "./search";
import type { Reranker, SearchToolOptions, SearchToolParameters } from "./searchTool";

/** One search an Answer made, as the evaluation watches it. Times are `performance.now()` milliseconds. */
export interface ObservedSearch {
  query: string;
  startedAt: number;
  endedAt: number;
  /** The reranker's own time within the search; null when it did not rerank. */
  rerankMs: number | null;
  /** The Passages handed to the model. */
  passages: readonly WindowedPassage[];
}

/**
 * How the evaluation (eval/README.md) tunes and watches the search Tool for
 * Answers' searches. The app passes none.
 */
export interface AnswerSearchTuning {
  /**
   * How many of keyword search's best the reranker sees, or "off" to leave
   * reranking out. It sets the candidates keyword search alone hands the
   * reranker, as with embeddings off; with them on, the Tool's own counts stand.
   */
  rerankDepth?: number | "off";
  /** How many Passages one search hands the model. */
  maxPassages?: number;
  observe?: (search: ObservedSearch) => void;
}

const PASSAGES_PER_WINDOW = 4;

/** Runs `search` with the tuning's counts, and reports it to `observe`. */
export async function tunedSearch(
  tuning: AnswerSearchTuning,
  query: string,
  options: SearchToolOptions,
  search: (options: SearchToolOptions) => Promise<WindowedPassage[]>,
): Promise<WindowedPassage[]> {
  const { rerankDepth, maxPassages, observe } = tuning;
  const parameters: Partial<SearchToolParameters> = {
    ...(typeof rerankDepth === "number" && { keywordRerankCandidates: rerankDepth }),
    ...(maxPassages !== undefined && {
      maxPassages,
      maxWindowsPerDocument: Math.max(2, Math.ceil(maxPassages / PASSAGES_PER_WINDOW)),
    }),
  };
  const reranker = rerankDepth === "off" ? undefined : options.rerank;
  let rerankMs: number | null = null;
  const timed: Reranker | undefined = reranker
    ? async (text, candidates, signal) => {
        const begun = performance.now();
        try {
          return await reranker(text, candidates, signal);
        } finally {
          rerankMs = (rerankMs ?? 0) + (performance.now() - begun);
        }
      }
    : undefined;
  const startedAt = performance.now();
  const passages = await search({
    ...options,
    parameters: { ...options.parameters, ...parameters },
    rerank: timed,
  });
  observe?.({ query, startedAt, endedAt: performance.now(), rerankMs, passages });
  return passages;
}
