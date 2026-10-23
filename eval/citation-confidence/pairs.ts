/**
 * Every (sentence, quote, label) pair the evaluation scores: the checks evaluation's labels
 * (eval/checks), the sentences of the repeated checks, hand-made cases in English and Chinese,
 * and mutations of the labels' supporting pairs (a changed figure, a claim added to the sentence).
 * The same pairs come out every time, so nothing is saved.
 */
import { readFileSync } from "node:fs";
import { HANDMADE } from "./handmade";
import { HARD } from "./hard";
import { REPEATS } from "./repeats";
import { dice, hash, here, isRow, splitOf, trigrams } from "./shared";
import type { Caveat, Label, Language, Pair } from "./types";

interface Evidence {
  document: string;
  quote: string;
}

interface LabelItem {
  id: string;
  set: "find-support" | "verify";
  document: string;
  language: Language;
  sentence?: string;
  claim?: string;
  label: "supported" | "contradicted" | "unsupported";
  evidence: Evidence | null;
}

interface LabelFile {
  folder: { name: string; format: string; source: string }[];
  items: LabelItem[];
}

/** The weakest word overlap at which a quote is a plausible neighbour of a sentence nothing states. */
const MIN_NEIGHBOUR_DICE = 0.2;

/** The checks labels' sentences whose figure no Document states but whose numbers give (#707). */
const CALCULATED = new Set(Array.from({ length: 8 }, (_, i) => `fs-${201 + i}`));

const SUFFIXES: Record<Language, string[]> = {
  en: [
    ", and an independent audit confirmed this",
    ", and this is expected to stay unchanged until 2030",
    ", and the regional director approved the arrangement",
    ", which cost 12 percent less than planned",
  ],
  zh: [
    "，并且已由独立审计确认",
    "，预计到2030年保持不变",
    "，该安排已获区域负责人批准",
    "，费用比计划低12%",
  ],
};

function addedClaim(pair: Pair): string | null {
  const end = /[.。]$/.exec(pair.sentence);
  if (!end) return null;
  const suffixes = SUFFIXES[pair.language];
  const suffix = suffixes[hash(pair.id) % suffixes.length] ?? "";
  return `${pair.sentence.slice(0, -1)}${suffix}${end[0]}`;
}

function changedFigure(pair: Pair): string | null {
  for (const match of pair.sentence.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const token = match[0];
    if (!pair.quote.includes(token)) continue;
    const value = Number.parseFloat(token.replaceAll(",", ""));
    const decimals = token.split(".")[1]?.length ?? 0;
    const isYear = decimals === 0 && !token.includes(",") && value >= 1900 && value <= 2100;
    const next = isYear
      ? value + 2
      : value < 10
        ? value + 3
        : value + Math.max(2, Math.round(value * 0.2));
    const text = token.includes(",") ? next.toLocaleString("en-US") : next.toFixed(decimals);
    if (pair.quote.includes(text)) continue;
    const at = match.index ?? 0;
    return pair.sentence.slice(0, at) + text + pair.sentence.slice(at + token.length);
  }
  return null;
}

function fromLabels(): Pair[] {
  const file: LabelFile = JSON.parse(readFileSync(here("../checks/labels.json"), "utf8"));
  const external = new Set(
    file.folder.filter((each) => each.source !== "synthetic").map((each) => each.name),
  );
  const quotes = file.items.flatMap((item) =>
    item.evidence && !external.has(item.evidence.document) ? [item.evidence] : [],
  );
  const grams = new Map(quotes.map((each) => [each.quote, trigrams(each.quote)]));
  const pairs: Pair[] = [];
  for (const item of file.items) {
    const sentence = item.sentence ?? item.claim;
    if (!sentence) continue;
    let evidence = item.evidence;
    if (evidence && external.has(evidence.document)) continue;
    const label: Label = item.label === "supported" ? "SUPPORTS" : "NOT";
    if (item.label === "unsupported") {
      const own = trigrams(sentence);
      let best: { quote: Evidence; score: number } | null = null;
      for (const quote of quotes) {
        if (item.set === "find-support" && quote.document !== item.document) continue;
        const score = dice(own, grams.get(quote.quote) ?? new Map());
        if (!best || score > best.score) best = { quote, score };
      }
      evidence = best && best.score >= MIN_NEIGHBOUR_DICE ? best.quote : null;
    }
    if (!evidence) continue;
    const format = /\.([a-z]+)$/i.exec(evidence.document)?.[1]?.toLowerCase() ?? "web";
    const caveat: Caveat | undefined = CALCULATED.has(item.id)
      ? "calculated"
      : isRow(evidence.document, evidence.quote)
        ? "table-row"
        : undefined;
    pairs.push({
      id: item.id,
      source: "labels",
      kind: `${item.label}:${format}`,
      language: item.language,
      label,
      sentence,
      quote: evidence.quote,
      ...(caveat && { caveat }),
      split: splitOf(item.id),
    });
  }
  return pairs;
}

