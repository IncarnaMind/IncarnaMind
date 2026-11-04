/**
 * The evaluation's outputs: report.json (everything), report.md (for people),
 * reviewer-sheet.csv (found quotes, for judging whether they support their
 * sentence; reviewer-sheet-formats.csv for the every-format set's), and a
 * summary on the terminal.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { BUILT_IN_RERANKING_MODEL, type SearchMode } from "../../src/core";
import { SEARCH_TOOL_PARAMETERS } from "../../src/core/documents/searchTool";
import {
  CITATION_OUTCOMES,
  CITATION_TARGETS,
  type CitationGroup,
  type CitationOutcome,
  type CitationRun,
  type GroupSummary,
  pagesLabel,
  quoteRetryLine,
  rejectedLine,
  shortQuote,
} from "./citations";
import type { FormatsReport } from "./formats";
import {
  type CandidateCounts,
  GATING_LABEL,
  GATING_MODE,
  GATING_SEARCH,
  HYBRID,
  HYBRID_RERANK_LABEL,
  HYBRID_RERANK_MODE,
  KEYWORD_RANK_DEPTH,
  KEYWORD_RERANK_DEPTH,
  type LanguageTallies,
  type ModeResult,
  type ModeSummary,
  OTHER_SEARCHES,
  type QuestionResult,
  RANK_DEPTH,
  RERANK_PER_LIST,
  type RerankedSearch,
  type RetrievalMode,
  type RetrievalRun,
  rerankedLabel,
  rerankedSearchOf,
  rerankMode,
  SEARCH_DESCRIPTIONS,
  SEARCH_LABELS,
  SEARCH_MODES,
  type Tally,
  TOOL_LABEL,
  TOOL_MODE,
} from "./retrieval";
import type { Aggregation } from "./subChunks";
import { timingLine, timingSection } from "./timingReport";

export interface EvalReport {
  result: "pass" | "fail";
  /** Every target missed. */
  failures: string[];
  run: {
    startedAt: string;
    seconds: number;
    commit: string;
    node: string;
    platform: string;
    cpu: string;
  };
  evaluationSet: {
    source: string;
    hitRule: string;
    questions: { gating: { en: number; zh: number }; crossLingual: number; paraphrase: number };
  };
  documents: { key: string; name: string; pageCount: number | null }[];
  retrieval: {
    topK: number;
    gatingMode: RetrievalMode;
    /** The built-in model first; then a cloud model, when one was given. */
    runs: RetrievalRun[];
  };
  citations: CitationRun | { skipped: string };
  /** The every-format set (#70): reported per format, never gating; or why it didn't run. */
  formats?: FormatsReport | { skipped: string };
}

