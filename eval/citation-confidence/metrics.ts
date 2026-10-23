export interface Scored {
  /** The probability the quote states the sentence. */
  score: number;
  /** Whether the pair is truly SUPPORTS. */
  positive: boolean;
}

/** The chance that a random positive scores above a random negative, ties counting half. */
export function auc(items: readonly Scored[]): number {
  const sorted = [...items].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let positives = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j]?.score === sorted[i]?.score) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      if (sorted[k]?.positive) {
        rankSum += rank;
        positives++;
      }
    }
    i = j;
  }
  const negatives = sorted.length - positives;
  if (positives === 0 || negatives === 0) return Number.NaN;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function logGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let series = 1.000000000190015;
  for (const each of c) series += each / ++y;
  return -tmp + Math.log((2.5066282746310007 * series) / x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  d = Math.abs(d) < 1e-30 ? 1e-30 : d;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    d = Math.abs(d) < 1e-30 ? 1e-30 : d;
    c = 1 + aa / c;
    c = Math.abs(c) < 1e-30 ? 1e-30 : c;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    d = Math.abs(d) < 1e-30 ? 1e-30 : d;
    c = 1 + aa / c;
    c = Math.abs(c) < 1e-30 ? 1e-30 : c;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return h;
}

/** The regularised incomplete beta function. */
function betaInc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** The exact one-sided 95% lower bound (Clopper-Pearson) for a rate after `hits` of `total`. */
export function lowerBound(hits: number, total: number, alpha = 0.05): number {
  if (hits === 0 || total === 0) return 0;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 60; step++) {
    const mid = (low + high) / 2;
    if (betaInc(hits, total - hits + 1, mid) > alpha) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}

export interface Cut {
  threshold: number;
  predicted: number;
  falsePositives: number;
  precision: number;
  precisionLower: number;
  coverage: number;
}

/** What judging every pair that scores at least `threshold` as SUPPORTS gets right. */
export function cut(items: readonly Scored[], threshold: number): Cut {
  const predicted = items.filter((each) => each.score >= threshold);
  const hits = predicted.filter((each) => each.positive).length;
  const positives = items.filter((each) => each.positive).length;
  return {
    threshold,
    predicted: predicted.length,
    falsePositives: predicted.length - hits,
    precision: predicted.length === 0 ? Number.NaN : hits / predicted.length,
    precisionLower: lowerBound(hits, predicted.length),
    coverage: positives === 0 ? Number.NaN : hits / positives,
  };
}

/** The lowest threshold, on a 0.01 grid, whose precision is at least `target`. */
export function thresholdFor(items: readonly Scored[], target: number): number | null {
  for (let step = 1; step <= 100; step++) {
    const threshold = step / 100;
    const here = cut(items, threshold);
    if (here.predicted > 0 && here.precision >= target) return threshold;
  }
  return null;
}

export interface Bin {
  from: number;
  to: number;
  count: number;
  positives: number;
}

/** Pairs sorted into probability bins, with the share of each bin that truly is SUPPORTS. */
export function reliability(items: readonly Scored[], edges: readonly number[]): Bin[] {
  return edges.slice(0, -1).map((from, index) => {
    const to = edges[index + 1] ?? 1;
    const inBin = items.filter(
      (each) => each.score >= from && (each.score < to || (to === 1 && each.score <= 1)),
    );
    return {
      from,
      to,
      count: inBin.length,
      positives: inBin.filter((each) => each.positive).length,
    };
  });
}

export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return (sorted[low] ?? 0) + ((sorted[Math.ceil(at)] ?? 0) - (sorted[low] ?? 0)) * (at - low);
}
