/**
 * How Organize's results are scored against the labels. Pure: the unit tests
 * (tests/eval/organizeScoring.test.ts) run it without a model.
 *
 * - Folder accuracy: the Folder chosen is the labelled one (Unsorted counts as
 *   a Folder). "Lenient" also accepts a two-Folder case's second Folder.
 * - Tags: every applied Tag counts, as the app applies it, including those
 *   marked "needs review". Precision, recall and F1 are micro-averaged over
 *   (Document, Tag) pairs; "exact" is the share whose Tag set is exactly the
 *   labelled one.
 * - A request that failed counts as a wrong Folder and no Tags.
 */
export interface Labelled {
  id: string;
  folder: string | null;
  alsoFolder?: string;
  tags: readonly string[];
}

export interface PredictedTag {
  key: string;
  confidence: number | null;
  needsReview: boolean;
}

/** Tokens a Document's model calls used, as the provider counted them. */
export interface TokenCount {
  input: number;
  output: number;
  /** Of the output, the tokens spent reasoning. */
  reasoning: number;
}

export interface Prediction {
  id: string;
  /** Undefined when the request failed. */
  folder?: string | null;
  tags: PredictedTag[];
  error: string | null;
  /** Wall time of the classifier call, render time excluded. */
  ms: number;
  /** Time spent rendering PDF page images, if any. */
  renderMs: number;
  /** The model that decided, as the app records it. */
  model: string | null;
  /** Page images were sent. */
  images: boolean;
  /** What its model calls used, for a route that counts them. */
  tokens?: TokenCount;
  /** A decision model's probability for every Tag, applied or not. */
  scores?: Record<string, number>;
}

export interface Summary {
  count: number;
  errors: number;
  folderCorrect: number;
  folderLenient: number;
  tp: number;
  fp: number;
  fn: number;
  exact: number;
  /** Tags applied with a "needs review" mark, and how many of them were right. */
  review: number;
  reviewCorrect: number;
  msMean: number;
  msMedian: number;
  msP90: number;
  /** The Documents whose tokens were counted, and what they used in all. */
  counted: number;
  tokens: TokenCount;
}

export interface Mistake {
  id: string;
  expectedFolder: string | null;
  alsoFolder?: string;
  folder: string | null | undefined;
  expectedTags: readonly string[];
  tags: PredictedTag[];
  missing: string[];
  extra: string[];
  error: string | null;
}

export function folderCorrect(doc: Labelled, prediction: Prediction): boolean {
  return prediction.error === null && prediction.folder === doc.folder;
}

export function folderLenient(doc: Labelled, prediction: Prediction): boolean {
  return (
    folderCorrect(doc, prediction) ||
    (prediction.error === null &&
      doc.alsoFolder !== undefined &&
      prediction.folder === doc.alsoFolder)
  );
}

/** The predicted Tag keys, without repeats. */
const keysOf = (prediction: Prediction) =>
  prediction.error === null ? [...new Set(prediction.tags.map((tag) => tag.key))] : [];

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

export function summarise(pairs: readonly { doc: Labelled; prediction: Prediction }[]): Summary {
  const summary: Summary = {
    count: pairs.length,
    errors: 0,
    folderCorrect: 0,
    folderLenient: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    exact: 0,
    review: 0,
    reviewCorrect: 0,
    msMean: 0,
    msMedian: 0,
    msP90: 0,
    counted: 0,
    tokens: { input: 0, output: 0, reasoning: 0 },
  };
  const times: number[] = [];
  for (const { doc, prediction } of pairs) {
    if (prediction.error !== null) summary.errors++;
    else times.push(prediction.ms);
    if (prediction.tokens && prediction.tokens.input > 0) {
      summary.counted++;
      summary.tokens.input += prediction.tokens.input;
      summary.tokens.output += prediction.tokens.output;
      summary.tokens.reasoning += prediction.tokens.reasoning;
    }
    if (folderCorrect(doc, prediction)) summary.folderCorrect++;
    if (folderLenient(doc, prediction)) summary.folderLenient++;
    const expected = new Set(doc.tags);
    const predicted = keysOf(prediction);
    const hits = predicted.filter((key) => expected.has(key)).length;
    summary.tp += hits;
    summary.fp += predicted.length - hits;
    summary.fn += expected.size - hits;
    if (predicted.length === expected.size && hits === expected.size) summary.exact++;
    if (prediction.error === null)
      for (const tag of prediction.tags)
        if (tag.needsReview) {
          summary.review++;
          if (expected.has(tag.key)) summary.reviewCorrect++;
        }
  }
  times.sort((a, b) => a - b);
  summary.msMean = times.length ? times.reduce((sum, ms) => sum + ms, 0) / times.length : 0;
  summary.msMedian = percentile(times, 0.5);
  summary.msP90 = percentile(times, 0.9);
  return summary;
}

