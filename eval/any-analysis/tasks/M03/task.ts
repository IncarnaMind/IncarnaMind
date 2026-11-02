import { csv, fullWidth, normal, random, round, utf8 } from "../../inputs";
import type { Task, TaskLanguage } from "../../task";

const NAMES = { en: "Customer RFM 2025.csv", zh: "客户RFM数据2025.csv" } as const;
const HEADINGS = {
  en: ["Customer", "Days since last purchase", "Purchases in 12 months", "Spend in 12 months"],
  zh: ["客户编号", "距上次购买天数", "近12个月购买次数", "近12个月消费金额"],
} as const;
const SEED = 2103;

/**
 * Four segments as [customers, then mean and spread of recency, frequency and spend], each far
 * from the others on every measure, so the silhouette picks four however the columns are scaled.
 */
const SEGMENTS = [
  [300, 8, 3, 40, 4, 13000, 400],
  [700, 30, 6, 20, 2.5, 9500, 300],
  [1400, 90, 12, 8, 1.2, 6000, 250],
  [2600, 250, 25, 2, 0.6, 600, 80],
] as const;

function customers() {
  const next = random(SEED);
  const rows = SEGMENTS.flatMap(
    ([count, recency, recencySpread, often, oftenSpread, spend, spread]) =>
      Array.from({ length: count }, () => ({
        recency: Math.max(0, Math.round(recency + recencySpread * normal(next))),
        frequency: Math.max(1, Math.round(often + oftenSpread * normal(next))),
        spend: round(Math.max(5, spend + spread * normal(next)), 2),
        order: next(),
      })),
  );
  return rows.sort((a, b) => a.order - b.order);
}

function inputs(language: TaskLanguage) {
  const rows = customers();
  const id = (index: number) => `C${String(index + 1).padStart(5, "0")}`;
  return {
    files: [
      {
        name: NAMES[language],
        bytes: utf8(
          csv([
            [...HEADINGS[language]],
            ...rows.map((row, index) => [
              language === "zh" ? fullWidth(id(index)) : id(index),
              row.recency,
              row.frequency,
              row.spend,
            ]),
          ]),
        ),
      },
    ],
    data: {
      "customers.csv": csv([
        ["recency", "frequency", "spend"],
        ...rows.map((row) => [row.recency, row.frequency, row.spend]),
      ]),
    },
  };
}

export const task: Task = {
  id: "M03",
  title: "Customer segments by k-means",
  needs: ["P"],
  seed: SEED,
  question: {
    en: "Customer RFM 2025.csv has 5,000 customers with their days since last purchase (recency), purchases in the last 12 months (frequency) and spend in the last 12 months. Segment them with k-means: try k from 2 to 8 and choose k by the mean silhouette score. Number the segments S1, S2 and so on from the highest mean spend to the lowest, and profile each one: how many customers it has, and its mean recency, frequency and spend. Then check that the segments are stable over 5 different random seeds.",
    zh: "“客户RFM数据2025.csv”里有 5,000 名客户的距上次购买天数（R）、近 12 个月购买次数（F）和近 12 个月消费金额（M）。请用 k-means 给客户分群：k 取 2 到 8，按平均轮廓系数选出 k。按平均消费金额从高到低，把各客群依次编号为 S1、S2 等，并给出每个客群的画像：客户数，以及平均距上次购买天数、平均购买次数和平均消费金额。最后换 5 个不同的随机种子，检查分群是否稳定。",
  },
  inputs,
  expect: [
    {
      id: "k",
      kind: "number",
      label: "Number of segments chosen by silhouette",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /\bk\s*=|clusters|segments|silhouette|聚类|客群|分群|簇|轮廓/i,
    },
    {
      id: "segments",
      kind: "rows",
      label: "Each segment's customers and mean spend",
      key: /\bS[1-9]\b/g,
      columns: [
        {
          id: "customers",
          unit: "plain",
          tolerance: { abs: 0 },
          heading: /customers|^\s*n\s*$|count|size|客户数|人数|数量/i,
        },
        { id: "mean_spend", unit: "plain", tolerance: { abs: 0.5 }, heading: /spend|消费/i },
      ],
    },
    {
      id: "stable",
      kind: "mention",
      label: "Checks the segments' stability over seeds",
      match: /stab|adjusted rand|\bARI\b|稳定|一致/i,
    },
  ],
  sources: { documents: [NAMES.en] },
};
