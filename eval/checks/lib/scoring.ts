/**
 * How a run of the checks pipeline is scored against the labels (#86). Pure:
 * tests/eval/checkScoring.test.ts runs it without a model.
 *
 * - Find support: precision and recall of "supported" over the labelled
 *   sentences. A sentence that wasn't checked counts as not supported, as
 *   the app never shows one as supported.
 * - Verify: each extracted claim is matched to the labelled claim it quotes
 *   (`matchClaims`). A labelled claim that no extracted claim matches wasn't
 *   extracted, and is a miss. "Contradicted" recall is over the labelled
 *   contradicted claims; precision is over the claims a check called
 *   contradicted, each labelled claim once, and a claim that matches no label
 *   is a false alarm.
 */
import { SIMPLIFIED } from "../../../src/shared/hanVariants";
import { normaliseText } from "../../../src/shared/text";
import type { JudgeRequest } from "./judge";
import {
  CHECK_LANGUAGES,
  type CheckLabel,
  type CheckLanguage,
  type FindSupportItem,
  type LabelledQuote,
  type VerifyItem,
} from "./set";

/** What a check said of a sentence or a claim; "not-checked" when the model failed. */
export type Verdict = CheckLabel | "not-checked";

/** The Passage a verdict rests on. */
export interface FoundEvidence {
  /** The Document's name in the labels. */
  document: string;
  /** The Units the Passage covers; null when unknown. */
  units: [number, number] | null;
  quote: string;
}

export interface CheckOutcome {
  verdict: Verdict;
  /** Why it wasn't checked, in plain words. */
  reason?: string;
  /** Why it wasn't checked, as the app's check gave it (`ClaimCheckFailure`). */
  code?: string;
  evidence: FoundEvidence | null;
  /** Every request the check made to the model, with its reply and Tool calls, when the run kept them. */
  judge?: JudgeRequest[];
}

export interface SentenceResult {
  /** The labelled sentence's id. */
  id: string;
  outcome: CheckOutcome;
}

export interface ExtractedClaim {
  /** The claim as the extraction wrote it, to stand on its own. */
  text: string;
  /** Its words in the document, as the extraction quoted them: it is matched to a label by these. */
  source: string;
  outcome: CheckOutcome;
}

export interface VerifiedDocument {
  /** The received document's name in the labels. */
  document: string;
  claims: ExtractedClaim[];
  /** Why claim extraction failed; its labelled claims count as not extracted. */
  failure: string | null;
}

export interface Rate {
  hits: number;
  total: number;
  share: number | null;
}

export interface PrecisionRecall {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
}

/** A disagreement with the labels, for a person to look into. */
export interface Miss {
  /** The labelled item's id; null for an extracted claim that matches none. */
  id: string | null;
  language: CheckLanguage;
  document: string;
  text: string;
  label: CheckLabel | null;
  verdict: Verdict | "not-extracted";
  reason: string | null;
  found: FoundEvidence | null;
  expected: LabelledQuote | null;
}

export interface FindSupportScore {
  sentences: number;
  supported: PrecisionRecall;
  byLanguage: Record<CheckLanguage, PrecisionRecall>;
  byFormat: Record<string, PrecisionRecall>;
  /** Of the sentences rightly found supported, those whose Passage is the labelled one: its Document, its Units. */
  labelledEvidence: Rate;
  /** Reported only: Find support's gate is on "supported". */
  contradicted: PrecisionRecall;
  notChecked: number;
  misses: Miss[];
}

export interface VerifyScore {
  claims: number;
  /** Labelled claims that an extracted claim matches. */
  extracted: Rate;
  extractedByLanguage: Record<CheckLanguage, Rate>;
  contradicted: PrecisionRecall;
  contradictedByLanguage: Record<CheckLanguage, PrecisionRecall>;
  /** Reported only. */
  supported: PrecisionRecall;
  /** Extracted claims that match no labelled claim. */
  unlabelled: number;
  notChecked: number;
  misses: Miss[];
}

const rate = (hits: number, total: number): Rate => ({
  hits,
  total,
  share: total > 0 ? hits / total : null,
});

function precisionRecall(
  truePositives: number,
  falsePositives: number,
  falseNegatives: number,
): PrecisionRecall {
  const flagged = truePositives + falsePositives;
  const labelled = truePositives + falseNegatives;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: flagged > 0 ? truePositives / flagged : null,
    recall: labelled > 0 ? truePositives / labelled : null,
  };
}

