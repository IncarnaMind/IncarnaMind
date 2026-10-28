/**
 * The hard tier's report: report.json (everything), report.md (for people)
 * and a summary on the terminal, in a folder of its own under eval/results/.
 * Retrieval per difficulty, domain and language in every mode, the library
 * and what indexing it cost, and, with a chat model, Citations per difficulty.
 * Nothing here gates.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CITATION_OUTCOMES, type CitationOutcome } from "../../lib/citations";
import { answersText, reviewerSheet } from "../../lib/report";
import type { RerankerInfo } from "../../lib/rerank";
import {
  GATING_MODE,
  HYBRID_RERANK_MODE,
  RANK_DEPTH,
  type RetrievalMode,
  rerankedLabel,
  rerankedSearchOf,
  TOP_K,
} from "../../lib/retrieval";
import { summariseTiming } from "../../lib/timing";
import { timingLine, timingSection } from "../../lib/timingReport";
import type { AnswerRuleResult, HardCitations } from "./citations";
import type { FetchStatus } from "./fetch";
import type { KeywordTiming, QueryTiming } from "./keywordTiming";
import {
  DOMAIN_LABELS,
  DOMAINS,
  type Domain,
  type HardFormat,
  type HardLanguage,
} from "./manifest";
import { DIFFICULTIES, type Difficulty } from "./questions";
import {
  HARD_MODES,
  type HardModeSummary,
  type HardQuestionResult,
  type HardTally,
  modeResult,
  SEARCHED_DIFFICULTIES,
  summariseHard,
} from "./scoring";

export interface HardReport {
  run: {
    startedAt: string;
    seconds: number;
    commit: string;
    node: string;
    platform: string;
    cpu: string;
    memoryBytes: number;
  };
  library: {
    manifest: string;
    /** Documents in the manifest, and what became of each that isn't searched. */
    documents: number;
    added: number;
    leftOut: { key: string; status: FetchStatus | "failed" | "no-text"; reason: string }[];
    /** What the manifest downloads in all, and what this run fetched (none when cached). */
    downloadBytes: number;
    fetchedBytes: number;
    fetchSeconds: number;
    /** Documents per domain, language and format, as added. */
    composition: {
      domain: Domain;
      language: HardLanguage;
      format: HardFormat;
      documents: number;
    }[];
    sources: { id: string; name: string; licence: string; terms: string; documents: number }[];
  };
  indexing: {
    passages: number;
    embeddedPassages: number;
    /**
     * The first pass, with embeddings off as by default: from adding the files
     * until every Document is ready (text extracted, Passages built, keyword
     * index written). What a User with embeddings off waits for.
     */
    keywordSeconds: number;
    /** The second pass: from turning embeddings on until every Passage has a vector. */
    embeddingSeconds: number;
    /** Time the embedding model itself spent embedding Passages, in the second pass. */
    embeddingModelSeconds: number;
    /**
     * The process's peak resident memory (worker threads included): after the
     * first pass, after the second, and over the whole run.
     */
    peakRssBytesKeyword: number;
    peakRssBytes: number;
    peakRssBytesRun: number;
  };
  questions: {
    source: string;
    total: number;
    /** Per difficulty and language. */
    counts: Partial<Record<Difficulty, Partial<Record<HardLanguage, number>>>>;
    /** Questions left out: their Document isn't in the library, or their quote isn't where expected. */
    leftOut: { id: string; reasons: string[] }[];
  };
  retrieval: {
    topK: number;
    modes: { mode: RetrievalMode; label: string }[];
    results: HardQuestionResult[];
    summary: Partial<Record<RetrievalMode, HardModeSummary>>;
    rerankers: RerankerInfo[];
    /** Keyword search's own time per query at this size, as the app runs it and without the name index. */
    keywordTiming: KeywordTiming | null;
  };
  citations: HardCitations | { skipped: string };
}

const fraction = ({ hits, total }: { hits: number; total: number }) =>
  total === 0 ? "–" : `${hits}/${total}`;