const fraction = ({ hits, total }: Tally) => `${hits}/${total}`;
const percent = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(1)}%`);
const seconds = (value: number | null) => (value === null ? "–" : `${value.toFixed(1)} s`);
const pages = (from: number | null, to: number | null) =>
  from === null ? "" : to !== null && to !== from ? `${from}–${to}` : `${from}`;

const GROUPS: readonly [CitationGroup, string][] = [
  ["en", "English"],
  ["zh", "Chinese"],
  ["crossLingual", "Cross-lingual"],
  ["paraphrase", "Paraphrase"],
];

const OUTCOME_LABELS: Record<CitationOutcome, string> = {
  found: '"Quote found"',
  "false-not-found": 'False "not found" (quote on the cited pages)',
  "wrong-page": '"Not found": quote on other pages',
  "not-in-document": '"Not found": quote not in the Document',
  "page-range": '"Not found": breaks the page-range rule',
  "cant-check": '"Can\'t check"',
};

/** A run's modes as the report lists them: the core's search modes, then the reranked ones. */
const modesIn = (run: RetrievalRun): RetrievalMode[] =>
  (Object.keys(run.summary) as RetrievalMode[]).sort(
    (a, b) =>
      (SEARCH_MODES.indexOf(a as SearchMode) + 1 || 99) -
      (SEARCH_MODES.indexOf(b as SearchMode) + 1 || 99),
  );

/** "hybrid", or "hybrid + <reranking model>" or "keyword + <reranking model>" for a reranked mode. */
function modeLabel(run: RetrievalRun, mode: RetrievalMode): string {
  const reranker = run.rerankers?.find((each) => each.mode === mode);
  const search = rerankedSearchOf(mode);
  if (reranker && search) return rerankedLabel(search, reranker.name);
  if (mode === TOOL_MODE) return TOOL_LABEL;
  if (mode === GATING_MODE) return GATING_LABEL;
  return mode === HYBRID_RERANK_MODE ? HYBRID_RERANK_LABEL : mode;
}

/** A group's hits in both languages, then each: "9/15 (5 + 4)"; "–" for a group with no Questions. */
const bothLanguages = ({ all, en, zh }: LanguageTallies) =>
  all.total === 0 ? "–" : `${fraction(all)} (${en.hits} + ${zh.hits})`;

function retrievalTable(runs: readonly RetrievalRun[]): string[] {
  const lines = [
    "| Embedding model | Mode | English | Chinese | Gating set | Cross-lingual | Cross-lingual, with a translated second query | Paraphrase (English + Chinese) |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const run of runs) {
    for (const mode of modesIn(run)) {
      const summary = run.summary[mode] as ModeSummary | undefined;
      if (!summary) continue;
      const gating = run.gating && mode === TOOL_MODE;
      const label = gating ? `**${modeLabel(run, mode)} (gating)**` : modeLabel(run, mode);
      const translated = summary.crossLingualTranslated;
      const cell = (tally: Tally) => (gating ? `**${fraction(tally)}**` : fraction(tally));
      lines.push(
        `| ${run.embedding} | ${label} | ${cell(summary.en)} | ${cell(summary.zh)} | ${cell(summary.core)} | ${fraction(summary.crossLingual)} | ${translated ? fraction(translated) : "–"} | ${bothLanguages(summary.paraphrase)} |`,
      );
    }
  }
  return lines;
}

/**
 * How many Passages a reranked search handed a reranker per search, and how
 * often they held the expected Passage at all.
 */
export const candidatesLine = (counts: CandidateCounts) =>
  `Candidates per ${SEARCH_LABELS[counts.search]} + rerank search (${SEARCH_DESCRIPTIONS[counts.search]}): ${counts.mean.toFixed(1)} on average, from ${counts.min} to ${counts.max}, over ${counts.searches} searches; the expected Passage among them for ${fraction(counts.reached.gating)} gating and ${fraction(counts.reached.paraphrase)} paraphrase Questions.`;

/** A run's candidate counts, the Tool's (keyword + rerank) first. */
const candidateCountsOf = (run: RetrievalRun): CandidateCounts[] => run.candidates ?? [];

const ms = (value: number) => `${value.toFixed(0)} ms`;

/**
 * What each reranking candidate costs in each reranked mode: its download,
 * the time to find a search's candidates, and the time it adds to rerank them.
 */
function rerankerTable(run: RetrievalRun): string[] {
  if (!run.rerankers?.length) return [];
  return [
    "| Reranked mode | Licence | Download | Finding the candidates: mean | Reranking: mean | median | 95th percentile | slowest | Loading |",
    "|---|---|---|---|---|---|---|---|---|",
    ...run.rerankers.map(
      (each) =>
        `| ${modeLabel(run, each.mode as RetrievalMode)} | ${each.licence} | ${(each.downloadBytes / 1e6).toFixed(0)} MB | ${each.candidates ? ms(each.candidates.mean) : "–"} | ${ms(each.latency.mean)} | ${ms(each.latency.median)} | ${ms(each.latency.p95)} | ${ms(each.latency.max)} | ${each.loadSeconds.toFixed(1)} s |`,
    ),
  ];
}

const AGGREGATION_LABELS: Record<Aggregation, string> = {
  best: "their best sub-chunk's score (the mode's)",
  sum: "the sum of their sub-chunks' scores",
};

/** What `QuestionResult.queries` holds for each search, as the report names it. */
const QUERY_LABELS: Partial<Record<RerankedSearch, string>> = {
  feedback: "feedback terms",
  rewrites: "rewrites",
  "sub-questions": "sub-questions",
  "document-first": "Documents searched inside",
};

/**
 * The other ways to find candidates, with embeddings off, each reranked by
 * the built-in model: their hits next to the Tool's reranked order, how often their
 * candidates held the expected Passage, and what a search costs. Never gating.
 */
function otherSearchesSection(run: RetrievalRun): string[] {
  const report = run.otherSearches;
  if (!report) return [];
  const model = BUILT_IN_RERANKING_MODEL;
  const rows = [GATING_SEARCH, ...OTHER_SEARCHES].map((search) => {
    const mode = rerankMode(model, search);
    const summary = run.summary[mode];
    const label = search === GATING_SEARCH ? GATING_LABEL : rerankedLabel(search, model.name);
    if (!summary) {
      return `| ${label} | skipped: ${report.skipped[search] ?? "it didn't run."} ||||||||||`;
    }
    const counts = run.candidates?.find((each) => each.search === search);
    const info = run.rerankers?.find((each) => each.mode === mode);
    const call = report.queryModel.find((each) => each.search === search);
    const finding = info?.candidates
      ? `${ms(info.candidates.mean)}${call ? ` + ${ms(call.meanMs)} model call` : ""}`
      : "–";
    const inAll = info?.candidates
      ? ms(info.candidates.mean + info.latency.mean + (call?.meanMs ?? 0))
      : "–";
    return `| ${label} | ${fraction(summary.en)} | ${fraction(summary.zh)} | ${fraction(summary.core)} | ${bothLanguages(summary.paraphrase)} | ${counts ? fraction(counts.reached.gating) : "–"} | ${counts ? fraction(counts.reached.paraphrase) : "–"} | ${counts ? counts.mean.toFixed(1) : "–"} | ${finding} | ${info ? ms(info.latency.mean) : "–"} | ${inAll} |`;
  });
  const lines = [
    "### Other ways to find the candidates (reported, not gating)",
    "",
    `With embeddings off, each search's candidates reranked by ${model.name}, the Questions' own searches only (no translated second query). The search Tool's reranked order comes first, for comparison. "Reached": the Questions whose candidates held a Passage that meets the hit rule, before reranking: what any reranker could have found. Per search, on average: the time to find the candidates (a chat model's call apart, as measured when it was made), to rerank them, and the two together.`,
    "",
    ...OTHER_SEARCHES.map(
      (search) => `- **${SEARCH_LABELS[search]}**: ${SEARCH_DESCRIPTIONS[search]}.`,
    ),
    "",
    "| Reranked mode | English | Chinese | Gating set | Paraphrase (English + Chinese) | Reached: gating | Reached: paraphrase | Candidates | Finding them | Reranking | Per search in all |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ];
  const { smallToBig } = report;
  if (smallToBig) {
    lines.push(
      `Small-to-big's index: ${smallToBig.subChunks} sub-chunks of ${smallToBig.meanTokens.toFixed(0)} tokens on average (at most ${smallToBig.maxTokens}), ${(smallToBig.indexBytes / 1e6).toFixed(1)} MB for the FTS5 table and the sub-chunk to Passage table, against ${(smallToBig.passageIndexBytes / 1e6).toFixed(1)} MB for the Passages' own keyword index built the same way; built in ${smallToBig.buildSeconds.toFixed(1)} s${smallToBig.unplaced ? `. ${smallToBig.unplaced} sub-chunks weren't found in a Passage and are left out` : ""}.`,
      "",
      "| Passages scored by | Reached: gating | Reached: paraphrase |",
      "|---|---|---|",
      ...smallToBig.aggregations.map(
        ({ aggregation, reached }) =>
          `| ${AGGREGATION_LABELS[aggregation]} | ${fraction(reached.gating)} | ${fraction(reached.paraphrase)} |`,
      ),
      "",
    );
  }
  if (report.queryModel.length) {
    lines.push(
      "Chat model calls, one per Question for each mode, kept in `eval/results/query-rewrites.json` so later runs search the same queries:",
      "",
      "| Reranked mode | Model | Questions | Asked in this run | From the cache | Call: mean | 95th percentile | Input tokens per call | Output tokens per call | Queries per Question |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...report.queryModel.map(
        (cost) =>
          `| ${rerankedLabel(cost.search, model.name)} | \`${cost.model}\` | ${cost.questions} | ${cost.calls} | ${cost.cached} | ${ms(cost.meanMs)} | ${ms(cost.p95Ms)} | ${cost.meanInputTokens?.toFixed(0) ?? "–"} | ${cost.meanOutputTokens?.toFixed(0) ?? "–"} | ${cost.meanQueries.toFixed(1)} |`,
      ),
      "",
    );
  }
  return lines;
}