function everyOther<T extends { id: string }>(list: T[], keep: number): T[] {
  return [...list].sort((a, b) => hash(a.id) - hash(b.id)).slice(0, keep);
}

function fromCases(cases: typeof HANDMADE, source: "handmade" | "hard"): Pair[] {
  const prefix = source === "hard" ? "x" : "h";
  return cases.flatMap((each, index) =>
    (["en", "zh"] as const).map((language) => ({
      id: `${prefix}${String(index + 1).padStart(2, "0")}-${language}`,
      source,
      kind: each.kind,
      language,
      label: each.label,
      sentence: each[language].sentence,
      quote: each[language].quote,
      split: source === "hard" ? ("test" as const) : splitOf(`h${index}`),
    })),
  );
}

function fromRepeats(): Pair[] {
  const seen = new Set<string>();
  const pairs: Pair[] = [];
  for (const each of REPEATS) {
    const id = `r:${each.set}:${each.key}`;
    const dedupe = `${each.sentence}|${each.quote}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    pairs.push({
      id,
      source: "repeats",
      kind: each.kind,
      language: each.language,
      label: each.label,
      sentence: each.sentence,
      quote: each.quote,
      ...(each.caveat && { caveat: each.caveat }),
      split: splitOf(dedupe),
    });
  }
  return pairs;
}

function mutations(base: Pair[]): Pair[] {
  const supports = base.filter(
    (each) => each.source === "labels" && each.label === "SUPPORTS" && !each.caveat,
  );
  const out: Pair[] = [];
  for (const language of ["en", "zh"] as const) {
    const pool = supports.filter((each) => each.language === language);
    const figures = everyOther(
      pool.flatMap((each) => {
        const sentence = changedFigure(each);
        return sentence ? [{ ...each, id: `m:figure:${each.id}`, sentence }] : [];
      }),
      20,
    );
    const claims = everyOther(
      pool.flatMap((each) => {
        const sentence = addedClaim(each);
        return sentence ? [{ ...each, id: `m:claim:${each.id}`, sentence }] : [];
      }),
      20,
    );
    for (const each of figures)
      out.push({ ...each, source: "mutation", kind: "changed-figure", label: "NOT" });
    for (const each of claims)
      out.push({ ...each, source: "mutation", kind: "added-claim", label: "PARTLY" });
  }
  return out;
}

export function buildPairs(): Pair[] {
  const labelled = fromLabels();
  const base = [
    ...labelled.filter((each) => each.label === "SUPPORTS"),
    ...labelled.filter((each) => each.kind.startsWith("contradicted")),
    ...everyOther(
      labelled.filter((each) => each.kind.startsWith("unsupported")),
      70,
    ),
  ];
  return [
    ...base,
    ...fromCases(HANDMADE, "handmade"),
    ...fromCases(HARD, "hard"),
    ...fromRepeats(),
    ...mutations(base),
  ];
}

/** The pairs of a file made by recorded.ts, or the evaluation's own pairs. */
export function loadPairs(file?: string): Pair[] {
  return file ? (JSON.parse(readFileSync(file, "utf8")) as Pair[]) : buildPairs();
}
