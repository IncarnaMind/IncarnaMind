/**
 * How an evaluation's Answers came by their Citations (#3059), counted from the citing records
 * (./citingRecord) its run files keep, by model and language. Of the Answers with a marker the
 * model gave no record for: how many the app asked about once more (a Citation came of it, none
 * did, or no reply came), how many it matched by itself, and how many neither (no request went out,
 * the Answer's asks or room being used up, and the marker just went). Then, for each way a Citation
 * came, how many of them the Answer's own check judged and how many it passed. Last, of the app's
 * own matches on a marked sentence, those under a list number that differs from its Document line's,
 * and those where a list number starts one side only and a number follows it, each judged and passed.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/tsResolve.mjs eval/lib/citingCount.ts <run file or folder>…
 *
 * A held-out set's folder or a gate's is never read: it is left out by its name, before anything
 * in it is opened, and the script names what it left out. A run's own results folder
 * (`eval/results/<start>-everyday`, `speed-<start>`) is named neither way.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CitationOrigin, CitingRecord } from "./citingRecord";

/** Folders and files no count may read: every held-out set, and every gate's. Wide on purpose. */
const HELD_OUT: readonly RegExp[] = [/held/i, /gate/i];

export const heldOut = (path: string): boolean =>
  path.split(/[\\/]/).some((part) => HELD_OUT.some((pattern) => pattern.test(part)));

/** The JSON files under `paths`, never one held out, and what was left out by its name. */
export function runFiles(paths: readonly string[]): { files: string[]; leftOut: string[] } {
  const files: string[] = [];
  const leftOut: string[] = [];
  const visit = (path: string) => {
    if (heldOut(path)) {
      leftOut.push(path);
      return;
    }
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (path.endsWith(".json")) {
      files.push(path);
    }
  };
  for (const path of paths) visit(path);
  return { files, leftOut };
}

export interface CitedAnswer {
  model: string;
  language: string;
  citing: CitingRecord;
}

const isCitingRecord = (value: unknown): value is CitingRecord =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as CitingRecord).written) &&
  Array.isArray((value as CitingRecord).citations) &&
  Array.isArray((value as CitingRecord).unrecorded);

/** Every Answer's citing record in a run file, wherever it sits, with the model and language of the nearest object naming them. */
export function citedAnswers(value: unknown): CitedAnswer[] {
  const found: CitedAnswer[] = [];
  const visit = (node: unknown, model: string, language: string) => {
    if (Array.isArray(node)) {
      for (const each of node) visit(each, model, language);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const named = node as Record<string, unknown>;
    const here = {
      model: typeof named.model === "string" ? named.model : model,
      language: typeof named.language === "string" ? named.language : language,
    };
    if (isCitingRecord(named.citing)) found.push({ ...here, citing: named.citing });
    for (const [key, child] of Object.entries(named)) {
      if (key !== "citing") visit(child, here.model, here.language);
    }
  };
  visit(value, "unknown", "unknown");
  return found;
}

const ORIGINS: readonly CitationOrigin[] = [
  "model",
  "request",
  "app-marked",
  "app-unmarked",
  "figure",
];

/** Citations, how many of them the Answer's own check judged, and how many it passed. */
export interface Tally {
  citations: number;
  judged: number;
  passed: number;
}

export interface CitingCounts {
  model: string;
  language: string;
  answers: number;
  /** Answers whose last reply wrote a marker the model gave no record for: asked + matchedByApp + neither. */
  unrecorded: number;
  /** Of those, the app asked once more for Citations… */
  asked: number;
  /** …and a Citation came of the request… */
  askedGiven: number;
  /** …or the reply came and none did… */
  askedNone: number;
  /** …or no reply came. */
  askedFailed: number;
  /** Of those, no request went out and the app's own match stands on such a sentence. */
  matchedByApp: number;
  /** Of those, no request went out and no Citation of the app's stands on such a sentence. */
  neither: number;
  /** Answers the app asked about with no such marker: an Answer with no Citation at all. */
  askedWithoutMarker: number;
  /** For each way a Citation came: how many, how many the Answer's own check judged, how many it passed. */
  origins: Record<CitationOrigin, Tally>;
  /**
   * Of the app's own matches on a marked sentence: those whose sentence and Document line both start
   * with a list number and the two differ; those where a list number starts one side only and a
   * number follows it; and how many the record can't place (no line holds the marker or the quote).
   */
  listNumbers: { differing: Tally; oneSided: Tally; unplaced: number };
}

type Citation = CitingRecord["citations"][number];

const judgedBy = (citation: Citation) =>
  citation.judged || citation.check === "unsupported" || citation.check === "contradicted";

const tallied = (): Tally => ({ citations: 0, judged: 0, passed: 0 });

function tally(into: Tally, citation: Citation): void {
  into.citations++;
  if (!judgedBy(citation)) return;
  into.judged++;
  if (citation.check === "found") into.passed++;
}

/**
 * A list's number at a line's start, in every form the citing step's readers see: "2. ", "- 2. ",
 * "2." with no space, "2．", "**2.** ", "**2.**", "(2)", "2)", "2、". The Document's reader cuts the
 * first six off before the numbers are compared and the Answer's only "2. " and "- 2. " (#3065), so
 * a number in those forms can't stop the app's match. A figure ("2.5 million") isn't one.
 */
const LIST_NUMBER =
  /^\s*(?:[-*+•]\s+)?(?:\*\*)?(?:[(（](\d{1,3})[)）]|(\d{1,3})(?:[)）、]|[.．](?![\d.])))(?:\*\*)?\s*/u;