function perQuestionTable(runs: readonly RetrievalRun[]): string[] {
  const columns = runs.flatMap((run) => modesIn(run).map((mode) => ({ run, mode })));
  const header = columns.map(({ run, mode }) =>
    runs.length > 1
      ? `${modeLabel(run, mode)} (${run.gating ? "built-in" : "cloud"})`
      : modeLabel(run, mode),
  );
  const first = runs[0] as RetrievalRun;
  // Keyword search doesn't use embeddings: its deep rank is the same in every run.
  const deep = first.questions.some((question) => question.keywordRank !== undefined);
  const lines = [
    `| Question | ${header.join(" | ")} |${deep ? ` keyword, to ${KEYWORD_RANK_DEPTH} |` : ""} Text |`,
    `|---|${columns.map(() => "---|").join("")}${deep ? "---|" : ""}---|`,
  ];
  const rank = (result: ModeResult | undefined) => {
    if (!result?.rank) return "–";
    return result.hit ? String(result.rank) : `(${result.rank})`;
  };
  first.questions.forEach((question, index) => {
    const cells = columns.map(({ run, mode }) => {
      const result = run.questions[index];
      const translated = result?.translated?.[mode];
      return translated
        ? `${rank(result?.modes[mode])} / ${rank(translated)}`
        : rank(result?.modes[mode]);
    });
    if (deep) cells.push(question.keywordRank ? String(question.keywordRank) : "–");
    const id = question.crossLingual
      ? `${question.id} (cross-lingual)`
      : question.paraphrase
        ? `${question.id} (paraphrase)`
        : question.id;
    const text = question.translatedQuery
      ? `${question.question} / ${question.translatedQuery}`
      : question.question;
    lines.push(`| ${id} | ${cells.join(" | ")} | ${text} |`);
  });
  return lines;
}

/**
 * For each miss of the gating mode: what the top 5 were, and what each lacked.
 * `unit` names what the pages are: "p." for PDFs, "Unit" for any format.
 */
function misses(run: RetrievalRun, unit = "p."): string[] {
  const lines: string[] = [];
  const describe = (question: QuestionResult) =>
    (question.modes[TOOL_MODE]?.top ?? []).map((passage, index) => {
      const lacks = [
        passage.rightDocument ? null : "other Document",
        passage.coversPages ? null : `other ${unit === "p." ? "pages" : "Units"}`,
        passage.hasQuote ? null : "no quote",
      ].filter(Boolean);
      return `${index + 1}. ${passage.documentName}, ${unit} ${pages(passage.pageFrom, passage.pageTo)}${lacks.length ? ` (${lacks.join(", ")})` : ""}`;
    });
  for (const question of run.questions) {
    if (question.modes[TOOL_MODE]?.hit) continue;
    lines.push(`- **${question.id}** ${question.question}`);
    for (const line of describe(question)) lines.push(`  ${line}`);
    if (question.keywordRank !== undefined) {
      lines.push(
        `  Plain keyword search ranks the expected Passage ${question.keywordRank === null ? `below ${KEYWORD_RANK_DEPTH}` : `at ${question.keywordRank}`}.`,
      );
    }
    for (const [search, label] of Object.entries(QUERY_LABELS) as [RerankedSearch, string][]) {
      const queries = question.queries?.[search];
      if (queries) {
        lines.push(
          `  ${label[0]?.toUpperCase()}${label.slice(1)}: ${queries.length ? queries.map((query) => `"${query}"`).join(", ") : "none"}.`,
        );
      }
    }
  }
  return lines;
}

/**
 * Citation figures, a column per group of Answers. With `minCitations` (the
 * gating set's), each figure's target in a last column, and the reviewer's row.
 */