const percent = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(0)}%`);
const share = ({ hits, total }: { hits: number; total: number }) =>
  total === 0 ? "–" : `${fraction({ hits, total })} (${percent(hits / total)})`;
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy (the Documents' own words)",
  paraphrase: "Paraphrase",
  "table-number": "Table number",
  "multi-page": "Multi-page",
  "cross-document": "Cross-document",
  unanswerable: "Unanswerable",
  "cross-lingual": "Cross-lingual (with a translated second query)",
  "near-duplicate": "Near-duplicate",
  "false-premise": "False premise",
  disagreeing: "Disagreeing, newer and older",
};

const labelOf = (report: HardReport, mode: RetrievalMode) =>
  report.retrieval.modes.find((each) => each.mode === mode)?.label ?? mode;

/** The cross-lingual Questions scored on their own query alone, without the translation. */
export function ownQueryOnly(results: readonly HardQuestionResult[]): HardQuestionResult[] {
  return results
    .filter((result) => result.difficulty === "cross-lingual")
    .map((result) => ({
      ...result,
      modes: Object.fromEntries(
        Object.entries(result.modes).map(([mode, each]) => [mode, modeResult(each?.ranks ?? [])]),
      ),
    }));
}

function modesTable(
  report: HardReport,
  rows: readonly {
    label: string;
    tally: (summary: HardModeSummary, mode: RetrievalMode) => HardTally | undefined;
  }[],
): string[] {
  const modes = report.retrieval.modes.filter(({ mode }) => report.retrieval.summary[mode]);
  const lines = [
    `| | ${modes.map(({ label }) => label).join(" | ")} |`,
    `|---|${modes.map(() => "---|").join("")}`,
  ];
  for (const row of rows) {
    const cells = modes.map(({ mode }) => {
      const summary = report.retrieval.summary[mode];
      const tally = summary && row.tally(summary, mode);
      return tally ? share(tally) : "–";
    });
    if (cells.every((cell) => cell === "–")) continue;
    lines.push(`| ${row.label} | ${cells.join(" | ")} |`);
  }
  return lines;
}

function retrievalSection(report: HardReport): string[] {
  const { retrieval } = report;
  const own = summariseHard(ownQueryOnly(retrieval.results));
  const multi = SEARCHED_DIFFICULTIES.filter(
    (difficulty) => difficulty === "multi-page" || difficulty === "cross-document",
  );
  const lines = [
    "## Retrieval",
    "",
    `A Question is a hit when every Passage its answer needs is in the top ${retrieval.topK}, each meeting the gating set's hit rule (the expected Document, covering the expected pages, holding the expected quote). Unanswerable Questions have nothing to find and are scored by the Citation part. A cross-lingual Question is also searched with its translation into its Documents' language, written by hand, as an Answer is told to search again: a Passage either search finds counts. Embeddings are on for this run, so the dense modes can be compared: ${labelOf(report, GATING_MODE)} is what the search Tool does by default, with embeddings off, and ${labelOf(report, HYBRID_RERANK_MODE)} what it does with them on, the column to compare it with.`,
    "",
    "### By difficulty",
    "",
    ...modesTable(report, [
      ...SEARCHED_DIFFICULTIES.map((difficulty) => ({
        label: DIFFICULTY_LABELS[difficulty],
        tally: (summary: HardModeSummary) => summary.byDifficulty[difficulty],
      })),
      {
        label: "Cross-lingual, its own query only",
        tally: (_summary: HardModeSummary, mode: RetrievalMode) =>
          own[mode]?.byDifficulty["cross-lingual"],
      },
      { label: "**All**", tally: (summary: HardModeSummary) => summary.all },
    ]),
    "",
    `Partly found (some, not all, of the Passages needed in the top ${retrieval.topK}): ${multi
      .map((difficulty) => {
        const cells = retrieval.modes
          .map(({ mode, label }) => {
            const tally = retrieval.summary[mode]?.byDifficulty[difficulty];
            return tally ? `${label} ${tally.partial}` : null;
          })
          .filter(Boolean);
        return `${difficulty}: ${cells.join(", ")}`;
      })
      .join("; ")}.`,
    "",
    "### By domain",
    "",
    ...modesTable(
      report,
      DOMAINS.map((domain) => ({
        label: DOMAIN_LABELS[domain],
        tally: (summary: HardModeSummary) => summary.byDomain[domain],
      })),
    ),
    "",
    "### By language of the Question",
    "",
    ...modesTable(report, [
      { label: "English", tally: (summary: HardModeSummary) => summary.byLanguage.en },
      { label: "Chinese", tally: (summary: HardModeSummary) => summary.byLanguage.zh },
    ]),
    "",
    "### Domain × difficulty",
    "",
  ];
  for (const { mode, label } of retrieval.modes) {
    const summary = retrieval.summary[mode];
    if (!summary) continue;
    const domains = DOMAINS.filter((domain) => summary.byDomain[domain]);
    lines.push(
      `**${label}**`,
      "",
      `| | ${domains.map((domain) => DOMAIN_LABELS[domain]).join(" | ")} | All |`,
      `|---|${domains.map(() => "---|").join("")}---|`,
      ...SEARCHED_DIFFICULTIES.filter((difficulty) => summary.byDifficulty[difficulty]).map(
        (difficulty) =>
          `| ${difficulty} | ${domains
            .map((domain) => {
              const tally = summary.byDomainAndDifficulty[`${domain} ${difficulty}`];
              return tally ? fraction(tally) : "–";
            })
            .join(" | ")} | ${fraction(summary.byDifficulty[difficulty] as HardTally)} |`,
      ),
      `| **All** | ${domains.map((domain) => fraction(summary.byDomain[domain] as HardTally)).join(" | ")} | ${fraction(summary.all)} |`,
      "",
    );
  }
  lines.push(...searchTime(report));
  const rank = (value: number | null | undefined) =>
    value === null || value === undefined ? "–" : value <= TOP_K ? String(value) : `(${value})`;
  lines.push(
    "### Per Question",
    "",
    `The rank of each Passage the answer needs, in the order expected; a rank in brackets is a near miss (6 to ${RANK_DEPTH}), "–" none in the top ${RANK_DEPTH}. "a / b": the Question's own query, then its translation.`,
    "",
    `| Question | Difficulty | Domain | ${retrieval.modes.map(({ label }) => label).join(" | ")} | Text |`,
    `|---|---|---|${retrieval.modes.map(() => "---|").join("")}---|`,
    ...retrieval.results.map((result) => {
      const cells = retrieval.modes.map(({ mode }) => {
        const each = result.modes[mode];
        if (!each) return "–";
        const own = each.ranks.map(rank).join(", ");
        return each.translatedRanks ? `${own} / ${each.translatedRanks.map(rank).join(", ")}` : own;
      });
      return `| ${result.id} | ${result.difficulty} | ${result.domain} | ${cells.join(" | ")} | ${result.question.replace(/\|/g, "\\|")} |`;
    }),
    "",
  );
  return lines;
}