export const ratio = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
export const precision = (s: Pick<Summary, "tp" | "fp">) => ratio(s.tp, s.tp + s.fp);
export const recall = (s: Pick<Summary, "tp" | "fn">) => ratio(s.tp, s.tp + s.fn);
export function f1(s: Pick<Summary, "tp" | "fp" | "fn">): number {
  const p = precision(s);
  const r = recall(s);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Summaries per group, e.g. per language or format, in key order. */
export function breakdown<T extends Labelled>(
  pairs: readonly { doc: T; prediction: Prediction }[],
  keyOf: (doc: T) => string,
): [string, Summary][] {
  const groups = new Map<string, { doc: T; prediction: Prediction }[]>();
  for (const pair of pairs) {
    const key = keyOf(pair.doc);
    groups.set(key, [...(groups.get(key) ?? []), pair]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => [key, summarise(group)]);
}

/**
 * Tag precision, recall and F1 if a Tag applied from each threshold, for the predictions
 * that carry every Tag's probability. A failed request applies no Tag.
 */
export function thresholdSweep(
  pairs: readonly { doc: Labelled; prediction: Prediction }[],
  thresholds: readonly number[],
): { threshold: number; p: number; r: number; f1: number }[] {
  return thresholds.map((threshold) => {
    const counts = { tp: 0, fp: 0, fn: 0 };
    for (const { doc, prediction } of pairs) {
      const applied =
        prediction.error === null && prediction.scores
          ? Object.entries(prediction.scores)
              .filter(([, score]) => score >= threshold)
              .map(([key]) => key)
          : [];
      const hits = applied.filter((key) => doc.tags.includes(key)).length;
      counts.tp += hits;
      counts.fp += applied.length - hits;
      counts.fn += doc.tags.length - hits;
    }
    return { threshold, p: precision(counts), r: recall(counts), f1: f1(counts) };
  });
}

/** Each Tag's own counts: how often it was right, wrongly applied and missed. */
export function perTag(
  pairs: readonly { doc: Labelled; prediction: Prediction }[],
  keys: readonly string[],
): [string, Pick<Summary, "tp" | "fp" | "fn">][] {
  return keys.map((key) => {
    const counts = { tp: 0, fp: 0, fn: 0 };
    for (const { doc, prediction } of pairs) {
      const expected = doc.tags.includes(key);
      const predicted = keysOf(prediction).includes(key);
      if (expected && predicted) counts.tp++;
      else if (predicted) counts.fp++;
      else if (expected) counts.fn++;
    }
    return [key, counts];
  });
}

/** Every Document with a wrong Folder or a Tag set that isn't exact. */
export function mistakes(pairs: readonly { doc: Labelled; prediction: Prediction }[]): Mistake[] {
  return pairs.flatMap(({ doc, prediction }) => {
    const predicted = keysOf(prediction);
    const missing = doc.tags.filter((key) => !predicted.includes(key));
    const extra = predicted.filter((key) => !doc.tags.includes(key));
    if (folderCorrect(doc, prediction) && missing.length === 0 && extra.length === 0) return [];
    return [
      {
        id: doc.id,
        expectedFolder: doc.folder,
        ...(doc.alsoFolder !== undefined && { alsoFolder: doc.alsoFolder }),
        folder: prediction.error === null ? prediction.folder : undefined,
        expectedTags: doc.tags,
        tags: prediction.error === null ? prediction.tags : [],
        missing,
        extra,
        error: prediction.error,
      },
    ];
  });
}

/** "12/20 (60%)". */
export const fraction = (part: number, whole: number) =>
  `${part}/${whole} (${Math.round(ratio(part, whole) * 100)}%)`;

/** "0.83". */
export const decimal = (value: number) => value.toFixed(2);

/** What 100 Documents cost at a price per million tokens, from the tokens counted. */
export function costPer100(
  summary: Pick<Summary, "counted" | "tokens">,
  price: { input: number; output: number },
): number {
  if (summary.counted === 0) return 0;
  const perDocument =
    (summary.tokens.input * price.input + summary.tokens.output * price.output) /
    1e6 /
    summary.counted;
  return perDocument * 100;
}
