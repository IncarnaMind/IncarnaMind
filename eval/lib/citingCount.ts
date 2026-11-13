/**
 * How an evaluation's Answers came by their Citations (#3059), counted from the citing records
 * (./citingRecord) its run files keep, by model and language. Of the Answers with a marker the
 * model gave no record for: how many the app asked about once more (a Citation came of it, none
 * did, or no reply came), how many it matched by itself, and how many neither (no request went out,
 * the Answer's asks or room being used up, and the marker just went). Then, for each way a Citation
 * came, how many of them the Answer's own check judged and how many it passed. Last, of the app's
 * own matches on a marked sentence, those whose sentence sits under a list number that differs from
 * the one its quote sits under, and those where one side sits under a list number and a number
 * follows it, each judged and passed; a sentence or quote that only shares a line with a list
 * number is counted apart.
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
import { answerSentences, withoutMarkerRuns } from "../../src/shared/answerSentences";
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
   * Of the app's own matches on a marked sentence: those whose sentence and quote each sit under a
   * list number of their own and the two differ; those where one of them sits under one and a number
   * follows it; those where either only shares a line with a list number; and those the record
   * can't place (no sentence holds the marker or no line the quote, or more than one would count
   * differently).
   */
  listNumbers: { differing: Tally; oneSided: Tally; sharesLine: Tally; unplaced: number };
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
 * A list's number at the start of a line or a sentence, in every form the citing step's readers
 * see: "2. ", "- 2. ", "2." with no space, "2．", "**2.** ", "**2.**", "(2)", "2)", "2、". The
 * Document's reader cuts the first six off before the numbers are compared and the Answer's only
 * "2. " and "- 2. " (#3065), so a number in those forms can't stop the app's match. A figure
 * ("2.5 million") isn't one.
 */
const LIST_NUMBER =
  /^\s*(?:[-*+•]\s+)?(?:\*\*)?(?:[(（](\d{1,3})[)）]|(\d{1,3})(?:[)）、]|[.．](?![\d.])))(?:\*\*)?\s*/u;

/** The list number `text` starts with, and what follows it; null when it starts with none. */
function listNumberOf(text: string): { number: number; rest: string } | null {
  const found = LIST_NUMBER.exec(text);
  if (!found) return null;
  return { number: Number(found[1] ?? found[2]), rest: text.slice(found[0].length) };
}

const comparable = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Where a matched sentence, or the Document's words it quotes, sits: under a list number of its
 * own, on a line whose list number starts another sentence, or on a line with none.
 */
type Place = { number: number; rest: string } | "shares" | "none";

const placeKey = (place: Place) =>
  typeof place === "string" ? place : `${place.number}:${/^\d/.test(place.rest.trimStart())}`;

/** The one place all of `places` agree on; null when there is none, or they would count differently. */
function onePlace(places: readonly Place[]): Place | null {
  const [first] = places;
  if (first === undefined) return null;
  return places.every((place) => placeKey(place) === placeKey(first)) ? first : null;
}

const lineAround = (text: string, at: number) => {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const end = text.indexOf("\n", at);
  return { start, line: text.slice(start, end < 0 ? text.length : end) };
};

/**
 * Each sentence of the Answer, as the citing step read and split it, that holds the Citation's
 * marker. The Answer's reader splits "3. " and "- 3. " off as a sentence of its own, so a sentence's
 * own number is at its start or in the number alone just before it on its line.
 */
function answerPlaces(citing: CitingRecord, marker: number): Place[] {
  const text = citing.asked?.answer ?? citing.written.at(-1) ?? "";
  const sentences = answerSentences(text);
  const words = (at: number) => withoutMarkerRuns(sentences[at]?.text ?? "").trim();
  return sentences.flatMap((sentence, holding): Place[] => {
    if (!sentence.markers.includes(marker)) return [];
    // A marker alone after its sentence's stop belongs to that sentence, as the record reads it.
    const at = words(holding) !== "" ? holding : holding - 1;
    const said = sentences[at];
    if (!said) return [];
    const own = listNumberOf(words(at));
    if (own && own.rest.trim() !== "") return [own];
    const { start, line } = lineAround(text, said.start);
    const before = sentences[at - 1];
    const alone = before && before.start >= start ? listNumberOf(words(at - 1)) : null;
    if (alone && alone.rest.trim() === "") return [{ number: alone.number, rest: words(at) }];
    return [listNumberOf(line) ? "shares" : "none"];
  });
}

/**
 * Each line of the cited Document's Passages that holds the Citation's quote: under its list number
 * only when the quote is what follows that number.
 */
function documentPlaces(citing: CitingRecord, citation: Citation): Place[] {
  // A quote of "**2.** …" taken after its number was cut starts with the bold's closing "**".
  const quote = comparable(citation.quote).replace(/^\*+\s*/, "");
  if (quote === "") return [];
  const own = citing.passages.filter((passage) => passage.document === citation.document);
  return (own.length > 0 ? own : citing.passages)
    .flatMap((passage) => passage.text.split("\n"))
    .filter((line) => comparable(line).includes(quote))
    .map((line): Place => {
      const found = listNumberOf(line);
      if (!found) return "none";
      const after = comparable(found.rest);
      return after.startsWith(quote) || comparable(line).startsWith(quote) ? found : "shares";
    });
}

function countListNumbers(
  into: CitingCounts["listNumbers"],
  citing: CitingRecord,
  citation: Citation,
): void {
  const answer = onePlace(answerPlaces(citing, citation.marker));
  const document = onePlace(documentPlaces(citing, citation));
  if (answer === null || document === null) {
    into.unplaced++;
    return;
  }
  if (answer === "shares" || document === "shares") {
    tally(into.sharesLine, citation);
    return;
  }
  if (answer !== "none" && document !== "none") {
    if (answer.number !== document.number) tally(into.differing, citation);
    return;
  }
  const one = answer !== "none" ? answer : document !== "none" ? document : null;
  if (one && /^\d/.test(one.rest.trimStart())) tally(into.oneSided, citation);
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
      listNumbers: {
        differing: tallied(),
        oneSided: tallied(),
        sharesLine: tallied(),
        unplaced: 0,
      },
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
    `  app-marked whose sentence sits under a list number that differs from its quote's: ${tallyText(group.listNumbers.differing)}`,
    `  app-marked with a list number on one side only, a number after it: ${tallyText(group.listNumbers.oneSided)}`,
    `  app-marked whose sentence or quote only shares a line with a list number: ${tallyText(group.listNumbers.sharesLine)}`,
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
