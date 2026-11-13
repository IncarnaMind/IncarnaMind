/**
 * How an evaluation's Answers came by their Citations (#3059), counted from the citing records
 * (./citingRecord) its run files keep, by model and language. Of the Answers with a marker the
 * model gave no record for: how many the app asked about once more (a Citation came of it, none
 * did, or no reply came), how many it matched by itself, and how many neither (no request went out,
 * the Answer's asks or room being used up, and the marker just went). Then, for each way a Citation
 * came, how many of them the Answer's own check judged and how many it passed.
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
  origins: Record<CitationOrigin, { citations: number; judged: number; passed: number }>;
}

const judgedBy = (citation: CitingRecord["citations"][number]) =>
  citation.judged || citation.check === "unsupported" || citation.check === "contradicted";

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
        ORIGINS.map((origin) => [origin, { citations: 0, judged: 0, passed: 0 }]),
      ) as CitingCounts["origins"],
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
      const origin = group.origins[citation.from];
      origin.citations++;
      if (!judgedBy(citation)) continue;
      origin.judged++;
      if (citation.check === "found") origin.passed++;
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
  ]);
}

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