/** Keyword search's own time per query, beside the reranker's per search. */
function searchTime(report: HardReport): string[] {
  const { keywordTiming, rerankers } = report.retrieval;
  if (!keywordTiming && rerankers.length === 0) return [];
  const ms = (value: number) => `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ms`;
  const row = (label: string, timing: QueryTiming, extra = "") =>
    `| ${label} | ${ms(timing.median)} | ${ms(timing.p95)} | ${ms(timing.mean)} | ${ms(timing.max)} | ${extra} |`;
  return [
    "### Search time",
    "",
    ...(keywordTiming
      ? [
          `Keyword search alone, at ${keywordTiming.passages} Passages: the app's own (\`keywordSearch\`) keeping the best ${keywordTiming.limit}, over ${keywordTiming.app.queries} queries (the Questions and their translations), each timed once after a warm-up pass, and the same search over the Passages alone, so the Document's name index's cost is the difference. FTS5 scores every Passage a query's words match before keeping the best: it has no top-k pruning. The name match changed which Passages were kept, or their order, for ${keywordTiming.reordered} of ${keywordTiming.app.queries} queries.`,
          "",
        ]
      : []),
    "| Step | Median | 95th percentile | Mean | Slowest | |",
    "|---|---|---|---|---|---|",
    ...(keywordTiming
      ? [
          row("Keyword search (the app's, its Document's name match added)", keywordTiming.app),
          row("Keyword search over the Passages alone (no name index)", keywordTiming.alone),
        ]
      : []),
    ...rerankers.map((each) =>
      row(
        `Reranking for ${labelOf(report, each.mode as RetrievalMode)}`,
        each.latency,
        `loading ${each.loadSeconds.toFixed(1)} s`,
      ),
    ),
    "",
  ];
}

