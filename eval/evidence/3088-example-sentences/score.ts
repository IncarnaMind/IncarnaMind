/**
 * Scores the #3088 gate (README.md beside it) from the JSON lines `tests/live/exampleSentences.live.test.ts`
 * wrote: each arm's counts per case, the void rounds, and each bar met or not. Needs no model.
 *
 *   node --import ./scripts/tsResolve.mjs eval/evidence/3088-example-sentences/score.ts <file>...
 */
import { readFileSync } from "node:fs";

interface Row {
  arm: string;
  round: number;
  group: "example" | "held-out" | "run";
  language?: string;
  setup?: string;
  case?: string;
  kind?: string;
  sentence?: string;
  expected?: "right" | "wrong";
  state?: string;
  reason?: string | null;
  figures?: { shown: string; state: string; reason: string | null }[];
  part?: string;
  partVerdict?: string | null;
  firstReply?: string | null;
  requests?: number;
  refused?: number;
  failed?: number;
  timedOut?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** A check's own reason that says a request of it failed: its round is void. */
const FAILED_REASONS = new Set([
  "rate-limit",
  "failed",
  "timed-out",
  "out-of-credit",
  "cost-cap",
  "plan-limit",
]);

const rows: Row[] = process.argv
  .slice(2)
  .flatMap((file) => readFileSync(file, "utf8").split("\n"))
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Row);

const roundKey = (row: Pick<Row, "arm" | "round">) => `${row.arm}#${row.round}`;
const voids = new Map<string, string>();
for (const row of rows) {
  if (row.group === "run" && (row.refused ?? 0) + (row.failed ?? 0) + (row.timedOut ?? 0) > 0)
    voids.set(
      roundKey(row),
      `${row.refused} refused, ${row.failed} failed, ${row.timedOut} timed out`,
    );
  if (row.group !== "run" && row.reason && FAILED_REASONS.has(row.reason))
    voids.set(roundKey(row), `a check read ${row.reason}`);
  for (const figure of row.figures ?? [])
    if (figure.reason && FAILED_REASONS.has(figure.reason))
      voids.set(roundKey(row), `a figure read ${figure.reason}`);
}
const counted = rows.filter((row) => row.group !== "run" && !voids.has(roundKey(row)));
const arms = [...new Set(rows.map((row) => row.arm))];

interface Tally {
  checks: number;
  supported: number;
  partSupported: number;
  firstContradicted: number;
  figureNotChecked: number;
}
const tallies = new Map<string, Map<string, Tally>>();
const caseKey = (row: Row) =>
  [row.group, row.language, row.setup ?? row.kind ?? "", row.case, row.sentence, row.expected].join(
    " | ",
  );
for (const row of counted) {
  const byArm = tallies.get(caseKey(row)) ?? new Map<string, Tally>();
  tallies.set(caseKey(row), byArm);
  const tally = byArm.get(row.arm) ?? {
    checks: 0,
    supported: 0,
    partSupported: 0,
    firstContradicted: 0,
    figureNotChecked: 0,
  };
  byArm.set(row.arm, tally);
  tally.checks++;
  if (row.state === "supported") tally.supported++;
  if (row.partVerdict === "supported") tally.partSupported++;
  if (row.firstReply === "contradicted") tally.firstContradicted++;
  if ((row.figures ?? []).some((figure) => figure.state === "not-checked"))
    tally.figureNotChecked++;
}

const lines: string[] = [
  "| Case | Arm | ✓ | part ✓ | first reply contradicted | a figure Not checked |",
  "|---|---|---|---|---|---|",
];
for (const [key, byArm] of [...tallies].sort(([a], [b]) => a.localeCompare(b)))
  for (const arm of arms) {
    const t = byArm.get(arm);
    if (t)
      lines.push(
        `| ${key} | ${arm} | ${t.supported}/${t.checks} | ${t.partSupported}/${t.checks} | ${t.firstContradicted}/${t.checks} | ${t.figureNotChecked}/${t.checks} |`,
      );
  }

const tally = (key: string, arm: string) => tallies.get(key)?.get(arm);
const bars: string[] = [];
const bar = (name: string, met: boolean, detail: string) =>
  bars.push(`- ${met ? "met" : "**missed**"}: ${name} (${detail})`);

// Bar 1: on the branch, each language and set-up, the issue's two sentences.
for (const [key, byArm] of tallies) {
  if (!key.startsWith("example") || !key.includes("| note |")) continue;
  const t = byArm.get("branch");
  if (!t) continue;
  bar(
    `${key}: ✓ in at least 9 of 10`,
    t.supported >= 9 && t.checks >= 10,
    `${t.supported}/${t.checks}`,
  );
  if (key.includes("EBITDA") || key.includes("基础"))
    bar(
      `${key}: first reply contradicted in at most 1`,
      t.firstContradicted <= 1,
      `${t.firstContradicted}/${t.checks}`,
    );
  else if (key.includes("example+own"))
    bar(
      `${key}: no figure Not checked`,
      t.figureNotChecked === 0,
      `${t.figureNotChecked}/${t.checks}`,
    );
}
// Bar 2: no wrong sentence gains a ✓ on the branch.
for (const key of tallies.keys()) {
  if (!key.endsWith("| wrong")) continue;
  const main = tally(key, "main");
  const branch = tally(key, "branch");
  if (!main || !branch) continue;
  bar(
    `${key}: no ✓ gained`,
    branch.supported <= main.supported,
    `main ${main.supported}/${main.checks}, branch ${branch.supported}/${branch.checks}`,
  );
}
// Bar 3: no held-out right sentence loses a ✓: 3 or more fewer of 10 in a case, or 10 or more in all.
let mainRight = 0;
let branchRight = 0;
for (const key of tallies.keys()) {
  if (!key.startsWith("held-out") || !key.endsWith("| right")) continue;
  const main = tally(key, "main");
  const branch = tally(key, "branch");
  if (!main || !branch) continue;
  mainRight += main.supported;
  branchRight += branch.supported;
  bar(
    `${key}: no ✓ lost`,
    branch.supported > main.supported - 3,
    `main ${main.supported}/${main.checks}, branch ${branch.supported}/${branch.checks}`,
  );
}
bar(
  "held-out right sentences, all: no ✓ lost",
  branchRight > mainRight - 10,
  `main ${mainRight}, branch ${branchRight}`,
);

const runs = rows.filter((row) => row.group === "run");
console.log(
  [
    "## Rounds",
    "",
    ...runs.map(
      (run) =>
        `- ${run.arm} round ${run.round}: ${run.requests} requests, ${run.refused} refused, ${run.failed} failed, ${run.timedOut} timed out, ${run.inputTokens} input and ${run.outputTokens} output tokens${voids.has(roundKey(run)) ? `, **void** (${voids.get(roundKey(run))})` : ""}`,
    ),
    "",
    "## Cases",
    "",
    ...lines,
    "",
    "## Bars",
    "",
    ...bars,
  ].join("\n"),
);