/** Precision and recall of one label over pairs of what the labels say and what the checks said. */
function scoreLabel(
  pairs: readonly { label: CheckLabel | null; verdicts: readonly Verdict[] }[],
  label: CheckLabel,
): PrecisionRecall {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const pair of pairs) {
    const said = pair.verdicts.includes(label);
    if (pair.label === label && said) truePositives++;
    else if (pair.label === label) falseNegatives++;
    else falsePositives += pair.verdicts.filter((verdict) => verdict === label).length;
  }
  return precisionRecall(truePositives, falsePositives, falseNegatives);
}

const NOT_CHECKED: CheckOutcome = {
  verdict: "not-checked",
  reason: "No result for this sentence.",
  evidence: null,
};

const overlaps = (a: [number, number] | null, b: [number, number]) =>
  a !== null && a[0] <= b[1] && b[0] <= a[1];

/** Whether a verdict rests on the labelled Passage: the same Document, and Units that overlap. */
function onLabelledEvidence(found: FoundEvidence | null, expected: LabelledQuote | null) {
  return found !== null && expected !== null && found.document === expected.document
    ? overlaps(found.units, expected.units)
    : false;
}

export function scoreFindSupport(
  items: readonly FindSupportItem[],
  results: readonly SentenceResult[],
  formatOf: (document: string) => string,
): FindSupportScore {
  const outcomes = new Map(results.map((result) => [result.id, result.outcome]));
  const scored = items.map((item) => ({ item, outcome: outcomes.get(item.id) ?? NOT_CHECKED }));
  const pairs = (subset: typeof scored) =>
    subset.map(({ item, outcome }) => ({ label: item.label, verdicts: [outcome.verdict] }));
  const byFormat: Record<string, PrecisionRecall> = {};
  for (const format of new Set(items.map((item) => formatOf(item.document)))) {
    byFormat[format] = scoreLabel(
      pairs(scored.filter(({ item }) => formatOf(item.document) === format)),
      "supported",
    );
  }
  const rightlySupported = scored.filter(
    ({ item, outcome }) => item.label === "supported" && outcome.verdict === "supported",
  );
  return {
    sentences: items.length,
    supported: scoreLabel(pairs(scored), "supported"),
    byLanguage: perLanguage((language) =>
      scoreLabel(pairs(scored.filter(({ item }) => item.language === language)), "supported"),
    ),
    byFormat,
    labelledEvidence: rate(
      rightlySupported.filter(({ item, outcome }) =>
        onLabelledEvidence(outcome.evidence, item.evidence),
      ).length,
      rightlySupported.length,
    ),
    contradicted: scoreLabel(pairs(scored), "contradicted"),
    notChecked: scored.filter(({ outcome }) => outcome.verdict === "not-checked").length,
    misses: scored
      .filter(({ item, outcome }) => outcome.verdict !== item.label)
      .map(({ item, outcome }) => ({
        id: item.id,
        language: item.language,
        document: item.document,
        text: item.sentence,
        label: item.label,
        verdict: outcome.verdict,
        reason: outcome.reason ?? null,
        found: outcome.evidence,
        expected: item.evidence,
      })),
  };
}

function perLanguage<T>(score: (language: CheckLanguage) => T): Record<CheckLanguage, T> {
  return Object.fromEntries(
    CHECK_LANGUAGES.map((language) => [language, score(language)]),
  ) as Record<CheckLanguage, T>;
}