const OUTCOME_LABELS: Record<CitationOutcome, string> = {
  found: '"Quote found"',
  "false-not-found": 'False "not found"',
  "wrong-page": '"Not found": other pages',
  "not-in-document": '"Not found": not in the Document',
  "page-range": '"Not found": page-range rule',
  "cant-check": '"Can\'t check"',
};

function citationsSection(report: HardReport): string[] {
  const { citations } = report;
  if ("skipped" in citations) return ["## Citations", "", `Skipped: ${citations.skipped}`, ""];
  const columns = DIFFICULTIES.filter((difficulty) => citations.byDifficulty[difficulty]);
  const row = (label: string, cell: (difficulty: Difficulty) => string) =>
    `| ${label} | ${columns.map(cell).join(" | ")} |`;
  const of = (difficulty: Difficulty) => citations.byDifficulty[difficulty];
  const ofAnswers = (part: number, difficulty: Difficulty) =>
    `${part}/${of(difficulty)?.answers ?? 0} (${percent(part / Math.max(1, of(difficulty)?.answers ?? 0))})`;
  const unanswerable = of("unanswerable");
  return [
    "## Citations",
    "",
    `- Model: \`${citations.run.model}\`, ${citations.run.service ? `sent to ${citations.run.service}` : "on this computer"}. Each Question asked once, in a Mind of its own, with embeddings off as Users have them by default (keyword search, reranked). Reported, never gating.`,
    "- Figures as for the gating set (`eval/README.md`). \"Cites a Document it needs\": an Answer with a found Citation of an expected Document; for a near-duplicate Question, of the right version. For an unanswerable Question, what matters is whether the Answer says the Documents don't answer it: the share that declines, by a phrase rule in English and Chinese (`eval/lib/declines.ts`), with or without Citations. The reviewer sheet lists the Answers the rule did not take as declines, with a column to mark the ones it missed. Each Answer's text is in `answers.md`.",
    "",
    `| | ${columns.join(" | ")} |`,
    `|---|${columns.map(() => "---|").join("")}`,
    row("Answers (failed)", (d) => `${of(d)?.answers ?? 0} (${of(d)?.failedAnswers ?? 0})`),
    row("Citations", (d) => String(of(d)?.citations ?? 0)),
    ...CITATION_OUTCOMES.map((outcome) =>
      row(OUTCOME_LABELS[outcome], (d) => {
        const summary = of(d);
        return summary && summary.citations > 0
          ? `${summary.outcomes[outcome]} (${percent(summary.outcomes[outcome] / summary.citations)})`
          : "–";
      }),
    ),
    row("Sentences with a Citation", (d) => percent(of(d)?.coverage ?? null)),
    row("Cites a Document it needs", (d) =>
      d === "unanswerable" ? "–" : ofAnswers(of(d)?.citingExpected ?? 0, d),
    ),
    row("Cites another version (near-duplicate)", (d) =>
      d === "near-duplicate" ? ofAnswers(of(d)?.citingOtherVersion ?? 0, d) : "–",
    ),
    row("**Answered without a Citation**", (d) => ofAnswers(of(d)?.withoutCitation ?? 0, d)),
    row("**Declines, with or without Citations**", (d) =>
      d === "unanswerable" ? ofAnswers(of(d)?.declines ?? 0, d) : "–",
    ),
    row("**Premise flagged first**", (d) =>
      d === "false-premise" ? ofAnswers(of(d)?.premiseFlagged ?? 0, d) : "–",
    ),
    row("**Newer source leads**", (d) =>
      d === "disagreeing" ? ofAnswers(of(d)?.newerLeads ?? 0, d) : "–",
    ),
    row("Names the older one too", (d) =>
      d === "disagreeing" ? ofAnswers(of(d)?.namesOlder ?? 0, d) : "–",
    ),
    "",
    ...citedAfterCheckingSection(citations),
    ...answerRulesSection(citations),
    ...timingSection(
      columns.map((difficulty) => ({ label: difficulty, ...of(difficulty) })),
      "###",
    ),
    ...(unanswerable
      ? [
          "Unanswerable Questions whose Answer declines, by the rule:",
          "",
          ...(
            [
              ["English", unanswerable.declinesByLanguage.en],
              ["Chinese", unanswerable.declinesByLanguage.zh],
            ] as const
          ).map(
            ([label, each]) => `- ${label}: ${share({ hits: each.declines, total: each.answers })}`,
          ),
          "",
        ]
      : []),
  ];
}

