/**
 * The citation benchmark's set: the Documents, each with its source, licence,
 * the day it was read, its SHA-256 and a citation; and the Questions with the
 * gold answer written from the Documents, the quotes it rests on and their
 * Locations. `npm test` runs this through `tests/eval/citationsSet.test.ts`;
 * it checks every gold quote at its Location against what processing stores,
 * and on no other Unit of its Document.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageText } from "../../src/core/documents/passages";
import { processFile } from "../../src/core/documents/processing";
import { quoteInUnits } from "../../src/shared/locations";
import { normaliseText } from "../../src/shared/text";
import { sameRun } from "../../src/shared/units";

export const CITATION_SET = "eval/citations/questions.jsonl";
export const CITATION_DOCUMENTS = "eval/citations/documents.json";

export const QUESTION_KINDS = [
  "single-fact",
  "table-figure",
  "calculated",
  "multi-passage",
  "conflict",
  "absent",
  "superseded",
] as const;

export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const KIND_COUNTS: Readonly<Record<QuestionKind, number>> = {
  "single-fact": 40,
  "table-figure": 35,
  calculated: 20,
  "multi-passage": 20,
  conflict: 15,
  absent: 10,
  superseded: 10,
};

export interface CitationDocument {
  key: string;
  title: string;
  publisher: string;
  language: "en" | "zh";
  path: string;
  pages: number;
  reusedFrom?: string;
  source: string;
  licence: string;
  licenceRead: string;
  retrieved: string;
  basis: string;
  sha256: string;
}

export interface GoldQuote {
  document: string;
  /** The first and last Unit, from 1: a PDF's page as pdf.js indexes it. */
  pages: [number, number];
  quote: string;
}

export interface GoldFigure {
  value: number;
  unit: string;
  /** The rounding the source shows. */
  tolerance: number;
}

export interface GoldDecoy {
  document: string;
  pages: [number, number];
  quote: string;
  value: number;
  unit: string;
}

export interface CitationQuestion {
  id: string;
  kind: QuestionKind;
  /** The language the Question is asked in. */
  language: "en" | "zh";
  /** Asked in one language about Documents in the other. */
  crossLingual: boolean;
  /** The Documents the Question is about. */
  about: string[];
  question: string;
  answer: string;
  quotes: GoldQuote[];
  figures?: GoldFigure[];
  /** A superseded figure a right answer must not give. */
  decoy?: GoldDecoy;
  /** The day a second reader checked this answer against the Documents' text. */
  checked: string;
}

export interface CitationSet {
  documents: CitationDocument[];
  questions: CitationQuestion[];
}

export interface CheckReport {
  documents: number;
  questions: number;
  kinds: Record<string, number>;
  languages: Record<string, number>;
  crossLingual: number;
  quotes: number;
  decoyQuotes: number;
  figures: number;
  secondReaderChecked: number;
  failures: string[];
}

const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function parseQuestions(text: string, fail: (message: string) => void): CitationQuestion[] {
  const questions: CitationQuestion[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      questions.push(JSON.parse(line) as CitationQuestion);
    } catch (error) {
      fail(`questions.jsonl line ${index + 1} isn't JSON: ${String(error)}`);
    }
  }
  return questions;
}

export async function loadCitationSet(root: string): Promise<CitationSet> {
  const documents = (
    JSON.parse(await readFile(join(root, CITATION_DOCUMENTS), "utf8")) as {
      documents: CitationDocument[];
    }
  ).documents;
  const questions = parseQuestions(await readFile(join(root, CITATION_SET), "utf8"), (message) => {
    throw new Error(message);
  });
  return { documents, questions };
}

interface StoredUnits {
  outcome: string;
  units: PageText[];
}

function quoteFailure(
  units: PageText[],
  pages: [number, number],
  quote: string,
  label: string,
): string | null {
  const [from, to] = pages;
  const expected = units.filter(
    (unit) => unit.page !== null && unit.page >= from && unit.page <= to,
  );
  if (expected.length !== to - from + 1) {
    return `${label}: its Locations ${from}-${to} aren't all Units of the Document`;
  }
  if (expected.length > 2) return `${label}: a Citation names at most two Units`;
  if (expected.length === 2) {
    const [first, second] = expected;
    if (!first || !second || !sameRun(first, second)) {
      return `${label}: its two Units aren't consecutive`;
    }
  }
  if (quoteInUnits(expected, quote) === null) {
    return `${label}: the quote isn't at its Location`;
  }
  const joined = normaliseText(expected.map((unit) => unit.text).join("\n\n"));
  if (!joined.includes(normaliseText(quote))) {
    return `${label}: the quote isn't verbatim at its Location`;
  }
  for (const unit of units.filter((each) => !expected.includes(each))) {
    if (quoteInUnits([unit], quote, {}) !== null) {
      return `${label}: the quote is also on Unit ${unit.page}`;
    }
  }
  return null;
}

