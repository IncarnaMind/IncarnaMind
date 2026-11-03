import { csv, random, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Store survey 2026.csv";
const SEED = 1003;
const STORES = ["Millbrook", "Quayside", "Elmstead", "Kestrel Park"] as const;
const SMALL_STORE = "Harbour Point";
const BANDS = ["18-29", "30-44", "45-59", "60+"] as const;
const CHANNELS = ["In store", "Online", "Phone"] as const;
const RESPONDENTS = 1200;

/** Each age band's share of respondents, and its chances of preferring each channel. */
const BAND_SHARES = [0.25, 0.3, 0.27, 0.18] as const;
const CHANNEL_CHANCES = [
  [0.35, 0.5, 0.15],
  [0.39, 0.46, 0.15],
  [0.42, 0.41, 0.17],
  [0.45, 0.36, 0.19],
] as const;

/**
 * Harbour Point's 24 respondents as [loyalty member, would recommend, how many]: a 2x2 whose
 * expected counts fall under 5, so Fisher's exact test is the one that fits there.
 */
const SMALL_STORE_CELLS = [
  [true, true, 8],
  [true, false, 1],
  [false, true, 4],
  [false, false, 11],
] as const;

const pick = (next: () => number, chances: readonly number[]): number => {
  let left = next();
  for (const [index, chance] of chances.entries()) {
    left -= chance;
    if (left < 0) return index;
  }
  return chances.length - 1;
};

function shuffled<T>(next: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let at = out.length - 1; at > 0; at--) {
    const other = Math.floor(next() * (at + 1));
    const here = out[at];
    const there = out[other];
    if (here === undefined || there === undefined) continue;
    out[at] = there;
    out[other] = here;
  }
  return out;
}

function respondents() {
  const next = random(SEED);
  const small = shuffled(
    next,
    SMALL_STORE_CELLS.flatMap(([member, recommends, count]) =>
      Array.from({ length: count }, () => ({ member, recommends })),
    ),
  );
  const stores = shuffled(next, [
    ...small.map(() => SMALL_STORE),
    ...Array.from(
      { length: RESPONDENTS - small.length },
      () => STORES[Math.floor(next() * STORES.length)] ?? "Millbrook",
    ),
  ]);
  let seen = 0;
  return stores.map((store, index) => {
    const band = pick(next, BAND_SHARES);
    const channel = pick(next, CHANNEL_CHANCES[band] ?? CHANNEL_CHANCES[0]);
    let member = next() < 0.35;
    let recommends = next() < (member ? 0.7 : 0.45);
    if (store === SMALL_STORE) {
      const cell = small[seen++];
      member = cell?.member ?? member;
      recommends = cell?.recommends ?? recommends;
    }
    return {
      id: `R${String(index + 1).padStart(4, "0")}`,
      store,
      band: BANDS[band] ?? "18-29",
      channel: CHANNELS[channel] ?? "In store",
      member: member ? "Yes" : "No",
      recommends: recommends ? "Yes" : "No",
    };
  });
}

function inputs() {
  const rows = respondents();
  return {
    files: [
      {
        name: NAME,
        bytes: utf8(
          csv([
            [
              "Respondent",
              "Store",
              "Age band",
              "Preferred channel",
              "Loyalty member",
              "Would recommend",
            ],
            ...rows.map((row) => [
              row.id,
              row.store,
              row.band,
              row.channel,
              row.member,
              row.recommends,
            ]),
          ]),
        ),
      },
    ],
    data: {
      "respondents.csv": csv([
        ["store", "band", "channel", "member", "recommends"],
        ...rows.map((row) => [row.store, row.band, row.channel, row.member, row.recommends]),
      ]),
    },
  };
}

export const task: Task = {
  id: "S03",
  title: "Survey cross-table",
  needs: ["P"],
  seed: SEED,
  question: {
    en: "Store survey 2026.csv has one row per respondent. Is the preferred channel related to the age band? Build the cross-table of age band by preferred channel and run a chi-square test of independence: give the chi-square statistic, its degrees of freedom, the p-value and Cramér's V. Check the rule that every expected count is at least 5. Then, for the Harbour Point store alone, build the 2x2 table of loyalty member by would recommend and test whether the two are related: check the same rule there, and where it fails, use Fisher's exact test (two-sided) and give its p-value.",
  },
  inputs,
  expect: [
    {
      id: "chi2",
      kind: "number",
      label: "Chi-square statistic, age band by channel",
      unit: "plain",
      tolerance: { abs: 0.05 },
      near: /chi|χ|卡方/i,
    },
    {
      id: "dof",
      kind: "number",
      label: "Degrees of freedom",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /degrees of freedom|\bdf\b|\bdof\b|自由度|χ²?\s*\(|chi-?square\s*\(/i,
    },
    {
      id: "chi_p",
      kind: "number",
      label: "Chi-square p-value",
      unit: "plain",
      // Well under 0.001: "p < 0.001" is as right as the value itself.
      tolerance: { abs: 0.0008 },
      near: /p-?value|\bp\s*[<=≈]|p 值|p值/i,
    },
    {
      // Without or with the bias correction: reference.py gives both.
      id: "cramers_v",
      kind: "number",
      label: "Cramér's V",
      unit: "plain",
      tolerance: { abs: 0.005 },
      near: /cram|\bV\b|克莱姆|克拉默/i,
    },
    {
      id: "expected_rule",
      kind: "mention",
      label: "Checks the expected counts",
      match:
        /expected (?:cell )?(?:counts?|frequenc(?:y|ies)|values?)|期望频数|理论频数|期望值|期望计数/i,
    },
    {
      id: "fisher_p",
      kind: "number",
      label: "Fisher's exact p-value at Harbour Point",
      unit: "plain",
      // Leaves out the chi-square p-values at Harbour Point, 0.0032 and, with Yates's correction, 0.0114.
      tolerance: { abs: 0.0007 },
      near: /fisher|精确检验/i,
    },
    {
      id: "fisher",
      kind: "mention",
      label: "Uses Fisher's exact test where the rule fails",
      match: /fisher|费希尔|费舍尔/i,
    },
  ],
  sources: { documents: [NAME] },
};