/** What #760's check of sentences written without markers did, over the finished Answers. */
export function citedAfterCheckingCounts(citations: HardCitations) {
  const finished = (citations.run.answers ?? []).filter((answer) => answer.status === "done");
  const added = (answer: (typeof finished)[number]) => answer.citedAfterChecking?.count ?? 0;
  const noneOwn = finished.filter((answer) => answer.citations.length - added(answer) === 0);
  return {
    answers: finished.length,
    /** No Citation of the model's own: what the Answer was before #760. */
    noneOwn: noneOwn.length,
    /** Of those, Answers quoting text in quotation marks. */
    noneOwnQuoting: noneOwn.filter((answer) => /["“「『][^"”」』\n]{8,}["”」』]/u.test(answer.text))
      .length,
    /** No Citation even after the check. */
    stillNone: finished.filter((answer) => answer.citations.length === 0).length,
    added: finished.reduce((sum, answer) => sum + added(answer), 0),
    asked: finished.filter((answer) => answer.citedAfterChecking?.asked).length,
  };
}

function citedAfterCheckingSection(citations: HardCitations): string[] {
  const counts = citedAfterCheckingCounts(citations);
  if (counts.answers === 0) return [];
  return [
    "Sentences written without markers (#760): finished Answers with no Citation of the model's own (of them, quoting in quotation marks), with none even after the check matched their sentences to the Passages read, the Citations it added, and the Answers that asked the model once more.",
    "",
    "| Answers | No Citation of its own (quoting) | None after the check | Citations added | Asked once more |",
    "|---|---|---|---|---|",
    `| ${counts.answers} | ${counts.noneOwn} (${counts.noneOwnQuoting}) | ${counts.stillNone} | ${counts.added} | ${counts.asked} |`,
    "",
  ];
}

/**
 * Each false-premise and disagreeing Answer, with what the Answer rules found
 * and how it opens, for a reviewer to check the rules against (#548).
 */
function answerRulesSection(citations: HardCitations): string[] {
  if (citations.rules.length === 0) return [];
  const found = (rule: AnswerRuleResult) =>
    rule.difficulty === "false-premise"
      ? rule.followed
        ? "flagged"
        : "not flagged"
      : `${rule.followed ? "newer leads" : "newer doesn't lead"}${rule.namesOlder ? ", names the older" : ""}`;
  return [
    "The Answer rules (#548), Answer by Answer: a premise the Documents don't support is said so in the Answer's first paragraph (a phrase rule in English and Chinese); when two Documents disagree, what the newer one says comes first, and the Answer cites it. Each Answer's text is in `answers.md`.",
    "",
    "| Question | The rule found | How the Answer opens |",
    "|---|---|---|",
    ...citations.rules.map(
      (rule) =>
        `| ${rule.questionId} | ${found(rule)} | ${rule.opening.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 200)} |`,
    ),
    "",
  ];
}

export function markdownReport(report: HardReport): string {
  const { run, library, indexing, questions } = report;
  const domainRows = DOMAINS.map((domain) => {
    const of = (language: HardLanguage) =>
      library.composition
        .filter((row) => row.domain === domain && row.language === language)
        .reduce((sum, row) => sum + row.documents, 0);
    const formats = [
      ...new Set(
        library.composition.filter((row) => row.domain === domain).map((row) => row.format),
      ),
    ];
    return `| ${DOMAIN_LABELS[domain]} | ${of("en")} | ${of("zh")} | ${formats.join(", ")} |`;
  });
  const lines = [
    "# IncarnaMind evaluation: the hard tier",
    "",
    "Reported, never gating (`eval/hard/README.md`).",
    "",
    `- Run: ${run.startedAt}, ${(run.seconds / 60).toFixed(0)} min, commit ${run.commit}`,
    `- Machine: ${run.platform}, ${run.cpu}, ${gb(run.memoryBytes)} of memory, Node ${run.node}`,
    "",
    "## Library",
    "",
    `\`${library.manifest}\`: ${library.documents} Documents, ${library.added} added. The manifest downloads ${gb(library.downloadBytes)} in all; this run fetched ${mb(library.fetchedBytes)} in ${library.fetchSeconds.toFixed(0)} s.`,
    "",
    "| Domain | English | Chinese | Formats |",
    "|---|---|---|---|",
    ...domainRows,
    "",
    "| Source | Licence or terms | Documents |",
    "|---|---|---|",
    ...library.sources.map(
      (source) => `| ${source.name} | [${source.licence}](${source.terms}) | ${source.documents} |`,
    ),
    "",
    ...(library.leftOut.length
      ? [
          "Left out:",
          "",
          ...library.leftOut.map((each) => `- ${each.key} (${each.status}): ${each.reason}`),
          "",
        ]
      : []),
    "## Indexing",
    "",
    `- ${indexing.passages} Passages, ${indexing.embeddedPassages} of them embedded.`,
    "- Indexed in two passes: first with embeddings off, as the app does by default, then with them turned on, as a User does in Settings.",
    `- **With embeddings off,** every Document was ready after ${indexing.keywordSeconds.toFixed(0)} s: text extracted, Passages built and keyword-indexed. This is what a User with embeddings off waits for.`,
    `- **Turning embeddings on** then took ${indexing.embeddingSeconds.toFixed(0)} s until every Passage had a vector, ${indexing.embeddingModelSeconds.toFixed(0)} s of it in the embedding model${indexing.embeddingModelSeconds > 0 ? ` (${(indexing.embeddedPassages / indexing.embeddingModelSeconds).toFixed(1)} Passages a second)` : ""}. With embeddings on from the start, a User waits for both.`,
    `- Peak memory (resident, worker threads included): ${gb(indexing.peakRssBytesKeyword)} with embeddings off, ${gb(indexing.peakRssBytes)} once embedded, ${gb(indexing.peakRssBytesRun)} over the run.`,
    "",
    "## Questions",
    "",
    `\`${questions.source}\`: ${questions.total} Questions.`,
    "",
    "| Difficulty | English | Chinese |",
    "|---|---|---|",
    ...DIFFICULTIES.map(
      (difficulty) =>
        `| ${difficulty} | ${questions.counts[difficulty]?.en ?? 0} | ${questions.counts[difficulty]?.zh ?? 0} |`,
    ),
    "",
    ...(questions.leftOut.length
      ? [
          "Left out, not scored:",
          "",
          ...questions.leftOut.map((each) => `- ${each.id}: ${each.reasons.join(" ")}`),
          "",
        ]
      : []),
    ...retrievalSection(report),
    ...citationsSection(report),
  ];
  return lines.join("\n");
}

/** The summary printed at the end of a run. */
export function hardSummary(report: HardReport, reportDir: string, root: string): string {
  const { retrieval } = report;
  const modes = retrieval.modes.filter(({ mode }) => retrieval.summary[mode]);
  const width = Math.max(...SEARCHED_DIFFICULTIES.map((each) => each.length), 4) + 2;
  const lines = [
    "",
    `Hard tier, top ${retrieval.topK}: hits per difficulty (reported, never gating)`,
    `  ${"".padEnd(width)}${modes.map(({ label }) => label.padEnd(26)).join("")}`,
  ];
  for (const difficulty of [...SEARCHED_DIFFICULTIES, "all"] as const) {
    const cells = modes.map(({ mode }) => {
      const summary = retrieval.summary[mode];
      const tally = difficulty === "all" ? summary?.all : summary?.byDifficulty[difficulty];
      return (tally ? share(tally) : "–").padEnd(26);
    });
    lines.push(`  ${difficulty.padEnd(width)}${cells.join("")}`);
  }
  const { indexing } = report;
  lines.push(
    "",
    `  ${report.library.added} Documents, ${indexing.passages} Passages; ready with embeddings off after ${indexing.keywordSeconds.toFixed(0)} s, embedding took ${indexing.embeddingSeconds.toFixed(0)} s more; peak memory ${gb(indexing.peakRssBytesRun)}`,
  );
  const { citations } = report;
  if (!("skipped" in citations)) {
    const unanswerable = citations.byDifficulty.unanswerable;
    const premise = citations.byDifficulty["false-premise"];
    const disagreeing = citations.byDifficulty.disagreeing;
    const timing = timingLine(summariseTiming(citations.run.answers));
    if (timing) lines.push(`  Time (${citations.run.model}): ${timing}`);
    lines.push(
      `  Citations (${citations.run.model}): ${DIFFICULTIES.filter((d) => citations.byDifficulty[d])
        .map((d) => `${d} found ${percent(citations.byDifficulty[d]?.foundShare ?? null)}`)
        .join(
          ", ",
        )}${unanswerable ? `; unanswerable: ${unanswerable.declines}/${unanswerable.answers} decline, ${unanswerable.withoutCitation}/${unanswerable.answers} answered without a Citation` : ""}`,
    );
    const checked = citedAfterCheckingCounts(citations);
    lines.push(
      `  Without markers (${citations.run.model}): ${checked.noneOwn}/${checked.answers} Answers had no Citation of their own (${checked.noneOwnQuoting} quoting), ${checked.stillNone} after the check; ${checked.added} Citations added, ${checked.asked} asked once more`,
    );
    if (premise || disagreeing) {
      lines.push(
        `  Answer rules (${citations.run.model}): ${[
          premise && `premise flagged first ${premise.premiseFlagged}/${premise.answers}`,
          disagreeing &&
            `newer source leads ${disagreeing.newerLeads}/${disagreeing.answers} (names the older ${disagreeing.namesOlder})`,
        ]
          .filter(Boolean)
          .join("; ")}`,
      );
    }
  }
  lines.push(`Reports: ${relative(root, reportDir)}/`, "");
  return lines.join("\n");
}

/** Writes the reports into a new folder and returns its path. */
export async function writeHardReports(report: HardReport, resultsDir: string): Promise<string> {
  const dir = join(resultsDir, `${report.run.startedAt.replace(/[:.]/g, "-")}-hard`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, "report.md"), markdownReport(report));
  if (!("skipped" in report.citations)) {
    await writeFile(join(dir, "reviewer-sheet.csv"), reviewerSheet(report.citations.run));
    await writeFile(join(dir, "answers.md"), answersText(report.citations.run));
  }
  return dir;
}

/** The hard tier's modes, labelled as people read them: "keyword top 60 + <reranking model>". */
export const modeLabels = (rerankingModel: string) =>
  HARD_MODES.map((mode) => {
    const search = rerankedSearchOf(mode);
    return { mode, label: search ? rerankedLabel(search, rerankingModel) : mode };
  });
