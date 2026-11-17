/**
 * Writes tests/durations.json, the seconds each unit test file takes on CI, from a run's logs.
 * The unit shards are balanced by this table (tests/setup/shards.ts).
 *
 * Usage: node scripts/unitDurations.ts <run id>
 * Give it a green nightly run, which runs every test. A file the run skipped counts as nothing,
 * one the run didn't reach keeps the seconds the table had, and one that is gone leaves the table.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const table = join(root, "tests", "durations.json");

// `gh run view --log` writes the escape character of a colour code as the two characters "^[".
const COLOURS = new RegExp(`(?:${String.fromCharCode(27)}|\\^\\[)\\[[0-9;]*m`, "g");
const TIMESTAMP = /^.*\d{4}-\d\d-\d\dT[\d:.]+Z /;
const FILE = /^\s*([✓↓])\s+(tests\/\S+\.test\.ts) \(\d+ tests?[^)]*\)(?: (\d+)ms)?/;

/** The seconds of each test file a job's log names: a passed file's own, none for a skipped one. */
export function secondsIn(log: string): Record<string, number> {
  const seconds: Record<string, number> = {};
  for (const line of log.replace(COLOURS, "").split("\n")) {
    const found = FILE.exec(line.replace(TIMESTAMP, ""));
    if (!found) continue;
    const [, mark, file, milliseconds] = found;
    if (!file) continue;
    if (mark === "↓") seconds[file] = 0;
    else if (milliseconds) seconds[file] = Math.round(Number(milliseconds) / 100) / 10;
  }
  return seconds;
}

function main(run: string): void {
  const gh = (...args: string[]) =>
    execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const { jobs } = JSON.parse(gh("run", "view", run, "--json", "jobs")) as {
    jobs: { name: string; databaseId: number }[];
  };
  const unit = jobs.filter((job) => /Unit tests \(\d+\/\d+\)/.test(job.name));
  if (unit.length === 0) throw new Error(`Run ${run} has no unit test jobs.`);
  const seconds: Record<string, number> = JSON.parse(readFileSync(table, "utf8"));
  for (const job of unit) {
    Object.assign(seconds, secondsIn(gh("run", "view", "--job", String(job.databaseId), "--log")));
  }
  const kept = Object.entries(seconds)
    .filter(([file]) => existsSync(join(root, file)))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  writeFileSync(table, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`);
  console.log(`${kept.length} files, from ${unit.length} jobs of run ${run}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = process.argv[2];
  if (!run) {
    console.error("Usage: node scripts/unitDurations.ts <run id>");
    process.exit(1);
  }
  main(run);
}
