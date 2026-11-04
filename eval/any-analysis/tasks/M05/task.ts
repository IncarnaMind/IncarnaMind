import { between, csv, normal, random, round, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Card transactions 2025.csv";
const SEED = 2105;
const TRANSACTIONS = 50_000;
const PLANTED = 20;

/**
 * Where the planted transactions go: a few in the first 20,000 rows an Analysis reads today, the
 * rest after them, so an Answer that reads only part of the file misses most of them.
 */
function plantedRows(next: () => number): Set<number> {
  const rows = new Set<number>();
  while (rows.size < 3) rows.add(between(next, 0, 19_999));
  while (rows.size < PLANTED) rows.add(between(next, 20_000, TRANSACTIONS - 1));
  return rows;
}

/**
 * 50,000 card transactions: ordinary ones by day, a few items, close to home; 20 planted ones at
 * night, with many items, far from home, 12 of them for amounts many times any ordinary one.
 */
function transactions(): string {
  const next = random(SEED);
  const planted = [...plantedRows(next)].sort((a, b) => a - b);
  const plantedAt = new Map(planted.map((row, index) => [row, index]));
  const rows: string[] = [
    csv([["Transaction", "Account", "Hour", "Amount", "Items", "Distance km"]]),
  ];
  for (let row = 0; row < TRANSACTIONS; row++) {
    const id = `T${String(row + 1).padStart(6, "0")}`;
    const account = `A${String(between(next, 1, 2000)).padStart(4, "0")}`;
    const rank = plantedAt.get(row);
    if (rank === undefined) {
      const hour = Math.min(23, Math.max(6, Math.round(14 + 3.5 * normal(next))));
      const amount = round(Math.exp(3.6 + 0.7 * normal(next)), 2);
      const items = Math.min(9, 1 + Math.floor(-Math.log(Math.max(next(), 1e-9)) * 1.3));
      const distance = round(Math.exp(1.5 + 0.8 * normal(next)), 1);
      rows.push(csv([[id, account, hour, amount, items, distance]]));
      continue;
    }
    // Two in every five have an ordinary amount: only the hour, items and distance give them away.
    const amount =
      rank % 5 < 2
        ? round(between(next, 60, 250) + next(), 2)
        : round(between(next, 4000, 9000) + next(), 2);
    rows.push(
      csv([
        [
          id,
          account,
          between(next, 1, 4),
          amount,
          between(next, 14, 24),
          round(900 + 2100 * next(), 1),
        ],
      ]),
    );
  }
  return rows.join("");
}

export const task: Task = {
  id: "M05",
  title: "Anomalies in card transactions",
  needs: ["N"],
  seed: SEED,
  large: true,
  question: {
    en: "Card transactions 2025.csv has 50,000 card transactions. Flag anomalies with an isolation forest on the hour, amount, items and distance (with a fixed random seed). List the 20 transactions with the highest anomaly scores, each by its transaction ID with its amount. Then compare with a simple rule that flags every transaction whose amount is more than 3 standard deviations from the mean amount: how many transactions does that rule flag, and how many of your 20 does it catch?",
  },
  inputs: () => {
    const text = transactions();
    return { files: [{ name: NAME, bytes: utf8(text) }], data: { "transactions.csv": text } };
  },
  expect: [
    {
      id: "top20",
      kind: "rows",
      label: "The 20 transactions with the highest anomaly scores",
      key: /\bT\d{6}\b/g,
      columns: [{ id: "amount", unit: "plain", tolerance: { abs: 0.01 } }],
    },
    {
      id: "rule_count",
      kind: "number",
      label: "Transactions the 3-standard-deviation rule flags",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /standard deviation|z-?score|\bσ|sigma|rule|标准差|规则/i,
    },
    {
      id: "rule_catches",
      kind: "number",
      label: "Of the 20, how many the rule catches",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /catch|caught|overlap|of (?:the|your|these) 20|both|命中|重合|其中/i,
    },
  ],
  sources: { documents: [NAME] },
};
