/**
 * An evaluation set: the Documents to add, and the Questions with the
 * Passage each one should find (ADR-0009). The gating set is
 * eval/retrieval/questions.json; the every-format set (#70), reported per
 * format and never gating, is eval/retrieval/formats.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocumentKind } from "../../src/core/api";
import { DOCUMENT_EXTENSIONS } from "../../src/core/documents/files";

export type EvalLanguage = "en" | "zh";

export interface ExpectedPassage {
  /** A key of `EvaluationSet.documents`. */
  document: string;
  /**
   * The first and last Unit the Passage must cover, from 1: a PDF's page as pdf.js
   * indexes it (not the printed label), or another kind's Unit (src/shared/units.ts).
   */
  pages: [number, number];
  /** Text the Passage must contain, after both are normalised. */
  quote: string;
}

export interface EvalQuestion {
  id: string;
  /** The language the Question is asked in. */
  language: EvalLanguage;
  /** Asked in one language about a Document in the other: reported apart, never gating. */
  crossLingual: boolean;
  /**
   * Asks for a fact on one page in words that avoid its passage's own
   * (synonyms, descriptions), as a person asks without the text in front of
   * them: reported apart, never gating, so the gating counts stay comparable.
   * Only true is written; left out, a Question isn't one.
   */
  paraphrase?: boolean;
  question: string;
  /**
   * Cross-lingual Questions only: the search query an Answer would add, the
   * Question translated into its Document's language (written by hand). It
   * stands in for the chat model's second search, to measure the most that
   * searching again in the Documents' language can bring.
   */
  translatedQuery?: string;
  /** Every-format set only: the hard place the answer sits in, e.g. "footnote" or "speaker-notes". */
  place?: string;
  /**
   * Every-format set only: why the readers don't index the answer's text today (a Word
   * comment, a scanned page). Asked and reported like the others, as a known gap.
   */
  knownGap?: string;
  expected: ExpectedPassage;
  /**
   * Every Passage the answer needs, when it needs more than `expected` (the hard
   * tier's); empty: it needs none, as an unanswerable Question. Left out: `expected`.
   */
  expectedAll?: readonly ExpectedPassage[];
}

/**
 * A gating Question: neither cross-lingual nor a paraphrase. Only these count
 * towards the gating bar and its per-language counts.
 */
export const isGating = (question: Pick<EvalQuestion, "crossLingual" | "paraphrase">) =>
  !question.crossLingual && !question.paraphrase;

export interface EvalDocument {
  key: string;
  /** Absolute: the file, or a Web page's HTML, which the evaluation serves to `saveWebPage`. */
  path: string;
  /**
   * A Web page's: "web", since it is saved by its address and has no file
   * kind (#155). Left out: the kind of the file at `path`.
   */
  kind?: DocumentKind;
}

export interface EvaluationSet {
  /** The file it was read from, relative to the repository root. */
  source: string;
  hitRule: string;
  documents: EvalDocument[];
  questions: EvalQuestion[];
}

/** The gating set. */
export const EVALUATION_SET = "eval/retrieval/questions.json";

/** The every-format set (#70): reported per format, never gating. */
export const FORMATS_SET = "eval/retrieval/formats.json";

const LANGUAGES: readonly EvalLanguage[] = ["en", "zh"];

interface RawSet {
  hitRule?: unknown;
  documents?: unknown;
  questions?: unknown;
}

/**
 * A Document as the set names it: its file's path, or for a Web page an
 * object giving the HTML's path and its kind, since the served address is
 * the evaluation's to choose.
 */
function readDocument(
  key: string,
  raw: unknown,
  fail: (message: string) => never,
): { path: string; kind?: DocumentKind } {
  if (typeof raw === "string") return { path: raw };
  const { path, kind } = (typeof raw === "object" && raw !== null ? raw : {}) as {
    path?: unknown;
    kind?: unknown;
  };
  if (typeof path !== "string") fail(`${key}: the path must be text.`);
  if (kind === undefined) return { path };
  if (typeof kind !== "string" || !(kind in DOCUMENT_EXTENSIONS)) {
    fail(`${key}: the kind must be one of ${Object.keys(DOCUMENT_EXTENSIONS).join(", ")}.`);
  }
  return { path, kind: kind as DocumentKind };
}

