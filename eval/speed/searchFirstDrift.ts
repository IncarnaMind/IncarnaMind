/**
 * The gate's drift rule (../evidence/2532-search-first/README.md › Bars): K and the gating row's
 * margins simulated again, by the rule Phase A's were, from the records of B's own `main` arm, so
 * that each bar is read against the smaller of the written threshold and this one.
 *
 * Each sentence's chance of Supported is drawn per simulated run from its posterior or taken as its
 * share: for the gating row, Jeffreys over its readings; for the wrong sentences, a posterior pulled
 * toward their pooled rate by a prior worth 1, 2 or 10 readings. Two arms of `rounds` rounds are drawn
 * from the same chances; every wrong sentence on the list, or Supported by either simulated arm, is
 * read ten more times on each. A threshold is the largest over the models of the share `main` beside
 * `main` passes: 19 in 20 plain, 99 in 100 strict.
 */

/** A sentence's Supported readings of its readings. */
export interface Tally {
  supported: number;
  read: number;
}

export interface DriftRecords {
  /** The gating row's sentences on `main`, by language. */
  rows: Readonly<Record<string, readonly Tally[]>>;
  /** The wrong twins and absent sentences on `main`, both languages. */
  wrong: readonly Tally[];
  /** For each wrong sentence, whether it is on the list already. */
  listed: readonly boolean[];
}

export type Thresholds = Readonly<Record<string, readonly [number, number]>>;

const LIST_READINGS = 10;

/** A seeded generator, so a report reads the same thresholds from the same records. */
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampler(random: () => number) {
  const normal = () => {
    const u = 1 - random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };
  // Marsaglia and Tsang's method; a shape under 1 is lifted by one and scaled back.
  const gamma = (shape: number): number => {
    if (shape <= 0) return 0;
    if (shape < 1) return gamma(shape + 1) * random() ** (1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = normal();
      const v = (1 + c * x) ** 3;
      if (v <= 0) continue;
      const u = random();
      if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
    }
  };
  const beta = (a: number, b: number) => {
    const x = gamma(a);
    const y = gamma(b);
    return x + y === 0 ? 0 : x / (x + y);
  };
  const binomial = (times: number, chance: number) => {
    if (chance <= 0) return 0;
    let count = 0;
    for (let at = 0; at < times; at++) if (random() < chance) count++;
    return count;
  };
  return { beta, binomial };
}

function quantile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0;
}

/** K (`K`) and each language's margin, plain and strict, for `rounds` rounds of each arm. */
export function driftThresholds(
  records: DriftRecords,
  rounds: number,
  runs = 20_000,
  seed = 2532,
): Thresholds {
  const { beta, binomial } = sampler(generator(seed));
  const floor = rounds < 4 ? 2 : Number.NEGATIVE_INFINITY;
  const supported = records.wrong.reduce((total, each) => total + each.supported, 0);
  const read = records.wrong.reduce((total, each) => total + each.read, 0);
  const wrongChances = (prior: number | null) => {
    if (prior === null)
      return records.wrong.map((each) => (each.read ? each.supported / each.read : 0));
    const pooled = beta(supported + 0.5, read - supported + 0.5);
    return records.wrong.map((each) =>
      beta(prior * pooled + each.supported, prior * (1 - pooled) + each.read - each.supported),
    );
  };
  const wrongExcess = (chances: readonly number[]) => {
    let excess = 0;
    chances.forEach((chance, at) => {
      let base = binomial(rounds, chance);
      let other = binomial(rounds, chance);
      if (records.listed[at] || base > 0 || other > 0) {
        base += binomial(LIST_READINGS, chance);
        other += binomial(LIST_READINGS, chance);
      }
      excess += other - base;
    });
    return excess;
  };
  const threshold = (draws: (() => number)[]) => {
    let plain = floor;
    let strict = floor;
    for (const draw of draws) {
      const values = Array.from({ length: runs }, draw);
      plain = Math.max(plain, quantile(values, 0.95));
      strict = Math.max(strict, quantile(values, 0.99));
    }
    return [plain, strict] as const;
  };
  const out: Record<string, readonly [number, number]> = {
    K: threshold([1, 2, 10, null].map((prior) => () => wrongExcess(wrongChances(prior)))),
  };
  for (const [language, row] of Object.entries(records.rows)) {
    const chances = (posterior: boolean) =>
      row.map((each) =>
        posterior
          ? beta(each.supported + 0.5, each.read - each.supported + 0.5)
          : each.read
            ? each.supported / each.read
            : 0,
      );
    out[language] = threshold(
      [true, false].map((posterior) => () => {
        const drawn = chances(posterior);
        let excess = 0;
        for (const chance of drawn) excess += binomial(rounds, chance) - binomial(rounds, chance);
        return excess;
      }),
    );
  }
  return out;
}
