// Which smoke specs CI runs, and how they split into shards that run at once.
//
//   git diff --name-only … | node scripts/smoke-shard.mjs plan   a pull request's specs
//   node scripts/smoke-shard.mjs plan --all                       every spec
//     prints specs=…, count=… and shards=[1,…] for $GITHUB_OUTPUT
//   SMOKE_SPECS="e2e/a.spec.ts …" node scripts/smoke-shard.mjs <current> <total>
//     prints the specs of one shard
//
// A pull request runs the specs it adds or changes and nothing else, even when it changes what
// every spec runs on (a helper, the config, the dependencies): the nightly run and a release run
// every spec. Shards are balanced by how long each spec takes (e2e/durations.json, seconds per
// spec file, from CI's logs): Playwright's own --shard cuts the list into runs of neighbouring
// files with equal numbers of tests, which left one shard with the slowest files and the run
// waiting for it. A spec the table doesn't know yet counts as 5 seconds a test; refresh the table
// now and then from a green run's log.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// About ten minutes of specs for a shard's two workers; the whole suite fills all ten.
const SECONDS_A_SHARD = 1200;
const MOST_SHARDS = 10;

const SPEC = /^e2e\/[^/]+\.spec\.ts$/;

export function allSpecs() {
  return readdirSync(join(root, "e2e"))
    .filter((file) => file.endsWith(".spec.ts"))
    .map((file) => `e2e/${file}`)
    .sort();
}

function secondsOf(spec, known) {
  const file = spec.slice("e2e/".length);
  return (
    known[file] ??
    (readFileSync(join(root, spec), "utf8").match(/^\s*test\(/gm)?.length ?? 1) * 5
  );
}

function durations() {
  return JSON.parse(readFileSync(join(root, "e2e", "durations.json"), "utf8"));
}

/** The specs to run for these changed files (all of them with `all`), and how many shards. */
export function plan(changed, { all = false } = {}) {
  const specs = all
    ? allSpecs()
    : [...new Set(changed)]
        .filter((file) => SPEC.test(file) && existsSync(join(root, file)))
        .sort();
  const known = durations();
  const seconds = specs.reduce((sum, spec) => sum + secondsOf(spec, known), 0);
  const count =
    specs.length === 0 ? 0 : Math.min(MOST_SHARDS, Math.ceil(seconds / SECONDS_A_SHARD));
  return { specs, count };
}

/** The specs of shard `current` of `total`, the slowest dealt first to the lightest shard. */
export function shard(specs, current, total) {
  const known = durations();
  const timed = specs
    .map((spec) => ({ spec, seconds: secondsOf(spec, known) }))
    .sort((a, b) => b.seconds - a.seconds || a.spec.localeCompare(b.spec));
  const shards = Array.from({ length: total }, () => ({ seconds: 0, specs: [] }));
  for (const { spec, seconds } of timed) {
    const lightest = shards.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    lightest.seconds += seconds;
    lightest.specs.push(spec);
  }
  return shards[current - 1].specs.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "plan") {
    const all = rest.includes("--all");
    const changed = all ? [] : readFileSync(0, "utf8").split("\n").filter(Boolean);
    const { specs, count } = plan(changed, { all });
    console.log(`specs=${specs.join(" ")}`);
    console.log(`count=${count}`);
    console.log(`shards=${JSON.stringify(Array.from({ length: count }, (_, index) => index + 1))}`);
  } else {
    const [current, total] = [command, ...rest].map(Number);
    const specs = (process.env.SMOKE_SPECS ?? "").split(/\s+/).filter(Boolean);
    if (!(current >= 1 && total >= 1 && current <= total)) {
      console.error("Usage: node scripts/smoke-shard.mjs plan [--all] | <current> <total>");
      process.exit(1);
    }
    console.log(shard(specs.length > 0 ? specs : allSpecs(), current, total).join(" "));
  }
}