function citationTable(
  columns: readonly (readonly [string, GroupSummary])[],
  minCitations: number | null,
): string[] {
  const gating = minCitations !== null;
  const row = (label: string, cell: (summary: GroupSummary) => string, target = "") =>
    `| ${label} | ${columns.map(([, summary]) => cell(summary)).join(" | ")} |${gating ? ` ${target} |` : ""}`;
  const outcome = (key: CitationOutcome) => (summary: GroupSummary) =>
    summary.citations > 0
      ? `${summary.outcomes[key]} (${percent(summary.outcomes[key] / summary.citations)})`
      : "0";
  return [
    `| | ${columns.map(([label]) => label).join(" | ")} |${gating ? " Target (per language) |" : ""}`,
    `|---|${columns.map(() => "---|").join("")}${gating ? "---|" : ""}`,
    row("Answers (failed)", (summary) => `${summary.answers} (${summary.failedAnswers})`),
    row(
      "Answers with a Citation",
      (summary) =>
        `${percent(summary.citedAnswerShare)} (${summary.citedAnswers}/${summary.answers})`,
      "reported",
    ),
    row(
      "Time per Answer (median)",
      (summary) => (summary.medianSeconds === null ? "–" : `${summary.medianSeconds.toFixed(1)} s`),
      "reported",
    ),
    row("Citations", (summary) => String(summary.citations), `at least ${minCitations}`),
    row(
      OUTCOME_LABELS.found,
      (summary) => percent(summary.foundShare),
      `at least ${percent(CITATION_TARGETS.found)}`,
    ),
    row(
      OUTCOME_LABELS["false-not-found"],
      (summary) => percent(summary.falseNotFoundShare),
      `at most ${percent(CITATION_TARGETS.falseNotFound)}`,
    ),
    ...CITATION_OUTCOMES.filter((key) => key !== "found" && key !== "false-not-found").map((key) =>
      row(OUTCOME_LABELS[key], outcome(key)),
    ),
    row(
      "Sentences with a Citation (coverage)",
      (summary) => `${percent(summary.coverage)} (${summary.citedSentences}/${summary.sentences})`,
      "reported",
    ),
    row(
      "Markers without records (removed)",
      (summary) => String(summary.droppedMarkers),
      "reported",
    ),
    row(
      "Records without markers (dropped)",
      (summary) => String(summary.droppedRecords),
      "reported",
    ),
    row(
      "Prompt cache hit rate (cached input tokens)",
      ({ usage }) =>
        usage.inputTokens === 0
          ? "–"
          : `${percent(usage.cacheHitRate)} (${usage.cachedInputTokens}/${usage.inputTokens})`,
      "reported",
    ),
    row(
      "Tokens written to the prompt cache",
      ({ usage }) => String(usage.cacheWriteTokens),
      "reported",
    ),
    row(
      "Answers that asked again for quotes",
      ({ quoteRetries, answers }) => `${quoteRetries.answers}/${answers}`,
      "reported",
    ),
    row(
      "Records asked again: recovered",
      ({ quoteRetries }) => `${quoteRetries.recovered}/${quoteRetries.records}`,
      "reported",
    ),
    row(
      "Time the request added: median, most",
      ({ quoteRetries }) =>
        quoteRetries.answers === 0
          ? "–"
          : `${seconds(quoteRetries.medianSeconds)}, ${seconds(quoteRetries.maxSeconds)}`,
      "reported",
    ),
    row(
      "Time the requests added per Answer",
      ({ quoteRetries }) => seconds(quoteRetries.secondsPerAnswer),
      "reported",
    ),
    ...(gating
      ? [
          row(
            "Found quotes that support their sentence",
            () => "reviewer sheet",
            `at least ${percent(CITATION_TARGETS.supports)}`,
          ),
        ]
      : []),
  ];
}

/** Text for a cell of a Markdown table. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/**
 * Each Citation the check didn't find, and each Answer without a Citation,
 * with why: so a short run shows what went wrong. `unit` names what the
 * pages are: "p." for PDFs, "Unit" for any format.
 */
function whyNotFound(run: CitationRun, unit: "p." | "Unit", heading = "###"): string[] {
  const missed = run.answers.flatMap((answer) =>
    answer.citations
      .filter((citation) => citation.outcome !== "found")
      .map((citation) => ({ answer, citation })),
  );
  const uncited = run.answers.filter((answer) => answer.citations.length === 0);
  const lines = [
    `${heading} Citations not found`,
    "",
    `Each Citation the check didn't find: the ${unit === "p." ? "pages" : "Units"} it cites, its Passage's, and where its quote is in the Document under the looser normalisation ("–": nowhere, e.g. paraphrased, or written in other characters).`,
    "",
  ];
  if (missed.length === 0) lines.push("None.", "");
  else {
    lines.push(
      "| Question | Round | Outcome | Check | Document | Cites | Passage | Quote is on | Quote |",
      "|---|---|---|---|---|---|---|---|---|",
      ...missed.map(({ answer, citation }) => {
        const cites =
          citation.pageFrom === null
            ? "–"
            : pagesLabel([citation.pageFrom, citation.pageTo ?? citation.pageFrom], unit);
        return `| ${answer.questionId} | ${answer.round} | ${OUTCOME_LABELS[citation.outcome]} | ${citation.checkReason ?? ""} | ${cell(citation.documentName)} | ${cites} | ${pagesLabel(citation.passagePages, unit)} | ${pagesLabel(citation.quoteOn, unit)} | ${cell(shortQuote(citation.quote))} |`;
      }),
      "",
    );
  }
  lines.push(`${heading} Answers without a Citation`, "");
  if (uncited.length === 0) lines.push("None.", "");
  else {
    lines.push(
      "| Question | Round | Status | Citing | Markers removed | Records dropped | Records rejected | Searched for | Begins |",
      "|---|---|---|---|---|---|---|---|---|",
      ...uncited.map(
        (answer) =>
          `| ${answer.questionId} | ${answer.round} | ${answer.status}${answer.error ? ` (${answer.error.kind})` : ""} | ${answer.citationSupport ?? "unknown"} | ${answer.droppedMarkers} | ${answer.droppedRecords} | ${cell(rejectedLine(answer.rejectedRecords ?? []))} | ${cell(answer.searches.join("; "))} | ${cell(shortQuote(answer.sentences[0]?.text ?? "", 120))} |`,
      ),
      "",
    );
  }
  return lines;
}

