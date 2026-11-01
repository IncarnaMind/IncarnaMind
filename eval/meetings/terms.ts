/**
 * How a transcriber does on the words it was told (#1031, eval/meetings/README.md, Words to know):
 * the error rate of those words where they are said, and of everything else, each from one
 * alignment of the reference with the hypothesis (as B-WER and U-WER are in the contextual
 * biasing literature); and how often a word it was told but nobody said was written anyway.
 *
 * The alignment is made in windows of two minutes of the reference, each with the hypothesis
 * lines that start in it, so that an hour's meeting needs no alignment of all its units at once.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { characters, words } from "../transcription/scoring";
import type { Hypothesis, Language, Reference } from "./types";

export const wordsFile = join(dirname(fileURLToPath(import.meta.url)), "words.json");

/** words.json (./pickWords): each case's words, said in it and not, and as it is told them. */
export interface CaseWords {
  said: string[];
  notSaid: string[];
  told: string[];
}

export async function readWords(): Promise<Record<string, CaseWords>> {
  return (JSON.parse(await readFile(wordsFile, "utf8")) as { words: Record<string, CaseWords> })
    .words;
}

const WINDOW_SECONDS = 120;

export interface TermScore {
  /** The told words' occurrences in the reference, and those not written exactly there. */
  occurrences: number;
  wrong: number;
  /** Errors over the reference's other units. */
  others: { errors: number; total: number };
  /** Words told and never said that the hypothesis writes, counted per time written. */
  unsaid: number;
}

const splitterOf = (language: Language) => (language === "en" ? words : characters);

type Step = "match" | "substitution" | "deletion" | "insertion";

/** The edits that turn `hypothesis` into `reference`, in order, fewest first as Levenshtein counts them. */
function align(reference: readonly string[], hypothesis: readonly string[]): Step[] {
  const n = reference.length;
  const m = hypothesis.length;
  const cost = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 0; i <= n; i++) cost[at(i, 0)] = i;
  for (let j = 0; j <= m; j++) cost[at(0, j)] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
      cost[at(i, j)] = Math.min(
        (cost[at(i - 1, j - 1)] as number) + same,
        (cost[at(i - 1, j)] as number) + 1,
        (cost[at(i, j - 1)] as number) + 1,
      );
    }
  }
  const steps: Step[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = cost[at(i, j)] as number;
    if (i > 0 && j > 0) {
      const same = reference[i - 1] === hypothesis[j - 1];
      if (here === (cost[at(i - 1, j - 1)] as number) + (same ? 0 : 1)) {
        steps.push(same ? "match" : "substitution");
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && here === (cost[at(i - 1, j)] as number) + 1) {
      steps.push("deletion");
      i--;
    } else {
      steps.push("insertion");
      j--;
    }
  }
  return steps.reverse();
}

/** Where each term's units are in `units`, longest terms first, none overlapping: [first, last]. */
function spansOf(
  units: readonly string[],
  terms: readonly (readonly string[])[],
): [number, number][] {
  const taken = new Uint8Array(units.length);
  const spans: [number, number][] = [];
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (term.length === 0) continue;
    for (let start = 0; start + term.length <= units.length; start++) {
      let found = true;
      for (let k = 0; k < term.length; k++) {
        if (taken[start + k] || units[start + k] !== term[k]) {
          found = false;
          break;
        }
      }
      if (!found) continue;
      for (let k = 0; k < term.length; k++) taken[start + k] = 1;
      spans.push([start, start + term.length - 1]);
    }
  }
  return spans;
}

export function scoreTerms(
  language: Language,
  reference: Reference,
  hypothesis: Hypothesis,
  told: { said: readonly string[]; notSaid: readonly string[] },
  until = Number.POSITIVE_INFINITY,
): TermScore {
  const split = splitterOf(language);
  const said = told.said.map((term) => split(term));
  const notSaid = told.notSaid.map((term) => split(term));
  const score: TermScore = { occurrences: 0, wrong: 0, others: { errors: 0, total: 0 }, unsaid: 0 };
  const refSegments = reference.segments.filter((segment) => segment.start < until);
  const hypSegments = hypothesis.segments.filter((segment) => segment.start < until);
  const last = Math.max(0, ...refSegments.map((s) => s.start), ...hypSegments.map((s) => s.start));
  for (let from = 0; from <= last; from += WINDOW_SECONDS) {
    const inWindow = <T extends { start: number }>(segments: readonly T[]) =>
      segments
        .filter((segment) => segment.start >= from && segment.start < from + WINDOW_SECONDS)
        .sort((a, b) => a.start - b.start);
    const ref = split(
      inWindow(refSegments)
        .map((segment) => segment.text)
        .join(" "),
    );
    const hyp = split(
      inWindow(hypSegments)
        .map((segment) => segment.text)
        .join(" "),
    );
    const spans = spansOf(ref, said);
    const termOf = new Int32Array(ref.length).fill(-1);
    for (const [index, [first, lastUnit]] of spans.entries()) {
      for (let k = first; k <= lastUnit; k++) termOf[k] = index;
    }
    const wrong = new Uint8Array(spans.length);
    let position = 0;
    for (const step of align(ref, hyp)) {
      if (step === "insertion") {
        const before = termOf[position - 1] ?? -1;
        const inside = before >= 0 && before === (termOf[position] ?? -2);
        if (inside) wrong[before] = 1;
        else score.others.errors++;
        continue;
      }
      const term = termOf[position] as number;
      if (term >= 0) {
        if (step !== "match") wrong[term] = 1;
      } else if (step !== "match") {
        score.others.errors++;
      }
      position++;
    }
    score.occurrences += spans.length;
    score.wrong += wrong.reduce((sum, each) => sum + each, 0);
    score.others.total += ref.length - spans.reduce((sum, [a, b]) => sum + b - a + 1, 0);
    score.unsaid += Math.max(0, spansOf(hyp, notSaid).length - spansOf(ref, notSaid).length);
  }
  return score;
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`;

/** The words' scores by language, as a Markdown table. */
export function formatTerms(
  scores: readonly { id: string; language: Language; score: TermScore }[],
): string {
  const rows = [
    "| Language | Told words said | Not written exactly | Other units' error rate | Told, never said, written |",
    "|---|---|---|---|---|",
  ];
  for (const language of ["en", "zh", "mixed"] as const) {
    const group = scores.filter((each) => each.language === language).map((each) => each.score);
    if (group.length === 0) continue;
    const sum = (pick: (score: TermScore) => number) =>
      group.reduce((total, score) => total + pick(score), 0);
    const occurrences = sum((score) => score.occurrences);
    const wrong = sum((score) => score.wrong);
    const errors = sum((score) => score.others.errors);
    const total = sum((score) => score.others.total);
    rows.push(
      `| ${language} | ${occurrences} | ${wrong} (${percent(wrong, occurrences)}) | ${percent(errors, total)} (${errors} of ${total}) | ${sum((score) => score.unsaid)} |`,
    );
  }
  return rows.join("\n");
}
