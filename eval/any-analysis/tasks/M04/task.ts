import { csv, normal, random, round, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Plant sensor readings.csv";
const SEED = 2104;
const READINGS = 3000;

/**
 * Each hidden driver's sensors and their standardised loadings: 14 on the first, 9 on the second,
 * 7 on the third, so three components explain well over 80% and two well under. Five of the first
 * driver's sensors load far more than the other nine, so PC1's top five stand apart.
 */
const DRIVERS: readonly (readonly number[])[] = [
  [0.97, 0.96, 0.96, 0.95, 0.94, 0.82, 0.81, 0.81, 0.8, 0.8, 0.79, 0.79, 0.78, 0.78],
  [0.97, 0.96, 0.96, 0.96, 0.95, 0.95, 0.95, 0.94, 0.94],
  [0.97, 0.96, 0.96, 0.95, 0.95, 0.94, 0.94],
];
const LOADINGS = DRIVERS.flatMap((loadings, driver) =>
  loadings.map((loading): [number, number] => [driver, loading]),
);

/** Sensors read in their own units, from hundredths to thousands: PCA must standardise them. */
const SPREADS = [0.04, 0.6, 2.5, 15, 80, 400, 2500] as const;

function readings(): string {
  const next = random(SEED);
  const order = LOADINGS.map((loading) => ({ loading, at: next() })).sort((a, b) => a.at - b.at);
  const sensors = order.map(({ loading: [driver, loading] }, index) => {
    const spread = SPREADS[index % SPREADS.length] ?? 1;
    return {
      driver,
      loading,
      spread,
      centre: spread * (5 + 20 * next()),
      places: Math.max(0, 3 - Math.floor(Math.log10(spread))),
    };
  });
  const rows: (string | number)[][] = [
    ["Reading", ...sensors.map((_, index) => `S${String(index + 1).padStart(2, "0")}`)],
  ];
  for (let reading = 0; reading < READINGS; reading++) {
    const drivers = [normal(next), normal(next), normal(next)];
    rows.push([
      `R${String(reading + 1).padStart(4, "0")}`,
      ...sensors.map(({ driver, loading, spread, centre, places }) => {
        const standard =
          loading * (drivers[driver] ?? 0) + Math.sqrt(1 - loading ** 2) * normal(next);
        return round(centre + spread * standard, places);
      }),
    ]);
  }
  return csv(rows);
}

export const task: Task = {
  id: "M04",
  title: "Principal components of sensor readings",
  needs: ["P"],
  seed: SEED,
  question: {
    en: "Plant sensor readings.csv has 3,000 readings of 30 sensors, S01 to S30, each in its own units. Run a principal component analysis on the standardised sensors (each scaled to mean 0 and standard deviation 1). What share of the variance do PC1 and PC2 explain, and how many components does it take to explain at least 80% of it? Which five sensors have the largest weights in PC1 (its unit-length eigenvector, as scikit-learn's components_ gives it), and what are their weights? Draw a scree plot.",
  },
  inputs: () => {
    const text = readings();
    return { files: [{ name: NAME, bytes: utf8(text) }], data: { "readings.csv": text } };
  },
  expect: [
    {
      id: "pc1_share",
      kind: "number",
      label: "Variance explained by PC1",
      unit: "percent",
      tolerance: { abs: 0.002 },
      near: /PC ?1\b|first (?:principal )?component|第一主成分|主成分 ?1\b|第 ?1 ?(?:个)?主成分/i,
    },
    {
      id: "pc2_share",
      kind: "number",
      label: "Variance explained by PC2",
      unit: "percent",
      tolerance: { abs: 0.002 },
      near: /PC ?2\b|second (?:principal )?component|第二主成分|主成分 ?2\b|第 ?2 ?(?:个)?主成分/i,
    },
    {
      id: "components_80",
      kind: "number",
      label: "Components needed for 80% of the variance",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /80\s*%|components|主成分/i,
    },
    {
      id: "pc1_top",
      kind: "rows",
      label: "The five sensors with the largest weights in PC1",
      key: /\bS\d{2}\b/g,
      columns: [{ id: "weight", unit: "plain", tolerance: { abs: 0.005 }, signless: true }],
    },
    { id: "scree", kind: "picture", label: "Scree plot", count: 1 },
  ],
  sources: { documents: [NAME] },
};