/** The every-format set (#70): per format, per hard place and per Question. Never gating. */
function formatsSection(formats: FormatsReport): string[] {
  const { retrieval } = formats;
  const top = retrieval.summary[GATING_MODE];
  const notSearchable = formats.documents.filter((document) => document.status !== "ready");
  const lines = [
    "## Every format (reported, not gating)",
    "",
    `\`${formats.source}\`: ${retrieval.questions.length} Questions over ${formats.documents.length} Documents in Word, PowerPoint, Excel, CSV, Markdown, plain text, PDF, Transcript and Web page, in English and Chinese, about the hard places in each (#70, #155). They are searched in a library of their own, with the gating set's hit rule; the expected pages are the Units a Citation would cite. Known gaps, text the readers don't index today (scanned pages), are counted apart. No bar is set yet: \`eval/README.md\` proposes one per format.`,
    "",
    `| Format | Documents | Questions (English / Chinese), known gaps apart | ${GATING_LABEL}: English | Chinese | All | ${HYBRID}: All | ${HYBRID_RERANK_LABEL}: All | Known gaps found |`,
    "|---|---|---|---|---|---|---|---|---|",
    ...formats.formats.map((format) => {
      const reranked = format.retrieval[GATING_MODE];
      const hybrid = format.retrieval[HYBRID];
      const hybridReranked = format.retrieval[HYBRID_RERANK_MODE];
      if (!reranked || !hybrid)
        return `| ${format.label} | ${format.documents} | – | – | – | – | – | – | – |`;
      return `| ${format.label} | ${format.documents} | ${reranked.en.total} / ${reranked.zh.total} | ${fraction(reranked.en)} | ${fraction(reranked.zh)} | **${fraction(reranked.all)}** | ${fraction(hybrid.all)} | ${hybridReranked ? fraction(hybridReranked.all) : "–"} | ${fraction(format.knownGaps)} |`;
    }),
    "",
    ...(top
      ? [
          `Cross-lingual, every format: ${fraction(top.crossLingual)}${top.crossLingualTranslated ? `, with a translated second query ${fraction(top.crossLingualTranslated)}` : ""}.`,
          "",
        ]
      : []),
    ...(notSearchable.length
      ? [
          `Not searchable: ${notSearchable.map((document) => `${document.name} (${document.status})`).join(", ")}.`,
          "",
        ]
      : []),
    "### By hard place",
    "",
    `Hits of ${GATING_LABEL}, known gaps included.`,
    "",
    "| Format | Place | English | Chinese | |",
    "|---|---|---|---|---|",
    ...formats.formats.flatMap((format) =>
      format.places.map(
        (place) =>
          `| ${format.label} | ${place.place} | ${fraction(place.hits.en)} | ${fraction(place.hits.zh)} | ${place.knownGap ? `known gap: ${place.knownGap}` : ""} |`,
      ),
    ),
    "",
  ];
  const { citations, crossLingualCitations } = formats;
  if ("skipped" in citations) {
    lines.push("### Citations per format", "", `Skipped: ${citations.skipped}`, "");
  } else {
    const columns = [
      ...formats.formats.flatMap((format) =>
        format.citations ? [[format.label, format.citations] as const] : [],
      ),
      ...(crossLingualCitations ? [["Cross-lingual", crossLingualCitations] as const] : []),
    ];
    lines.push(
      "### Citations per format",
      "",
      `- Model: \`${citations.model}\`, ${citations.service ? `sent to ${citations.service}` : "on this computer"}; each Question asked once, in a Mind of its own. Reported, not gating.`,
      '- The figures are defined as for the gating set; a Citation\'s "pages" are the Units it cites.',
      "",
      ...citationTable(columns, null),
      "",
      ...whyNotFound(citations, "Unit", "####"),
    );
  }
  lines.push(
    "### Per Question",
    "",
    "Ranks as for the gating set.",
    "",
    ...perQuestionTable([retrieval]),
    "",
    `### Misses of ${GATING_LABEL}`,
    "",
    ...(misses(retrieval, "Unit").length ? misses(retrieval, "Unit") : ["None."]),
    "",
  );
  return lines;
}