function readQuestion(
  raw: unknown,
  documents: ReadonlySet<string>,
  fail: (message: string) => never,
): EvalQuestion {
  const question = raw as Partial<EvalQuestion> & { crossLingual?: unknown };
  const { id, language, expected } = question;
  if (typeof id !== "string" || !id) fail("every question needs an id.");
  if (!LANGUAGES.includes(language as EvalLanguage)) fail(`${id}: unknown language.`);
  if (typeof question.question !== "string" || !question.question.trim()) {
    fail(`${id}: no question text.`);
  }
  if (!expected || !documents.has(expected.document)) fail(`${id}: unknown expected document.`);
  const [from, to] = Array.isArray(expected.pages) ? expected.pages : [];
  if (!Number.isInteger(from) || !Number.isInteger(to) || (from as number) > (to as number)) {
    fail(`${id}: expected.pages must be [first, last].`);
  }
  if (typeof expected.quote !== "string" || !expected.quote.trim()) fail(`${id}: no quote.`);
  const crossLingual = question.crossLingual === true;
  const { translatedQuery, place, knownGap, paraphrase } = question as Record<string, unknown>;
  if (paraphrase !== undefined && typeof paraphrase !== "boolean") {
    fail(`${id}: paraphrase must be true or false.`);
  }
  if (paraphrase === true && crossLingual) {
    fail(`${id}: a paraphrase question isn't cross-lingual: it is reported in its own language.`);
  }
  if (translatedQuery !== undefined) {
    if (!crossLingual) fail(`${id}: only a cross-lingual question has a translatedQuery.`);
    if (typeof translatedQuery !== "string" || !translatedQuery.trim()) {
      fail(`${id}: translatedQuery must be text.`);
    }
  }
  for (const [name, value] of [
    ["place", place],
    ["knownGap", knownGap],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      fail(`${id}: ${name} must be text.`);
    }
  }
  return {
    id,
    language: language as EvalLanguage,
    crossLingual,
    ...(paraphrase === true && { paraphrase: true }),
    question: question.question,
    ...(typeof translatedQuery === "string" && { translatedQuery }),
    ...(typeof place === "string" && { place }),
    ...(typeof knownGap === "string" && { knownGap }),
    expected: {
      document: expected.document,
      pages: [from, to] as [number, number],
      quote: expected.quote,
    },
  };
}

/** Reads an evaluation set (the gating one unless another is named), relative to the repository root. */
export function loadEvaluationSet(root: string, source = EVALUATION_SET): EvaluationSet {
  // Typed, so that calling it narrows what follows.
  const fail: (message: string) => never = (message) => {
    throw new Error(`${source}: ${message}`);
  };
  const raw = JSON.parse(readFileSync(join(root, source), "utf8")) as RawSet;
  if (typeof raw.documents !== "object" || raw.documents === null) fail("no documents.");
  const documents = Object.entries(raw.documents as Record<string, unknown>).map(([key, entry]) => {
    const { path, kind } = readDocument(key, entry, fail);
    const absolute = join(root, path);
    if (!existsSync(absolute)) fail(`${key}: ${path} doesn't exist.`);
    return { key, path: absolute, ...(kind === undefined ? {} : { kind }) };
  });
  if (!Array.isArray(raw.questions)) fail("no questions.");
  const keys = new Set(documents.map((document) => document.key));
  const questions = raw.questions.map((question) => readQuestion(question, keys, fail));
  const ids = new Set(questions.map((question) => question.id));
  if (ids.size !== questions.length) fail("question ids must be unique.");
  return {
    source,
    hitRule: typeof raw.hitRule === "string" ? raw.hitRule : "",
    documents,
    questions,
  };
}
