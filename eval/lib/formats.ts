/**
 * Every format (#70): the set in eval/retrieval/formats.json, reported per
 * format and per hard place next to the gating set. It never gates. A
 * Question's format is its Document's kind, grouped as Users name them.
 *
 * - Retrieval: ./retrieval's hit rule and modes, on a library of the set's
 *   own Documents. Per format, the Questions in each language that aren't
 *   known gaps; per hard place, all of them, known gaps marked.
 * - Citations: with a chat model, each Question asked once, its Citations
 *   scored as ./citations scores them, per format.
 */
import type { DocumentKind, DocumentStatus } from "../../src/core";
import { kindOf } from "../../src/core/documents/files";
import { type CitationRun, type GroupSummary, summariseGroup } from "./citations";
import type { EvalLanguage, EvaluationSet } from "./evaluationSet";
import {
  GATING_MODE,
  HYBRID,
  HYBRID_RERANK_MODE,
  type LanguageTallies,
  type RetrievalMode,
  type RetrievalRun,
  type Tally,
} from "./retrieval";

export const FORMATS = [
  { id: "word", label: "Word", kinds: ["docx"] },
  { id: "powerpoint", label: "PowerPoint", kinds: ["pptx"] },
  { id: "spreadsheet", label: "Excel and CSV", kinds: ["xlsx", "csv"] },
  { id: "text", label: "Markdown and plain text", kinds: ["markdown", "text"] },
  { id: "pdf", label: "PDF", kinds: ["pdf"] },
  { id: "transcript", label: "Transcript", kinds: ["transcript"] },
  { id: "web", label: "Web page", kinds: ["web"] },
] as const satisfies readonly { id: string; label: string; kinds: readonly DocumentKind[] }[];

export type FormatId = (typeof FORMATS)[number]["id"];

/**
 * The modes reported per format, those that ran: the search Tool's default
 * (keyword + rerank), plain hybrid search, and hybrid + rerank.
 */
export const FORMAT_MODES: readonly RetrievalMode[] = [GATING_MODE, HYBRID, HYBRID_RERANK_MODE];

/**
 * The format of a Document, by its kind: `kind` when the set names it, as a
 * Web page's, else the kind of the file at `path`.
 */
export function formatOf(path: string, kind: DocumentKind | undefined = kindOf(path)): FormatId {
  const format = FORMATS.find((each) => (each.kinds as readonly string[]).includes(kind ?? ""));
  if (!format) throw new Error(`${path} isn't a Document format.`);
  return format.id;
}

export interface PlaceSummary {
  place: string;
  /** Why its Questions' answers aren't indexed today, when they are known gaps. */
  knownGap: string | null;
  /** Hits of the search Tool's default mode. */
  hits: LanguageTallies;
}

export interface FormatSummary {
  format: FormatId;
  label: string;
  documents: number;
  /** Per mode, over the Questions that are neither known gaps nor cross-lingual. */
  retrieval: Partial<Record<RetrievalMode, LanguageTallies>>;
  /** The known gaps' Questions, apart: how many the default mode found anyway. */
  knownGaps: Tally;
  places: PlaceSummary[];
  /** The Citations in Answers to the format's Questions, cross-lingual ones left out; null without a chat model. */
  citations: GroupSummary | null;
}

/** The every-format set's part of the report. */
export interface FormatsReport {
  source: string;
  documents: { key: string; name: string; format: FormatId; status: DocumentStatus }[];
  retrieval: RetrievalRun;
  formats: FormatSummary[];
  /** The cross-lingual Questions' Citations, over every format; null without a chat model. */
  crossLingualCitations: GroupSummary | null;
  citations: CitationRun | { skipped: string };
}

const tally = (hits: readonly boolean[]): Tally => ({
  hits: hits.filter(Boolean).length,
  total: hits.length,
});

/** Per format and per hard place: retrieval hits and, when a chat model answered, Citations. */
export function summariseFormats(
  set: EvaluationSet,
  retrieval: RetrievalRun,
  citations: CitationRun | { skipped: string },
): FormatSummary[] {
  const formatByDocument = new Map(
    set.documents.map(({ key, path, kind }) => [key, formatOf(path, kind)]),
  );
  const results = new Map(retrieval.questions.map((result) => [result.id, result]));
  const hit = (id: string, mode: RetrievalMode) => results.get(id)?.modes[mode]?.hit === true;
  const formatOfQuestion = new Map(
    set.questions.map((question) => [
      question.id,
      formatByDocument.get(question.expected.document),
    ]),
  );
  const answers = "skipped" in citations ? null : citations.answers;

  return FORMATS.map(({ id: format, label }) => {
    const asked = set.questions.filter(
      (question) => !question.crossLingual && formatOfQuestion.get(question.id) === format,
    );
    const byLanguage = (questions: typeof asked, mode: RetrievalMode): LanguageTallies => {
      const of = (language: EvalLanguage) =>
        tally(
          questions
            .filter((question) => question.language === language)
            .map((question) => hit(question.id, mode)),
        );
      return {
        en: of("en"),
        zh: of("zh"),
        all: tally(questions.map((question) => hit(question.id, mode))),
      };
    };
    const counted = asked.filter((question) => !question.knownGap);
    const places = [...new Set(asked.map((question) => question.place ?? "other"))].map(
      (place): PlaceSummary => {
        const inPlace = asked.filter((question) => (question.place ?? "other") === place);
        const gaps = inPlace.every((question) => question.knownGap);
        return {
          place,
          knownGap: gaps ? (inPlace[0]?.knownGap ?? null) : null,
          hits: byLanguage(inPlace, GATING_MODE),
        };
      },
    );
    return {
      format,
      label,
      documents: [...formatByDocument.values()].filter((each) => each === format).length,
      retrieval: Object.fromEntries(
        FORMAT_MODES.filter((mode) => retrieval.summary[mode]).map((mode) => [
          mode,
          byLanguage(counted, mode),
        ]),
      ),
      knownGaps: tally(
        asked
          .filter((question) => question.knownGap)
          .map((question) => hit(question.id, GATING_MODE)),
      ),
      places,
      citations: answers
        ? summariseGroup(
            answers.filter(
              (answer) =>
                !answer.crossLingual && formatOfQuestion.get(answer.questionId) === format,
            ),
          )
        : null,
    };
  });
}