function markdownReport(report: EvalReport, reportDir: string, root: string): string {
  const { run, retrieval, citations } = report;
  const builtIn = retrieval.runs[0] as RetrievalRun;
  const sheet = relative(root, join(reportDir, "reviewer-sheet.csv"));
  const lines = [
    "# IncarnaMind evaluation",
    "",
    `**Result: ${report.result === "pass" ? "pass" : "fail"}**`,
    ...(report.failures.length ? ["", ...report.failures.map((failure) => `- ${failure}`)] : []),
    "",
    `- Run: ${run.startedAt}, ${run.seconds.toFixed(0)} s, commit ${run.commit}`,
    `- Machine: ${run.platform}, ${run.cpu}, Node ${run.node}`,
    `- Evaluation set: \`${report.evaluationSet.source}\`, ${report.evaluationSet.questions.gating.en} English and ${report.evaluationSet.questions.gating.zh} Chinese gating Questions, ${report.evaluationSet.questions.crossLingual} cross-lingual, ${report.evaluationSet.questions.paraphrase} paraphrase`,
    `- Documents: ${report.documents.length} (${report.documents.map((document) => document.name).join(", ")})`,
    "",
    "## Retrieval",
    "",
    `Top-${retrieval.topK} hit rate through the core's \`searchPassages\`. A Question is a hit when one of the top ${retrieval.topK} Passages belongs to the expected Document, covers the expected pages and contains the expected quote, both normalised (ADR-0009). The gate is the search Tool itself, run as an Answer runs it with embeddings off (keyword search's top ${KEYWORD_RERANK_DEPTH} reranked by the built-in reranking model, grouped into at most ${SEARCH_TOOL_PARAMETERS.maxPassages} Passages), scored by whether the Passages it hands the model hold the expected one: at least 15 of 20 English and 20 of 20 Chinese gating Questions (35 of 40), what it found when it was chosen (ADR-0009, 2026-10-12). Beside it, reported: ${GATING_LABEL}, top ${retrieval.topK} of the reranked order, which the Tool starts from, the plain search modes, hybrid + rerank, the other reranking candidates, cross-lingual and paraphrase Questions and cloud embedding models.`,
    "",
    `- **Keyword + rerank** ("keyword top ${KEYWORD_RERANK_DEPTH} + model"): keyword search's top ${KEYWORD_RERANK_DEPTH}, reordered by a reranking model, as the search Tool hands its reranker by default.`,
    `- **Hybrid + rerank** ("${HYBRID} + model"): what the search Tool hands a reranker with embeddings on, keyword search's top ${RERANK_PER_LIST} and vector search's top ${RERANK_PER_LIST}, each Passage once, reordered by the same reranking models.`,
    "- **With a translated second query:** the cross-lingual Questions that have a hand-written translation into their Document's language are also searched with it, as an Answer is told to search again in the Documents' language. A hit in either search's top 5 counts. The translation is written by hand, so this is the most the approach can bring.",
    "- **Paraphrase:** Questions that ask for a fact on one page in words that avoid its passage's own, as a person asks without the text in front of them; hits in both languages, then in English + Chinese. They are out of the gating set's counts and bar.",
    ...(builtIn.otherSearches
      ? [
          '- **Other ways to find the candidates** ("keyword top 60 + model", the gate before, and the like): with embeddings off, other candidates for the built-in reranking model, to compare with the Tool\'s; see below.',
        ]
      : []),
    "",
    ...retrievalTable(retrieval.runs),
    "",
    ...retrieval.runs.map(
      (each) =>
        `- ${each.embedding}: ${each.passageCount} Passages, added and processed (text extraction and embedding) in ${each.processingSeconds.toFixed(0)} s.`,
    ),
    "",
    ...(builtIn.rerankers?.length
      ? [
          "### Reranking models",
          "",
          ...candidateCountsOf(builtIn).flatMap((counts) => [candidatesLine(counts), ""]),
          "Time on this machine to find one search's candidates, and to rerank them (one Passage at a time on a worker thread, after the first search, which loads the model; each mode opens it afresh).",
          "",
          ...rerankerTable(builtIn),
          "",
        ]
      : []),
    ...otherSearchesSection(builtIn),
    "### Per Question",
    "",
    `The rank of the first Passage that meets the hit rule. Only the top ${retrieval.topK} count as hits: a rank in brackets is a near miss, within the top ${RANK_DEPTH}, and "–" means none in the top ${RANK_DEPTH}. For a cross-lingual Question with a translated query, "a / b" is the rank for the Question, then for its translation. "keyword, to ${KEYWORD_RANK_DEPTH}" is plain keyword search's rank, looked for in its top ${KEYWORD_RANK_DEPTH}: how many candidates a reranker would need to see it.`,
    "",
    ...perQuestionTable(retrieval.runs),
    "",
    `### Misses of the ${TOOL_LABEL} (gating)`,
    "",
    ...(misses(builtIn).length ? misses(builtIn) : ["None."]),
    "",
    "## Citation quality",
    "",
  ];
  if ("skipped" in citations) {
    lines.push(`Skipped: ${citations.skipped}`, "");
  } else {
    lines.push(
      `- Model: \`${citations.model}\`, ${citations.service ? `sent to ${citations.service}` : "on this computer"}. ${citations.subset ? `Only ${citations.subset.length} of the Questions were asked (INCARNAMIND_EVAL_QUESTIONS: ${citations.subset.join(", ")}), once each: a short check, reported, never gating.` : citations.gating ? "It is the gating model." : "A local model: reported, not gating."}${citations.overrides.length > 0 ? ` Set by the run: ${citations.overrides.join(", ")}.` : ""}`,
      `- Each Question asked in a Mind of its own; ${citations.rounds} round${citations.rounds === 1 ? "" : "s"} (more rounds ask a language's gating Questions again until it has ${citations.minCitations} Citations).`,
      "- The targets are for the gating Questions, English and Chinese; the cross-lingual and paraphrase Answers are columns of their own, reported only.",
      `- False "not found": the check said "not found", but the quote is on the cited pages once both are compared by letters and digits only, ignoring case, accents and punctuation, and reading an f-ligature's letters as one "f" (a PDF's text may read "fnance" where the page shows "finance"). The share is of all Citations.`,
      "- Coverage counts every sentence of an Answer (headings and code left out) as drawn from Documents, so it is a lower bound: sentences that only say what the Documents don't cover count as uncited.",
      `- Reviewer sheet: \`${sheet}\`. Mark each found quote "y" if it supports its sentence, "n" if not; the target is ${percent(CITATION_TARGETS.supports)} "y".`,
      "",
      ...citationTable(
        GROUPS.map(([group, label]) => [label, citations.summary[group]] as const),
        citations.minCitations,
      ),
      "",
      ...timingSection(GROUPS.map(([group, label]) => ({ label, ...citations.summary[group] }))),
      ...whyNotFound(citations, "p."),
    );
  }
  if (report.formats && "skipped" in report.formats) {
    lines.push(
      "## Every format (reported, not gating)",
      "",
      `Skipped: ${report.formats.skipped}`,
      "",
    );
  } else if (report.formats) {
    lines.push(...formatsSection(report.formats));
  }
  lines.push(
    "## Citation-check cases",
    "",
    "The check's cases (hyphenation, ligatures, full-width punctuation, CJK text, quotes across a page break, the page-range rule, in English and Chinese) are unit tests that run with `npm test`: see `eval/README.md`.",
    "",
  );
  return lines.join("\n");
}

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * Found quotes, one row each, with an empty column for the reviewer's
 * judgement. Each Answer to an unanswerable Question the phrase rule didn't
 * take as a decline gets a row with its text, and a column to mark a decline
 * the rule missed.
 */
