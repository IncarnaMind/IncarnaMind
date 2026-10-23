/**
 * `node --import ./scripts/tsResolve.mjs eval/citation-confidence/report.ts --run <scores folder> [--variant yes-no-context] [...]`
 * prints, as Markdown, how well the saved probabilities (score.ts) tell the pairs whose quote
 * states the sentence from the rest: AUC, a reliability table, the threshold for 99% precision
 * (chosen on the "dev" half, reported on the "test" half), the worst misses, latency and cost.
 * `--pairs` is a file made by recorded.ts (the evaluation's own pairs by default); `--checks-report` and `--repeats` add
 * the check's own recorded verdicts for comparison.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { auc, cut, lowerBound, quantile, reliability, type Scored, thresholdFor } from "./metrics";
import { loadPairs } from "./pairs";
import type { Pair, Score } from "./types";
import { VARIANTS } from "./variants";

const args = parseArgs({
  options: {
    run: { type: "string" },
    pairs: { type: "string" },
    variant: { type: "string", default: "yes-no-context" },
    "checks-report": { type: "string" },
    repeats: { type: "string" },
    noise: { type: "string" },
    "versus-pairs": { type: "string" },
    "versus-run": { type: "string" },
    price: { type: "string", default: "0.042" },
  },
});
if (!args.values.run) throw new Error("--run <scores folder> is required");

const pairs = loadPairs(args.values.pairs);
const byId = new Map(pairs.map((each) => [each.id, each]));
const pct = (value: number, digits = 0) =>
  Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(digits)}%`;
const fixed = (value: number, digits = 3) => (Number.isNaN(value) ? "n/a" : value.toFixed(digits));

function load(variant: string): Score[] {
  const file = join(args.values.run ?? "", `scores-${variant}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Score);
}

type Row = Scored & { pair: Pair; score: number };

function rows(variant: string, keep: (pair: Pair) => boolean = () => true): Row[] {
  return load(variant).flatMap((each) => {
    const pair = byId.get(each.pair);
    return pair && keep(pair)
      ? [{ pair, score: each.supports, positive: pair.label === "SUPPORTS" }]
      : [];
  });
}

const clean = (pair: Pair) => !pair.caveat;
const table = (head: string[], body: (string | number)[][]) =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

const variant = args.values.variant;
const chosen = rows(variant);
const count = (list: readonly Row[], label: Pair["label"]) =>
  list.filter((each) => each.pair.label === label).length;

console.log(`## Pairs (${variant}, ${pairs.length} pairs, ${chosen.length} scored)\n`);
console.log(
  table(
    ["", "SUPPORTS", "PARTLY", "NOT", "All"],
    [
      ...(["en", "zh"] as const).map((language) => {
        const list = chosen.filter((each) => each.pair.language === language);
        return [
          language,
          count(list, "SUPPORTS"),
          count(list, "PARTLY"),
          count(list, "NOT"),
          list.length,
        ];
      }),
      [
        "All",
        count(chosen, "SUPPORTS"),
        count(chosen, "PARTLY"),
        count(chosen, "NOT"),
        chosen.length,
      ],
      [
        "Without table rows and bare names",
        ...(() => {
          const list = chosen.filter((each) => clean(each.pair));
          return [count(list, "SUPPORTS"), count(list, "PARTLY"), count(list, "NOT"), list.length];
        })(),
      ],
    ],
  ),
);

console.log("\n## The prompts, AUC for SUPPORTS against the rest\n");
console.log(
  table(
    ["Prompt", "dev (all)", "dev (clean)", "test (all)", "test (clean)", "all (clean)"],
    Object.keys(VARIANTS).map((id) => {
      const list = rows(id);
      const part = (split: string, only: (pair: Pair) => boolean) =>
        fixed(
          auc(
            list.filter(
              (each) => (split === "all" || each.pair.split === split) && only(each.pair),
            ),
          ),
        );
      return [
        id,
        part("dev", () => true),
        part("dev", clean),
        part("test", () => true),
        part("test", clean),
        part("all", clean),
      ];
    }),
  ),
);

const devOnly = chosen.filter((each) => each.pair.split === "dev");
const testOnly = chosen.filter((each) => each.pair.split === "test");
const cleanChosen = chosen.filter((each) => clean(each.pair));

console.log(`\n## ${variant}: AUC\n`);
const aucRows: [string, readonly Row[]][] = [
  ["All pairs", chosen],
  ["Without table rows and bare names", cleanChosen],
  ["dev half (clean)", devOnly.filter((each) => clean(each.pair))],
  ["test half (clean)", testOnly.filter((each) => clean(each.pair))],
  ["English (clean)", cleanChosen.filter((each) => each.pair.language === "en")],
  ["Chinese (clean)", cleanChosen.filter((each) => each.pair.language === "zh")],
  ["Table rows and bare names only", chosen.filter((each) => !clean(each.pair))],
];
console.log(
  table(
    ["Set", "Pairs", "SUPPORTS", "AUC"],
    aucRows.map(([name, list]) => [
      name,
      list.length,
      list.filter((each) => each.positive).length,
      fixed(auc(list)),
    ]),
  ),
);
const against = (label: Pair["label"], list: readonly Row[]) =>
  auc(list.filter((each) => each.positive || each.pair.label === label));
console.log(
  `\nSUPPORTS against NOT only: ${fixed(against("NOT", cleanChosen))}. SUPPORTS against PARTLY only: ${fixed(against("PARTLY", cleanChosen))} (clean pairs).`,
);
console.log("\nBy where the pair comes from (clean pairs):\n");
const sources = ["labels", "recorded", "repeats", "handmade", "hard", "mutation"] as const;
console.log(
  table(
    ["Source", "Pairs", "SUPPORTS", "PARTLY", "NOT", "AUC"],
    sources.flatMap((source) => {
      const list = cleanChosen.filter((each) => each.pair.source === source);
      return list.length === 0
        ? []
        : [
            [
              source,
              list.length,
              count(list, "SUPPORTS"),
              count(list, "PARTLY"),
              count(list, "NOT"),
              fixed(auc(list)),
            ],
          ];
    }),
  ),
);

console.log(
  "\n## Reliability: the share of pairs that truly are SUPPORTS, by the probability given\n",
);
const edges = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.95, 1];
const bins = (list: readonly Row[]) => reliability(list, edges);
console.log(
  table(
    [
      "Probability",
      "Pairs (clean)",
      "Truly SUPPORTS (clean)",
      "Rate (clean)",
      "Rate, test half only (n)",
    ],
    bins(cleanChosen).map((bin, index) => {
      const onlyTest = bins(testOnly.filter((each) => clean(each.pair)))[index];
      return [
        `${bin.from.toFixed(2)} to ${bin.to.toFixed(2)}`,
        bin.count,
        bin.positives,
        pct(bin.positives / bin.count),
        onlyTest ? `${pct(onlyTest.positives / onlyTest.count)} (${onlyTest.count})` : "",
      ];
    }),
  ),
);

console.log('\n## Threshold: precision and coverage of "this quote states the sentence"\n');
console.log(
  table(
    [
      "Threshold",
      "Judged SUPPORTS",
      "Wrong",
      "Precision",
      "Lower bound (95%)",
      "Coverage of true SUPPORTS",
    ],
    [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.97, 0.99].map((threshold) => {
      const here = cut(cleanChosen, threshold);
      return [
        threshold,
        here.predicted,
        here.falsePositives,
        pct(here.precision, 1),
        pct(here.precisionLower, 1),
        pct(here.coverage, 1),
      ];
    }),
  ),
);
console.log("\nThe same with the table rows, calculated figures and bare names kept in:\n");
console.log(
  table(
    [
      "Threshold",
      "Judged SUPPORTS",
      "Wrong",
      "Precision",
      "Lower bound (95%)",
      "Coverage of true SUPPORTS",
    ],
    [0.5, 0.6, 0.7, 0.9].map((threshold) => {
      const here = cut(chosen, threshold);
      return [
        threshold,
        here.predicted,
        here.falsePositives,
        pct(here.precision, 1),
        pct(here.precisionLower, 1),
        pct(here.coverage, 1),
      ];
    }),
  ),
);
const devClean = devOnly.filter((each) => clean(each.pair));
const testClean = testOnly.filter((each) => clean(each.pair));
for (const target of [0.99, 0.95]) {
  const threshold = thresholdFor(devClean, target);
  if (threshold === null) {
    console.log(`\nNo threshold reaches ${pct(target)} precision on the dev half.`);
    continue;
  }
  const onDev = cut(devClean, threshold);
  const onTest = cut(testClean, threshold);
  console.log(
    `\nChosen on the dev half for ${pct(target)} precision: ${threshold.toFixed(2)}. Dev: ${onDev.predicted} judged, ${onDev.falsePositives} wrong, coverage ${pct(onDev.coverage, 1)}. Test: ${onTest.predicted} judged, ${onTest.falsePositives} wrong, precision ${pct(onTest.precision, 1)} (95% lower bound ${pct(onTest.precisionLower, 1)}), coverage ${pct(onTest.coverage, 1)}.`,
  );
}
const chosenThreshold = thresholdFor(devClean, 0.99);
if (chosenThreshold !== null) {
  console.log(
    `\nAt ${chosenThreshold.toFixed(2)}, the dev half's choice for 99% precision, by language (clean pairs, both halves):\n`,
  );
  console.log(
    table(
      ["Language", "Judged SUPPORTS", "Wrong", "Precision", "Coverage of true SUPPORTS"],
      (["en", "zh"] as const).map((language) => {
        const here = cut(
          cleanChosen.filter((each) => each.pair.language === language),
          chosenThreshold,
        );
        return [
          language,
          here.predicted,
          here.falsePositives,
          pct(here.precision, 1),
          pct(here.coverage, 1),
        ];
      }),
    ),
  );
}
const trueSupports = cleanChosen.filter((each) => each.positive).length;
console.log(
  `\nTo claim 99% precision with 95% confidence you need at least ${Math.ceil(Math.log(0.05) / Math.log(0.99))} correct and no wrong one: the ${trueSupports} SUPPORTS pairs here cannot certify it at full coverage.`,
);

console.log(
  "\n## Pairs by kind (clean pairs): the share scoring at least 0.5 and 0.9, and the mean\n",
);
const kinds = new Map<string, Row[]>();
for (const each of cleanChosen) {
  const kind = `${each.pair.label} ${each.pair.source === "labels" ? each.pair.kind.split(":")[0] : each.pair.kind}`;
  kinds.set(kind, [...(kinds.get(kind) ?? []), each]);
}
console.log(
  table(
    ["Label and kind", "Pairs", "Mean", ">= 0.5", ">= 0.9"],
    [...kinds.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, list]) => [
        kind,
        list.length,
        fixed(list.reduce((sum, each) => sum + each.score, 0) / list.length, 2),
        pct(list.filter((each) => each.score >= 0.5).length / list.length),
        pct(list.filter((each) => each.score >= 0.9).length / list.length),
      ]),
  ),
);

console.log("\n## Highest-scoring pairs that are not SUPPORTS (clean pairs)\n");
console.log(
  table(
    ["Score", "Label", "Kind", "Sentence", "Quote"],
    cleanChosen
      .filter((each) => !each.positive)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((each) => [
        each.score.toFixed(2),
        each.pair.label,
        each.pair.kind,
        each.pair.sentence,
        each.pair.quote,
      ]),
  ),
);
console.log("\n## Lowest-scoring SUPPORTS pairs (clean pairs)\n");
console.log(
  table(
    ["Score", "Kind", "Sentence", "Quote"],
    cleanChosen
      .filter((each) => each.positive)
      .sort((a, b) => a.score - b.score)
      .slice(0, 15)
      .map((each) => [each.score.toFixed(2), each.pair.kind, each.pair.sentence, each.pair.quote]),
  ),
);

const line = thresholdFor(devClean, 0.99) ?? 0.5;
console.log("\n## Pairs a quote cannot settle alone\n");
console.log(
  table(
    [
      "Caveat",
      "Pairs",
      "SUPPORTS",
      "Mean score of SUPPORTS",
      `SUPPORTS at or above ${line.toFixed(2)}`,
      "Mean score of the rest",
      `The rest at or above ${line.toFixed(2)}`,
    ],
    (["table-row", "calculated", "needs-context"] as const).flatMap((caveat) => {
      const list = chosen.filter((each) => each.pair.caveat === caveat);
      if (list.length === 0) return [];
      const yes = list.filter((each) => each.positive);
      const no = list.filter((each) => !each.positive);
      const mean = (items: readonly Row[]) =>
        items.length === 0
          ? "n/a"
          : fixed(items.reduce((sum, each) => sum + each.score, 0) / items.length, 2);
      const above = (items: readonly Row[]) =>
        `${items.filter((each) => each.score >= line).length} of ${items.length}`;
      return [[caveat, list.length, yes.length, mean(yes), above(yes), mean(no), above(no)]];
    }),
  ),
);

if (args.values.noise) {
  const runs = [args.values.run, ...args.values.noise.split(",")].map((folder) => {
    const file = join(folder ?? "", `scores-${variant}.jsonl`);
    return new Map(
      readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const each = JSON.parse(line) as Score;
          return [each.pair, each.supports] as const;
        }),
    );
  });
  const first = runs[0] ?? new Map<string, number>();
  const shared = [...first.keys()].filter((id) => runs.every((each) => each.has(id)));
  const spread = shared.map((id) => {
    const values = runs.map((each) => each.get(id) ?? 0);
    return Math.max(...values) - Math.min(...values);
  });
  const flips = shared.filter((id) => {
    const sides = new Set(runs.map((each) => (each.get(id) ?? 0) >= line));
    return sides.size > 1;
  });
  console.log(
    `\n## Noise: the same ${shared.length} requests asked ${runs.length} times\n\nThe answers are not repeatable. The spread between the highest and lowest of a pair's answers: mean ${fixed(spread.reduce((a, b) => a + b, 0) / spread.length)}, 90th percentile ${fixed(quantile(spread, 0.9))}, largest ${fixed(Math.max(...spread))}; identical in ${spread.filter((each) => each === 0).length} pairs. ${flips.length} pairs fell on both sides of ${line.toFixed(2)} (${flips.map((id) => `${id} ${runs.map((each) => (each.get(id) ?? 0).toFixed(2)).join("/")}`).join("; ") || "none"}).`,
  );
}

const scores = load(variant);
const price = Number(args.values.price);
const tokens = scores.reduce((sum, each) => sum + each.inputTokens, 0);
console.log("\n## Latency and cost\n");
console.log(
  `Models answering: ${[...new Set(scores.map((each) => each.model))].join(", ")}. ${scores.length} requests, median ${Math.round(
    quantile(
      scores.map((each) => each.ms),
      0.5,
    ),
  )} ms, 90th percentile ${Math.round(
    quantile(
      scores.map((each) => each.ms),
      0.9,
    ),
  )} ms, 99th ${Math.round(
    quantile(
      scores.map((each) => each.ms),
      0.99,
    ),
  )} ms (6 requests at a time). ${Math.round(tokens / scores.length)} input tokens a request, so $${((tokens * price) / 1e6).toFixed(4)} for these ${scores.length}, $${((((tokens / scores.length) * price) / 1e6) * 1000).toFixed(3)} per thousand.`,
);

console.log("\n## Three bands\n");
const devForBands = devClean;
const high = thresholdFor(devForBands, 0.99) ?? 0.9;
let low = 0;
for (let step = 1; step < high * 100; step++) {
  const below = devForBands.filter((each) => each.score < step / 100);
  if (below.length >= 20 && below.filter((each) => each.positive).length / below.length <= 0.02)
    low = step / 100;
}
console.log(
  `Cut-offs chosen on the dev half: reliable at ${high.toFixed(2)} and above (99% precision); doubtful below ${low.toFixed(2)} (at most 2% of the pairs below it truly are SUPPORTS); fair between.\n`,
);
const band = (list: readonly Row[]) =>
  [
    ["reliable", list.filter((each) => each.score >= high)],
    ["fair", list.filter((each) => each.score >= low && each.score < high)],
    ["doubtful", list.filter((each) => each.score < low)],
  ] as const;
console.log(
  table(
    [
      "Band",
      "Pairs (test)",
      "Truly SUPPORTS",
      "Rate",
      "Lower bound",
      "PARTLY",
      "NOT",
      "All clean pairs: n",
      "Rate",
    ],
    band(testClean).map(([name, list], index) => {
      const hits = list.filter((each) => each.positive).length;
      const whole = band(cleanChosen)[index]?.[1] ?? [];
      return [
        name,
        list.length,
        hits,
        pct(hits / list.length),
        pct(lowerBound(hits, list.length)),
        count(list, "PARTLY"),
        count(list, "NOT"),
        whole.length,
        pct(whole.filter((each) => each.positive).length / whole.length),
      ];
    }),
  ),
);

if (args.values["checks-report"]) {
  const report = JSON.parse(readFileSync(args.values["checks-report"], "utf8")) as {
    results: { findSupport: { id: string; outcome: { verdict: string } }[] };
  };
  const verdicts = new Map(
    report.results.findSupport.map((each) => [each.id, each.outcome.verdict]),
  );
  const shared = cleanChosen.filter((each) => verdicts.has(each.pair.id));
  const haiku = shared.filter((each) => verdicts.get(each.pair.id) === "supported");
  const right = haiku.filter((each) => each.positive).length;
  const trueCount = shared.filter((each) => each.positive).length;
  const jev = cut(shared, thresholdFor(devClean, 0.99) ?? 0.9);
  console.log("\n## The check on Claude Haiku 5.5, recorded, on the same sentences\n");
  console.log(
    table(
      ["Judge", "Sentences", "Judged SUPPORTS", "Wrong", "Precision", "Coverage"],
      [
        [
          "Claude Haiku 5.5, the whole check (searches the Folder)",
          shared.length,
          haiku.length,
          haiku.length - right,
          pct(right / haiku.length, 1),
          pct(right / trueCount, 1),
        ],
        [
          `Jev on the labelled quote at ${jev.threshold.toFixed(2)}`,
          shared.length,
          jev.predicted,
          jev.falsePositives,
          pct(jev.precision, 1),
          pct(jev.coverage, 1),
        ],
      ],
    ),
  );
}

if (args.values.repeats) {
  type Repeat = { rows: { sentence: string; outcome: string }[] };
  const outcomes = new Map<string, Map<string, number>>();
  for (const file of args.values.repeats.split(",")) {
    for (const row of (JSON.parse(readFileSync(file, "utf8")) as Repeat).rows) {
      const counts = outcomes.get(row.sentence) ?? new Map<string, number>();
      counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
      outcomes.set(row.sentence, counts);
    }
  }
  console.log("\n## The repeated checks on Claude Haiku 5.5 beside Jev, per sentence\n");
  console.log(
    table(
      ["Label", "Kind", "Sentence", "Jev", "Haiku check outcomes"],
      chosen
        .filter((each) => each.pair.source === "repeats" && outcomes.has(each.pair.sentence))
        .sort((a, b) => a.pair.label.localeCompare(b.pair.label))
        .map((each) => [
          each.pair.label,
          each.pair.kind,
          each.pair.sentence,
          each.score.toFixed(2),
          [...(outcomes.get(each.pair.sentence) ?? new Map()).entries()]
            .map(([name, n]) => `${n} ${name}`)
            .join(", "),
        ]),
    ),
  );
}

if (args.values["versus-pairs"] && args.values["versus-run"]) {
  const other: Pair[] = JSON.parse(readFileSync(args.values["versus-pairs"], "utf8"));
  const otherScores = new Map(
    readFileSync(join(args.values["versus-run"], `scores-${variant}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const each = JSON.parse(line) as Score;
        return [each.pair, each.supports] as const;
      }),
  );
  const both = other.flatMap((each) => {
    const mine = chosen.find((row) => `rec:${row.pair.id}` === each.id);
    const theirs = otherScores.get(each.id);
    return mine &&
      theirs !== undefined &&
      each.label === "SUPPORTS" &&
      mine.positive &&
      !mine.pair.caveat &&
      !each.caveat
      ? [
          {
            mine,
            theirs,
            longer: each.quote.length > mine.pair.quote.length * 1.3,
            same: each.quote === mine.pair.quote,
          },
        ]
      : [];
  });
  const changed = both.filter((each) => !each.same);
  const longer = both.filter((each) => each.longer);
  const mean = (values: number[]) =>
    values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
  console.log(
    `\n## The labelled quote against the quote the check cited, for the same SUPPORTS sentences\n\n${both.length} sentences; the check cited another quote for ${changed.length}, and a quote over 30% longer for ${longer.length}. For those ${longer.length} the mean probability goes from ${fixed(mean(longer.map((each) => each.mine.score)), 2)} (labelled quote, the shortest span that backs the sentence) to ${fixed(mean(longer.map((each) => each.theirs)), 2)} (cited quote). Over all ${both.length}: ${fixed(mean(both.map((each) => each.mine.score)), 2)} and ${fixed(mean(both.map((each) => each.theirs)), 2)}.`,
  );
}