/** The list number a line starts with, and what follows it; null when it starts with none. */
function listNumberOf(line: string): { number: number; rest: string } | null {
  const found = LIST_NUMBER.exec(line);
  if (!found) return null;
  return { number: Number(found[1] ?? found[2]), rest: line.slice(found[0].length) };
}

const comparable = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The line of the Answer, as the citing step read it, that holds the Citation's marker, and the
 * line of its Document's Passages that holds its quote; null when the record lacks either.
 */
function linesOf(citing: CitingRecord, citation: Citation): [string, string] | null {
  const answer = citing.asked?.answer ?? citing.written.at(-1) ?? "";
  const sentence = answer.split("\n").find((line) => line.includes(`[^${citation.marker}]`));
  const quote = comparable(citation.quote);
  const own = citing.passages.filter((passage) => passage.document === citation.document);
  const line = quote
    ? (own.length > 0 ? own : citing.passages)
        .flatMap((passage) => passage.text.split("\n"))
        .find((each) => comparable(each).includes(quote))
    : undefined;
  return sentence !== undefined && line !== undefined ? [sentence, line] : null;
}

function countListNumbers(
  into: CitingCounts["listNumbers"],
  citing: CitingRecord,
  citation: Citation,
): void {
  const lines = linesOf(citing, citation);
  if (!lines) {
    into.unplaced++;
    return;
  }
  const [answer, document] = lines.map(listNumberOf);
  if (answer && document) {
    if (answer.number !== document.number) tally(into.differing, citation);
    return;
  }
  const one = answer ?? document;
  if (one && /^\d/.test(one.rest)) tally(into.oneSided, citation);
}

export function countCiting(answers: readonly CitedAnswer[]): CitingCounts[] {
  const groups = new Map<string, CitingCounts>();
  for (const { model, language, citing } of answers) {
    const key = `${model}\n${language}`;
    const group = groups.get(key) ?? {
      model,
      language,
      answers: 0,
      unrecorded: 0,
      asked: 0,
      askedGiven: 0,
      askedNone: 0,
      askedFailed: 0,
      matchedByApp: 0,
      neither: 0,
      askedWithoutMarker: 0,
      origins: Object.fromEntries(
        ORIGINS.map((origin) => [origin, tallied()]),
      ) as CitingCounts["origins"],
      listNumbers: { differing: tallied(), oneSided: tallied(), unplaced: 0 },
    };
    group.answers++;
    const came = (from: CitationOrigin) => citing.citations.some((each) => each.from === from);
    if (citing.unrecorded.length > 0) {
      group.unrecorded++;
      if (citing.asked !== null) {
        group.asked++;
        if (citing.asked.failed) group.askedFailed++;
        else if (came("request")) group.askedGiven++;
        else group.askedNone++;
      } else if (came("app-marked")) {
        group.matchedByApp++;
      } else {
        group.neither++;
      }
    } else if (citing.asked !== null) {
      group.askedWithoutMarker++;
    }
    for (const citation of citing.citations) {
      tally(group.origins[citation.from], citation);
      if (citation.from === "app-marked") countListNumbers(group.listNumbers, citing, citation);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) => a.model.localeCompare(b.model) || a.language.localeCompare(b.language),
  );
}

/** The counts as lines of numbers, a table a group. */
export function citingLines(counts: readonly CitingCounts[]): string[] {
  return counts.flatMap((group) => [
    `${group.model} · ${group.language}: ${group.answers} Answers`,
    `  with a marker that has no record: ${group.unrecorded}; asked ${group.asked} (a Citation came ${group.askedGiven}, none ${group.askedNone}, no reply ${group.askedFailed}); matched by the app ${group.matchedByApp}; neither ${group.neither}`,
    `  asked with no such marker: ${group.askedWithoutMarker}`,
    ...ORIGINS.map((origin) => {
      const { citations, judged, passed } = group.origins[origin];
      return `  ${origin}: ${citations} Citations, ${judged} judged, ${passed} passed`;
    }),
    `  app-marked under a list number that differs from its Document line's: ${tallyText(group.listNumbers.differing)}`,
    `  app-marked with a list number on one side only, a number after it: ${tallyText(group.listNumbers.oneSided)}`,
    `  app-marked the record can't place: ${group.listNumbers.unplaced}`,
  ]);
}

const tallyText = ({ citations, judged, passed }: Tally) =>
  `${citations}, ${judged} judged, ${passed} passed`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Give the run files or folders to count.");
    process.exit(1);
  }
  const { files, leftOut } = runFiles(paths);
  const answers = files.flatMap((file) => citedAnswers(JSON.parse(readFileSync(file, "utf8"))));
  console.log(citingLines(countCiting(answers)).join("\n"));
  if (answers.length === 0) console.log(`No citing records in ${files.length} run files.`);
  if (leftOut.length > 0) {
    console.log(`Left out by name (a held-out set's or a gate's): ${leftOut.join(", ")}`);
  }
}