export function reviewerSheet(run: CitationRun): string {
  const rows: (string | number)[][] = [
    [
      "question_id",
      "language",
      "round",
      "question",
      "answer_sentence",
      "quote",
      "document",
      "page",
      "supports (y/n)",
      "answer (the rule found no decline)",
      "decline missed by the rule (y/n)",
      "note",
    ],
  ];
  const languageOf = (answer: CitationRun["answers"][number]) =>
    answer.crossLingual
      ? `${answer.language} (cross-lingual)`
      : answer.paraphrase
        ? `${answer.language} (paraphrase)`
        : answer.language;
  for (const answer of run.answers) {
    for (const citation of answer.citations) {
      if (citation.outcome !== "found") continue;
      rows.push([
        answer.questionId,
        languageOf(answer),
        answer.round,
        answer.question,
        citation.sentence,
        citation.quote,
        citation.documentName,
        pages(citation.pageFrom, citation.pageTo),
        "",
        "",
        "",
        "",
      ]);
    }
    if (answer.declines === false && answer.status === "done") {
      rows.push([
        answer.questionId,
        languageOf(answer),
        answer.round,
        answer.question,
        "",
        "",
        "",
        "",
        "",
        answer.text,
        "",
        "",
      ]);
    }
  }
  // A byte-order mark, so spreadsheet apps read the Chinese text as UTF-8.
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Every Answer's full text under its Question, for people to read beside the figures. */
export function answersText(run: CitationRun): string {
  return [
    `# Answers (${run.model})`,
    "",
    ...run.answers.flatMap((answer) => [
      `## ${answer.questionId}, round ${answer.round}, ${answer.language}`,
      "",
      `Question: ${answer.question}`,
      "",
      `Status: ${answer.status}${answer.declines === undefined ? "" : `; the rule ${answer.declines ? "found" : "did not find"} a decline`}`,
      "",
      answer.text || "(no text)",
      "",
    ]),
  ].join("\n");
}

/** Writes the reports into a new folder and returns its path. */
export async function writeReports(
  report: EvalReport,
  resultsDir: string,
  root: string,
): Promise<string> {
  const dir = join(resultsDir, report.run.startedAt.replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, "report.md"), markdownReport(report, dir, root));
  if (!("skipped" in report.citations)) {
    await writeFile(join(dir, "reviewer-sheet.csv"), reviewerSheet(report.citations));
    await writeFile(join(dir, "answers.md"), answersText(report.citations));
  }
  if (
    report.formats &&
    !("skipped" in report.formats) &&
    !("skipped" in report.formats.citations)
  ) {
    await writeFile(
      join(dir, "reviewer-sheet-formats.csv"),
      reviewerSheet(report.formats.citations),
    );
    await writeFile(join(dir, "answers-formats.md"), answersText(report.formats.citations));
  }
  return dir;
}

