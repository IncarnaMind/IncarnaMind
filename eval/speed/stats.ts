/** Exact tests a gate reads its counts with. */

const choose = (n: number, k: number): number => {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
};

/** The chance of `more` or more of `pairs` untied pairs going one way, were each way as likely. */
export function signTestP(more: number, pairs: number): number {
  let p = 0;
  for (let k = more; k <= pairs; k++) p += choose(pairs, k) / 2 ** pairs;
  return Math.min(1, p);
}

/**
 * Fisher's exact test, one-sided: the chance of `a` or more in the table's first cell, its margins
 * held, were the first row no likelier than the second. [[a, b], [c, d]].
 */
export function fisherOneSided(a: number, b: number, c: number, d: number): number {
  const row = a + b;
  const column = a + c;
  const total = a + b + c + d;
  const chance = (x: number) =>
    (choose(column, x) * choose(total - column, row - x)) / choose(total, row);
  let p = 0;
  for (let x = a; x <= Math.min(row, column); x++) p += chance(x);
  return Math.min(1, p);
}