function numberFailure(figure: GoldFigure, quotes: GoldQuote[], label: string): string | null {
  if (!Number.isFinite(figure.value)) return `${label}: a figure has no value`;
  if (typeof figure.unit !== "string" || !figure.unit) return `${label}: a figure has no unit`;
  if (!(figure.tolerance >= 0)) return `${label}: a figure has no tolerance`;
  // The direction is in the words ("fell", "下降"); a quote's digits are compared as magnitudes.
  const wanted = Math.abs(figure.value);
  for (const quote of quotes) {
    for (const match of quote.quote.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const found = Number.parseFloat(match[0].replaceAll(",", ""));
      if (Number.isFinite(found) && Math.abs(Math.abs(found) - wanted) <= figure.tolerance) {
        return null;
      }
    }
  }
  return `${label}: ${figure.value} ${figure.unit} isn't written in any of its quotes`;
}

export async function checkCitationSet(root: string): Promise<CheckReport> {
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);
  const { documents, questions } = await loadCitationSet(root);
  const byKey = new Map(documents.map((document) => [document.key, document]));
  const kinds: Record<string, number> = {};
  const languages: Record<string, number> = { en: 0, zh: 0 };
  let crossLingual = 0;
  let quotes = 0;
  let decoyQuotes = 0;
  let figures = 0;
  let secondReaderChecked = 0;

  if (documents.length < 12) fail(`the set has ${documents.length} Documents, fewer than 12`);
  for (const document of documents) {
    if (!document.key) fail(`${document.path}: no key`);
    if (!document.publisher) fail(`${document.key}: no publisher`);
    if (!document.source.startsWith("https://")) fail(`${document.key}: no https source`);
    if (!document.licence) fail(`${document.key}: no licence`);
    if (!date(document.licenceRead)) fail(`${document.key}: no licence date read`);
    if (!date(document.retrieved)) fail(`${document.key}: no retrieval date`);
    if (document.basis.length < 20) fail(`${document.key}: no basis in the licence's words`);
    if (!/^[0-9a-f]{64}$/.test(document.sha256)) fail(`${document.key}: no SHA-256`);
    const bytes = await readFile(join(root, document.path));
    if (sha256(bytes) !== document.sha256)
      fail(`${document.key}: its SHA-256 differs from the file`);
    if (document.language !== "en" && document.language !== "zh") {
      fail(`${document.key}: unknown language`);
    }
  }

  const stored = new Map<string, StoredUnits>();
  for (const document of documents) {
    const result = await processFile({
      task: "process",
      documentId: document.key,
      kind: "pdf",
      file: join(root, document.path),
    });
    if (result.outcome !== "ready") {
      // The one page without a text layer is part of the library and none of the gold rests on it.
      stored.set(document.key, { outcome: result.outcome, units: [] });
      if (
        questions.some((question) =>
          question.quotes.some((quote) => quote.document === document.key),
        )
      ) {
        fail(`${document.key}: it has no text, but a gold quote cites it`);
      }
      continue;
    }
    const units = result.pages;
    if (units.length !== document.pages) {
      fail(
        `${document.key}: listed with ${document.pages} pages, processing reads ${units.length}`,
      );
    }
    stored.set(document.key, { outcome: result.outcome, units });
  }

  const ids = new Set<string>();
  for (const question of questions) {
    const label = `question ${question.id ?? "(no id)"}`;
    if (!question.id || ids.has(question.id)) fail(`${label}: its id is missing or doubled`);
    ids.add(question.id);
    if (!QUESTION_KINDS.includes(question.kind)) fail(`${label}: unknown kind ${question.kind}`);
    kinds[question.kind] = (kinds[question.kind] ?? 0) + 1;
    if (question.language !== "en" && question.language !== "zh") {
      fail(`${label}: unknown language`);
    } else {
      languages[question.language] = (languages[question.language] ?? 0) + 1;
      if (!question.id?.startsWith(`${question.language}-`)) {
        fail(`${label}: its id doesn't start with its language`);
      }
    }
    if (typeof question.crossLingual !== "boolean") fail(`${label}: crossLingual isn't a boolean`);
    if (question.crossLingual) crossLingual += 1;
    if (!question.question?.trim()) fail(`${label}: no question text`);
    if (!question.answer?.trim()) fail(`${label}: no answer`);
    if (!date(question.checked)) fail(`${label}: no day a second reader checked it`);
    else secondReaderChecked += 1;
    if (!Array.isArray(question.about) || question.about.length === 0) {
      fail(`${label}: names no Document`);
    } else {
      for (const key of question.about) {
        if (!byKey.has(key)) fail(`${label}: unknown Document ${key}`);
      }
      const languagesAbout = new Set(question.about.map((key) => byKey.get(key)?.language));
      if (question.crossLingual && languagesAbout.has(question.language)) {
        fail(`${label}: it is cross-lingual but asks about a Document in its own language`);
      }
      if (!question.crossLingual && !languagesAbout.has(question.language)) {
        fail(`${label}: it isn't cross-lingual but no Document is in its language`);
      }
    }
    if (!Array.isArray(question.quotes)) fail(`${label}: quotes isn't a list`);
    const locations = new Set<string>();
    for (const [index, quote] of (question.quotes ?? []).entries()) {
      const quoteLabel = `${label} quote ${index + 1}`;
      const document = byKey.get(quote.document);
      if (!document) {
        fail(`${quoteLabel}: unknown Document ${quote.document}`);
        continue;
      }
      if (!Array.isArray(quote.pages) || quote.pages.length !== 2) {
        fail(`${quoteLabel}: pages must be [first, last]`);
        continue;
      }
      if (!(question.about ?? []).includes(quote.document)) {
        fail(`${quoteLabel}: its Document isn't among the Question's Documents`);
      }
      const reading = stored.get(quote.document);
      if (!reading) continue;
      const failure = quoteFailure(reading.units, quote.pages, quote.quote, quoteLabel);
      if (failure) fail(failure);
      quotes += 1;
      locations.add(`${quote.document}:${quote.pages[0]}-${quote.pages[1]}`);
    }
    const goldQuotes = question.quotes ?? [];
    if (question.kind === "absent") {
      if (goldQuotes.length > 0) fail(`${label}: an absent Question names a quote`);
      if (question.figures !== undefined) fail(`${label}: an absent Question gives a figure`);
    } else if (goldQuotes.length === 0) {
      fail(`${label}: no gold quote`);
    }
    if (question.kind === "multi-passage" && locations.size < 2) {
      fail(`${label}: a multi-passage answer cites fewer than two Locations`);
    }
    if (question.kind === "conflict") {
      if (locations.size < 2) fail(`${label}: a conflict answer cites fewer than two Locations`);
    }
    if (question.kind === "superseded") {
      if (!question.decoy) fail(`${label}: a superseded Question has no decoy`);
      else {
        const decoy = question.decoy;
        const document = byKey.get(decoy.document);
        if (!document) fail(`${label} decoy: unknown Document ${decoy.document}`);
        else {
          const reading = stored.get(decoy.document);
          if (reading) {
            const failure = quoteFailure(reading.units, decoy.pages, decoy.quote, `${label} decoy`);
            if (failure) fail(failure);
            decoyQuotes += 1;
          }
        }
        if ((question.figures ?? []).some((figure) => figure.value === decoy.value)) {
          fail(`${label}: its decoy and its answer give the same value`);
        }
      }
    }
    if (["table-figure", "calculated", "superseded"].includes(question.kind)) {
      if (!question.figures?.length) fail(`${label}: no figure`);
    }
    for (const [index, figure] of (question.figures ?? []).entries()) {
      figures += 1;
      if (question.kind === "calculated") continue;
      const failure = numberFailure(figure, goldQuotes, `${label} figure ${index + 1}`);
      if (failure) fail(failure);
    }
  }

  for (const kind of QUESTION_KINDS) {
    const count = kinds[kind] ?? 0;
    if (count !== KIND_COUNTS[kind]) fail(`${kind}: ${count} Questions, not ${KIND_COUNTS[kind]}`);
  }
  if (questions.length !== 150) fail(`${questions.length} Questions, not 150`);
  for (const language of ["en", "zh"] as const) {
    if (languages[language] !== 75) fail(`${languages[language]} ${language} Questions, not 75`);
  }
  if (crossLingual !== 15) fail(`${crossLingual} cross-lingual Questions, not 15`);
  const withoutSecondReader = questions.length - secondReaderChecked;
  if (withoutSecondReader > 0) fail(`${withoutSecondReader} Questions have no second-reader day`);

  return {
    documents: documents.length,
    questions: questions.length,
    kinds,
    languages,
    crossLingual,
    quotes,
    decoyQuotes,
    figures,
    secondReaderChecked,
    failures,
  };
}
