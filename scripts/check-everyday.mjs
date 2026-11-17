// The two numbers a pull request gives when it changes a check's verdict: on the everyday set
// (tests/live/everydaySentences.cases.ts), how many right sentences get their ✓ and how many
// wrong twins do, each Note checked once as Check this Note does, on Claude Haiku 5.5.
//
//   INCARNAMIND_LIVE_ANTHROPIC_KEY=… npm run check:everyday
//   npm run check:everyday -- --dry          nothing is sent: a scripted judge, to see it runs
//   npm run check:everyday -- --out run.jsonl keeps every check's line
//
// About US$0.08 a run (60 checks); it stops before US$0.30. A run with a refused, failed or
// timed-out request gives no numbers: run it again.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STOP_USD = "0.30";
const MODEL = "claude-haiku-5-5";
const { values } = parseArgs({
  options: { dry: { type: "boolean", default: false }, out: { type: "string" } },
});

if (!values.dry && !process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY) {
  console.error("Set INCARNAMIND_LIVE_ANTHROPIC_KEY, or pass --dry to send nothing.");
  process.exit(2);
}

const scratch = values.out ? null : mkdtempSync(join(tmpdir(), "everyday-"));
const out = values.out ? resolve(values.out) : join(scratch, "run.jsonl");
if (values.out) rmSync(out, { force: true });

const run = spawnSync("npx", ["vitest", "run", "tests/live/exampleSentences.live.test.ts"], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    INCARNAMIND_LIVE_GATE_GROUPS: "everyday",
    INCARNAMIND_LIVE_GATE_ARM: "everyday",
    INCARNAMIND_LIVE_GATE_OUT: out,
    INCARNAMIND_LIVE_GATE_STOP_USD: STOP_USD,
    INCARNAMIND_LIVE_ANTHROPIC_MODEL: process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? MODEL,
    ...(values.dry ? { INCARNAMIND_LIVE_GATE_DRY: "1" } : {}),
  },
});

let rows = [];
try {
  rows = readFileSync(out, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
} catch {
  console.error("The run wrote no results.");
}
if (scratch) rmSync(scratch, { recursive: true, force: true });

const summary = rows.find((row) => row.group === "run");
const checks = rows.filter((row) => row.group === "everyday");
const valid =
  run.status === 0 &&
  summary?.complete === true &&
  !summary.refused &&
  !summary.failed &&
  !summary.timedOut;
if (!valid) {
  console.error(
    `No numbers: the run didn't finish cleanly (${summary ? `refused ${summary.refused}, failed ${summary.failed}, timed out ${summary.timedOut}, complete ${summary.complete}` : "no summary line"}).`,
  );
  process.exit(1);
}

const side = (expected) => checks.filter((row) => row.expected === expected);
const ticks = (list) => list.filter((row) => row.state === "supported").length;
const right = side("right");
const wrong = side("wrong");
const share = (count, of) => `${count} of ${of} (${Math.round((100 * count) / of)}%)`;
const unsettled = (list) => list.filter((row) => row.state === "not-checked").length;
console.log(`Model: ${summary.model}${values.dry ? " (nothing sent)" : ""}`);
console.log(`Right sentences ✓: ${share(ticks(right), right.length)}`);
console.log(`Wrong twins ✓:     ${share(ticks(wrong), wrong.length)}`);
console.log(
  `Not checked: ${unsettled(right)} right, ${unsettled(wrong)} wrong. Requests: ${summary.requests}. US$${Number(summary.priced ?? 0).toFixed(2)}.`,
);
const missed = right.filter((row) => row.state !== "supported").map((row) => row.case);
const passed = wrong.filter((row) => row.state === "supported").map((row) => row.case);
if (missed.length > 0) console.log(`Right without a ✓: ${missed.join(", ")}`);
if (passed.length > 0) console.log(`Wrong with a ✓: ${passed.join(", ")}`);