/** The summary printed at the end of a run. */
export function terminalSummary(report: EvalReport, reportDir: string, root: string): string {
  const lines = ["", `Retrieval, top ${report.retrieval.topK} (hit rule of ADR-0009)`];
  for (const run of report.retrieval.runs) {
    lines.push(`  ${run.embedding}${run.gating ? "" : " (reported, not gating)"}`);
    for (const mode of modesIn(run)) {
      const summary = run.summary[mode];
      if (!summary) continue;
      const label =
        run.gating && mode === TOOL_MODE
          ? `${modeLabel(run, mode)} (gating)`
          : modeLabel(run, mode);
      const translated = summary.crossLingualTranslated;
      const paraphrase = summary.paraphrase.all;
      lines.push(
        `    ${label.padEnd(16)} English ${fraction(summary.en).padEnd(6)} Chinese ${fraction(summary.zh).padEnd(6)} gating set ${fraction(summary.core).padEnd(6)} cross-lingual ${fraction(summary.crossLingual)}${translated ? `, with a translated second query ${fraction(translated)}` : ""}${paraphrase.total > 0 ? `; paraphrase ${fraction(paraphrase)}` : ""}`,
      );
    }
    for (const counts of candidateCountsOf(run)) lines.push(`    ${candidatesLine(counts)}`);
    for (const each of run.rerankers ?? []) {
      lines.push(
        `    ${modeLabel(run, each.mode as RetrievalMode)}: ${(each.downloadBytes / 1e6).toFixed(0)} MB, ${each.candidates ? `${each.candidates.mean.toFixed(0)} ms to find the candidates and ` : ""}${each.latency.mean.toFixed(0)} ms to rerank them per search on average (95th percentile ${each.latency.p95.toFixed(0)} ms)`,
      );
    }
    const others = run.otherSearches;
    if (others?.smallToBig) {
      const index = others.smallToBig;
      lines.push(
        `    Small-to-big's index: ${index.subChunks} sub-chunks, ${(index.indexBytes / 1e6).toFixed(1)} MB (the Passages' own: ${(index.passageIndexBytes / 1e6).toFixed(1)} MB), built in ${index.buildSeconds.toFixed(1)} s; expected Passage among the 20 candidates by ${index.aggregations.map(({ aggregation, reached }) => `${aggregation} sub-chunk score ${fraction(reached.gating)} gating, ${fraction(reached.paraphrase)} paraphrase`).join("; by ")}`,
      );
    }
    for (const cost of others?.queryModel ?? []) {
      lines.push(
        `    ${SEARCH_LABELS[cost.search]}: ${cost.model}, ${cost.calls} calls in this run and ${cost.cached} from the cache, ${cost.meanMs.toFixed(0)} ms and ${cost.meanInputTokens?.toFixed(0) ?? "?"} + ${cost.meanOutputTokens?.toFixed(0) ?? "?"} tokens per call on average`,
      );
    }
    for (const [search, reason] of Object.entries(others?.skipped ?? {})) {
      lines.push(`    ${SEARCH_LABELS[search as RerankedSearch]}: skipped, ${reason}`);
    }
  }
  const { citations } = report;
  if ("skipped" in citations) {
    lines.push("", `Citation quality: skipped. ${citations.skipped}`);
  } else {
    lines.push(
      "",
      `Citation quality, ${citations.model}${citations.subset ? ` (${citations.subset.length} Questions only, not gating)` : citations.gating ? " (gating)" : " (local, not gating)"}`,
    );
    for (const [group, label] of GROUPS) {
      const summary = citations.summary[group];
      lines.push(
        `  ${label.padEnd(14)} ${percent(summary.citedAnswerShare)} of ${summary.answers} Answers cited, ${String(summary.citations).padStart(3)} Citations, found ${percent(summary.foundShare)}, false "not found" ${percent(summary.falseNotFoundShare)}, coverage ${percent(summary.coverage)}, dropped ${summary.droppedMarkers} markers and ${summary.droppedRecords} records, median ${summary.medianSeconds === null ? "–" : `${summary.medianSeconds.toFixed(1)} s`} an Answer`,
      );
      if (summary.usage.inputTokens > 0) {
        lines.push(
          `  ${"".padEnd(14)} prompt cache: ${percent(summary.usage.cacheHitRate)} of ${summary.usage.inputTokens} input tokens read from it, ${summary.usage.cacheWriteTokens} written`,
        );
      }
      if (summary.quoteRetries.answers > 0) {
        lines.push(
          `  ${"".padEnd(14)} quotes asked again: ${quoteRetryLine(summary.quoteRetries)}`,
        );
      }
      const timing = timingLine(summary.timing);
      if (timing) lines.push(`  ${"".padEnd(14)} ${timing}`);
    }
  }
  if (report.formats && "skipped" in report.formats) {
    lines.push("", `Every format: skipped. ${report.formats.skipped}`);
  } else if (report.formats) {
    lines.push(...formatsSummary(report.formats));
  }
  lines.push("", `Result: ${report.result}`);
  for (const failure of report.failures) lines.push(`  - ${failure}`);
  lines.push(`Reports: ${relative(root, reportDir)}/`, "");
  return lines.join("\n");
}

/** The every-format set's lines of the terminal summary. */
function formatsSummary(formats: FormatsReport): string[] {
  const lines = [
    "",
    `Every format (reported, not gating): ${GATING_LABEL}, top 5, known gaps apart`,
  ];
  for (const format of formats.formats) {
    const reranked = format.retrieval[GATING_MODE];
    const hybridReranked = format.retrieval[HYBRID_RERANK_MODE];
    const citations = format.citations;
    lines.push(
      `  ${format.label.padEnd(24)} English ${fraction(reranked?.en ?? { hits: 0, total: 0 }).padEnd(6)} Chinese ${fraction(reranked?.zh ?? { hits: 0, total: 0 }).padEnd(6)} known gaps ${fraction(format.knownGaps)}${hybridReranked ? `; ${HYBRID_RERANK_LABEL} ${fraction(hybridReranked.all)}` : ""}${citations ? `; ${citations.citations} Citations, found ${percent(citations.foundShare)}, false "not found" ${percent(citations.falseNotFoundShare)}, coverage ${percent(citations.coverage)}` : ""}`,
    );
  }
  const top = formats.retrieval.summary[GATING_MODE];
  if (top) {
    lines.push(
      `  ${"Cross-lingual".padEnd(24)} ${fraction(top.crossLingual)}${top.crossLingualTranslated ? `, with a translated second query ${fraction(top.crossLingualTranslated)}` : ""}`,
    );
  }
  return lines;
}