/** Text as the check compares it, then only its letters, digits and ideographs, in simplified characters. */
function comparable(text: string): string {
  return Array.from(normaliseText(text).toLowerCase(), (char) => SIMPLIFIED.get(char) ?? char)
    .join("")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const chars = Array.from(comparable(text));
  for (let index = 0; index + 1 < chars.length; index++) {
    const pair = `${chars[index]}${chars[index + 1]}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** How alike two texts are, 0 to 1: the Dice coefficient of their character pairs, in any language. */
export function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const [pair, count] of left) {
    shared += Math.min(count, right.get(pair) ?? 0);
    total += count;
  }
  for (const count of right.values()) total += count;
  return total > 0 ? (2 * shared) / total : 0;
}

/** An extracted claim matches the labelled claim most like it, when they are at least this alike. */
const MATCH_THRESHOLD = 0.5;

/** For each extracted claim, the labelled claim it quotes, or null. */
export function matchClaims(
  labelled: readonly VerifyItem[],
  extracted: readonly ExtractedClaim[],
): (VerifyItem | null)[] {
  return extracted.map((claim) => {
    let best: VerifyItem | null = null;
    let bestScore = MATCH_THRESHOLD;
    for (const item of labelled) {
      const score = Math.max(
        similarity(claim.source, item.claim),
        similarity(claim.text, item.claim),
      );
      if (score >= bestScore) {
        best = item;
        bestScore = score;
      }
    }
    return best;
  });
}

export function scoreVerify(
  items: readonly VerifyItem[],
  documents: readonly VerifiedDocument[],
): VerifyScore {
  const matched = new Map<string, ExtractedClaim[]>();
  const unlabelled: { claim: ExtractedClaim; document: string; language: CheckLanguage }[] = [];
  for (const document of documents) {
    const labelled = items.filter((item) => item.document === document.document);
    const language = labelled[0]?.language ?? "en";
    matchClaims(labelled, document.claims).forEach((item, index) => {
      const claim = document.claims[index] as ExtractedClaim;
      if (item) matched.set(item.id, [...(matched.get(item.id) ?? []), claim]);
      else unlabelled.push({ claim, document: document.document, language });
    });
  }
  const failures = new Map(documents.map((document) => [document.document, document.failure]));
  const pairsOf = (language: CheckLanguage | null) => [
    ...items
      .filter((item) => language === null || item.language === language)
      .map((item) => ({
        label: item.label,
        verdicts: (matched.get(item.id) ?? []).map((claim) => claim.outcome.verdict),
      })),
    ...unlabelled
      .filter((each) => language === null || each.language === language)
      .map((each) => ({ label: null, verdicts: [each.claim.outcome.verdict] })),
  ];
  const extractedOf = (subset: readonly VerifyItem[]) =>
    rate(subset.filter((item) => matched.has(item.id)).length, subset.length);

  const misses: Miss[] = [];
  for (const item of items) {
    const claims = matched.get(item.id) ?? [];
    const base = {
      id: item.id,
      language: item.language,
      document: item.document,
      text: item.claim,
      label: item.label,
      expected: item.evidence,
    };
    if (claims.length === 0) {
      misses.push({
        ...base,
        verdict: "not-extracted",
        reason: failures.get(item.document) ?? null,
        found: null,
      });
      continue;
    }
    for (const claim of claims) {
      if (claim.outcome.verdict === item.label) continue;
      misses.push({
        ...base,
        verdict: claim.outcome.verdict,
        reason: claim.outcome.reason ?? null,
        found: claim.outcome.evidence,
      });
    }
  }
  for (const { claim, document, language } of unlabelled) {
    if (claim.outcome.verdict !== "contradicted") continue;
    misses.push({
      id: null,
      language,
      document,
      text: claim.text,
      label: null,
      verdict: claim.outcome.verdict,
      reason: claim.outcome.reason ?? null,
      found: claim.outcome.evidence,
      expected: null,
    });
  }
  const allClaims = documents.flatMap((document) => document.claims);
  return {
    claims: items.length,
    extracted: extractedOf(items),
    extractedByLanguage: perLanguage((language) =>
      extractedOf(items.filter((item) => item.language === language)),
    ),
    contradicted: scoreLabel(pairsOf(null), "contradicted"),
    contradictedByLanguage: perLanguage((language) =>
      scoreLabel(pairsOf(language), "contradicted"),
    ),
    supported: scoreLabel(pairsOf(null), "supported"),
    unlabelled: unlabelled.length,
    notChecked: allClaims.filter((claim) => claim.outcome.verdict === "not-checked").length,
    misses,
  };
}

/** A bar from #86, #96 and #97, and whether the run met it. */
export interface Gate {
  name: string;
  value: number | null;
  bar: number;
  met: boolean;
}

export const BARS = {
  extracted: 0.9,
  contradictedPrecision: 0.9,
  contradictedRecall: 0.7,
  supportedPrecision: 0.9,
  supportedRecall: 0.8,
} as const;

export function gates(findSupport: FindSupportScore, verify: VerifyScore): Gate[] {
  const gate = (name: string, value: number | null, bar: number): Gate => ({
    name,
    value,
    bar,
    met: value !== null && value >= bar,
  });
  return [
    gate("Verify: claims extracted", verify.extracted.share, BARS.extracted),
    gate(
      'Verify: "contradicted" precision',
      verify.contradicted.precision,
      BARS.contradictedPrecision,
    ),
    gate('Verify: "contradicted" recall', verify.contradicted.recall, BARS.contradictedRecall),
    gate(
      'Find support: "supported" precision',
      findSupport.supported.precision,
      BARS.supportedPrecision,
    ),
    gate('Find support: "supported" recall', findSupport.supported.recall, BARS.supportedRecall),
  ];
}
