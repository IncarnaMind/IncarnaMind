/**
 * A run of the citation benchmark: one model's Answers to the Questions asked
 * in one language, as JSON, with every Citation, its Location and the app's
 * check of it, the check of each sentence, the model and its settings, and the
 * tokens, cost and time of each Answer. The file is written again once an
 * Answer ends, once its Note is checked, and, for a model with a price, after
 * every request, so a run that stops is resumed from it without asking again
 * or losing what it spent.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CitationCheck, CitationCheckReason, ProviderErrorKind } from "../../src/core";
import type { Price } from "../../src/core/providers/catalog/types";
import type { Tokens } from "../minds/record";
import type { Outcome as SentenceOutcome } from "../repeats/repeat";
import { CITATION_DOCUMENTS, CITATION_SET, type QuestionKind } from "./checkSet";

export type Language = "en" | "zh";
export const LANGUAGES: readonly Language[] = ["en", "zh"];

export { noTokens, type Tokens } from "../minds/record";

export interface RunCitation {
  /** The Answer's sentence the Citation is anchored in, without its markers. */
  sentence: string;
  quote: string;
  /** The set's key of the cited Document; null when the Citation names none of the set's. */
  document: string | null;
  documentName: string;
  pageFrom: number | null;
  pageTo: number | null;
  /** The app's Citation check, as the Citation's card shows it. */
  check: CitationCheck;
  checkReason: CitationCheckReason | null;
  /** The Passage the Citation names, as the app stored it, for the judges. */
  passageText: string | null;
  passagePages: [number, number] | null;
}

/** One sentence's result from the app's check of the Answer's Note (Check this Note). */
export interface SentenceCheck {
  sentence: string;
  outcome: SentenceOutcome;
  says: string | null;
  quote: string | null;
  failure: string | null;
}

export type CheckRun =
  | { kind: "checked"; sentences: SentenceCheck[] }
  | { kind: "failed"; reason: string }
  | { kind: "off" };

export interface RunAnswer {
  questionId: string;
  kind: QuestionKind;
  crossLingual: boolean;
  question: string;
  askedAt: string;
  status: "done" | "stopped" | "failed" | "timed-out";
  error: { kind: ProviderErrorKind; message: string } | null;
  /** The Answer as the Note shows it: a paragraph per block, each Citation as its marker. */
  text: string;
  sentences: { text: string; cited: boolean }[];
  citations: RunCitation[];
  /** Calculated figures, as the Answer shows them. */
  figures: { marker: number; label: string; shown: string }[];
  searches: string[];
  check: CheckRun;
  tokens: { answer: Tokens; check: Tokens };
  /** In US dollars at the catalog's price; null for a model with none (on this computer). */
  usd: { answer: number | null; check: number | null };
  seconds: { answer: number; check: number };
}

export interface RunModel {
  kind: string;
  modelId: string;
  endpoint: string | null;
  /**
   * The SHA-256 of the server address the run was given, so a run resumes only
   * on the same server without publishing the address; null for none.
   */
  server?: string | null;
  /** Where the Questions went, e.g. "Anthropic"; null for a model on this computer. */
  service: string | null;
  /** "anthropic/claude-sonnet-5-5": how the results name it. */
  label: string;
}

export interface RunSettings {
  /** Whether each Answer's Note was checked as Check this Note checks it. */
  check: boolean;
  answerTimeoutMs: number;
  rerankDepth: number | "off" | null;
  maxPassages: number | null;
  numCtx: number | null;
  citing: string | null;
  /** The catalog's price the cost is worked out at; null for none. */
  price: Price | null;
}

export interface CitationsRun {
  benchmark: "IncarnaMind citation benchmark";
  /** The set the run answered: its version and the SHA-256 of its two files. */
  set: { version: number; questions: string; documents: string };
  model: RunModel;
  language: Language;
  settings: RunSettings;
  app: { version: string; commit: string };
  host: { platform: string; cpu: string; node: string };
  startedAt: string;
  updatedAt: string;
  /** The Documents as this run's library read them; `pagesSha256` hashes their stored text. */
  documents: { key: string; name: string; status: string; pages: number; pagesSha256: string }[];
  answers: RunAnswer[];
  /**
   * What the Answers that failed and were asked again had cost, and the work
   * a stopped run left unfinished, in US dollars.
   */
  retriedUsd: number;
  /** The Question being answered or checked when the file was written, and what its requests had cost so far. */
  inProgress?: { questionId: string; usd: number } | null;
  /** Why the run stopped before its last Question; null when it didn't. */
  stopped: { reason: string; at: string } | null;
}

export const sha256 = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");

/** The set's version and the hashes of its files, which a run records and a resume compares. */
export function setIdentity(root: string): CitationsRun["set"] {
  const documents = readFileSync(join(root, CITATION_DOCUMENTS), "utf8");
  return {
    version: (JSON.parse(documents) as { version: number }).version,
    questions: sha256(readFileSync(join(root, CITATION_SET))),
    documents: sha256(documents),
  };
}

/** "anthropic/claude-sonnet-5-5" as a file name: "anthropic-claude-sonnet-5-5". */
export const modelSlug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const runFileName = (label: string, language: Language) =>
  `${modelSlug(label)}.${language}.json`;

export function readRun(path: string): CitationsRun | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as CitationsRun;
}

/** Written beside, then moved over, so a run stopped mid-write keeps its last whole file. */
export function writeRun(path: string, run: CitationsRun): void {
  const next = `${path}.writing`;
  writeFileSync(next, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(next, path);
}

/** Every run file in a folder, by its name. */
export function runFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => /\.(?:en|zh)\.json$/.test(name))
    .sort();
}

/** Why a run file can't be resumed with this model, set, settings and commit; null when it can. */
export function resumeProblem(
  run: CitationsRun,
  wanted: Pick<CitationsRun, "set" | "model" | "language" | "settings" | "app">,
): string | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(run.set, wanted.set)) return "it answered another version of the set";
  if (run.model.label !== wanted.model.label || run.model.endpoint !== wanted.model.endpoint)
    return `it is ${run.model.label}'s`;
  if ((run.model.server ?? null) !== (wanted.model.server ?? null)) {
    return "it was asked of another server";
  }
  if (run.language !== wanted.language) return `it is in ${run.language}`;
  const { price: _price, ...settings } = run.settings;
  const { price: _wanted, ...wantedSettings } = wanted.settings;
  if (!same(settings, wantedSettings)) return "it was made with other settings";
  if (run.app.commit !== wanted.app.commit) return `it was made at commit ${run.app.commit}`;
  return null;
}

/**
 * The Answers a resumed run keeps: every one that finished, stopped or ran out
 * of time, since those were paid for. A failed one is asked again.
 */
export const keptAnswers = (run: CitationsRun): RunAnswer[] =>
  run.answers.filter((answer) => answer.status !== "failed");

export const answerUsd = (answer: Pick<RunAnswer, "usd">): number =>
  (answer.usd.answer ?? 0) + (answer.usd.check ?? 0);

/** What a run has cost so far, in US dollars, the attempts asked again and the unfinished work included. */
export const spentUsd = (
  run: Pick<CitationsRun, "answers" | "retriedUsd" | "inProgress">,
): number =>
  run.answers.reduce(
    (sum, answer) => sum + answerUsd(answer),
    run.retriedUsd + (run.inProgress?.usd ?? 0),
  );
