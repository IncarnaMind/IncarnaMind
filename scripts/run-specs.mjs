// Runs smoke specs on a GitHub-hosted machine instead of yours: dispatches
// .github/workflows/specs.yml on the current branch, waits for it and says which specs passed.
// Needs `gh` signed in and the branch pushed. docs/agents/testing.md says when to use it.
//
//   node scripts/run-specs.mjs [--os linux|macos|windows] [--repeat 1-10] [--grep REGEX] <spec>...
//   node scripts/run-specs.mjs --os macos --repeat 3 e2e/a.spec.ts e2e/b.spec.ts:12
//
// The workflow runs this file with --check on the same inputs, so both refuse the same things.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = "specs.yml";
const SYSTEMS = ["linux", "macos", "windows"];
// GitHub's API limit is shared by every agent, so one request a minute is the most this makes.
const POLL_MS = 60_000;
const GIVE_UP_MS = 100 * 60_000;
const SPEC = /^(e2e\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.spec\.ts)(?::[1-9][0-9]{0,5})?$/;
const GREP = /^[\p{L}\p{N} _.,:+*?|()[\]^$/\\'#-]*$/u;
const USAGE =
  "Usage: node scripts/run-specs.mjs [--os linux|macos|windows] [--repeat 1-10] [--grep REGEX] <spec>...\n" +
  "A spec is e2e/<name>.spec.ts, or e2e/<name>.spec.ts:<line>. The branch must be pushed.";

/** What is wrong with the inputs, in plain words; nothing is wrong when it is empty. */
function problemsWith({ specs, os, repeat, grep }) {
  const problems = [];
  const names = specs.trim().split(/\s+/).filter(Boolean);
  if (names.length === 0) problems.push("Name at least one spec, such as e2e/undoPill.spec.ts.");
  const e2e = realpathSync(join(root, "e2e"));
  for (const name of names) {
    const file = SPEC.exec(name)?.[1];
    if (!file || file.split("/").some((part) => part === "." || part === "..")) {
      problems.push(
        `${JSON.stringify(name)} is not a spec: write e2e/<name>.spec.ts, or e2e/<name>.spec.ts:<line>, with no "..".`,
      );
    } else if (
      !existsSync(join(root, file)) ||
      !realpathSync(join(root, file)).startsWith(e2e + sep)
    ) {
      problems.push(`${JSON.stringify(name)} does not exist under e2e/.`);
    }
  }
  if (os !== undefined && !SYSTEMS.includes(os)) {
    problems.push(`os must be one of ${SYSTEMS.join(", ")}, not ${JSON.stringify(os)}.`);
  }
  if (!/^(10|[1-9])$/.test(repeat)) {
    problems.push(`repeat must be a whole number from 1 to 10, not ${JSON.stringify(repeat)}.`);
  }
  if (grep) {
    if (grep.length > 200 || !GREP.test(grep)) {
      problems.push(
        `grep may hold up to 200 letters, digits, spaces and . , : + - * ? | ( ) [ ] ^ $ / \\ _ ' # only, not ${JSON.stringify(grep)}.`,
      );
    } else {
      try {
        new RegExp(grep);
      } catch {
        problems.push(`grep is not a regular expression: ${JSON.stringify(grep)}.`);
      }
    }
  }
  return problems;
}

function refuse(problems) {
  const inActions = process.env.GITHUB_ACTIONS === "true";
  for (const problem of problems) {
    const annotation = `::error title=Run named specs::${problem.replaceAll("%", "%25")}`;
    console.error(inActions ? annotation : `Error: ${problem}`);
  }
  process.exit(1);
}

const gh = (...args) =>
  execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const firstLine = (error) =>
  String(error.stderr || error.message)
    .trim()
    .split("\n")[0];

function pushedHead() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "HEAD") refuse(["Check out the branch to run: this checkout has none."]);
  const head = git("rev-parse", "HEAD");
  const remote = git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s/)[0];
  if (remote !== head) {
    refuse([
      remote
        ? `origin/${branch} is at ${remote.slice(0, 9)} but this checkout is at ${head.slice(0, 9)}: push first.`
        : `${branch} is not on origin: git push -u origin ${branch}`,
    ]);
  }
  if (git("status", "--porcelain", "--untracked-files=no")) {
    console.warn("Uncommitted changes are not run: the machine gets the pushed commit.");
  }
  return { branch, head };
}

async function runFor({ branch, head }, since, dispatched) {
  const started = /actions\/runs\/(\d+)/.exec(dispatched)?.[1];
  if (started) return Number(started);
  for (;;) {
    await sleep(POLL_MS);
    const runs = JSON.parse(
      gh(
        "run",
        "list",
        "--workflow",
        WORKFLOW,
        "--branch",
        branch,
        "--event",
        "workflow_dispatch",
        "--limit",
        "10",
        "--json",
        "databaseId,headSha,createdAt",
      ),
    );
    const mine = runs
      .filter((run) => run.headSha === head && Date.parse(run.createdAt) >= since - 60_000)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (mine) return mine.databaseId;
    if (Date.now() - since > GIVE_UP_MS) throw new Error("The dispatched run never appeared.");
  }
}

async function finished(id, since) {
  for (;;) {
    await sleep(POLL_MS);
    const run = JSON.parse(gh("run", "view", String(id), "--json", "status,conclusion,url,jobs"));
    if (run.status === "completed") return run;
    console.log(`${Math.round((Date.now() - since) / 60_000)} min: ${run.status}`);
    if (Date.now() - since > GIVE_UP_MS) {
      throw new Error(`Still running after ${GIVE_UP_MS / 60_000} minutes: ${run.url}`);
    }
  }
}

function readReport(id, os) {
  const dir = mkdtempSync(join(tmpdir(), "specs-report-"));
  try {
    gh("run", "download", String(id), "-n", `specs-report-${os}-${id}`, "-D", dir);
    return JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  } catch (error) {
    console.error(`No report to read: ${firstLine(error)}`);
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the report says of each spec file: how many tests ran, were skipped, and which failed. */
function filesIn(report) {
  const files = new Map();
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      const name = spec.file.startsWith("e2e/") ? spec.file : `e2e/${spec.file}`;
      const file = files.get(name) ?? { ran: 0, skipped: 0, failed: [] };
      for (const test of spec.tests) {
        if (test.status === "skipped") file.skipped += 1;
        else file.ran += 1;
        if (test.status === "unexpected" || test.status === "flaky") file.failed.push(spec.title);
      }
      files.set(name, file);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return files;
}

/** Prints pass or fail for each spec named; true when none failed. */
function printResults(specs, report, os) {
  const files = filesIn(report);
  let allPassed = (report.errors ?? []).length === 0;
  for (const error of report.errors ?? []) console.log(`error  ${error.message?.split("\n")[0]}`);
  for (const spec of specs) {
    const file = files.get(spec.replace(/:\d+$/, ""));
    if (!file) {
      console.log(`fail   ${spec}  no test ran`);
      allPassed = false;
    } else if (file.failed.length > 0) {
      console.log(
        `fail   ${spec}  ${file.failed.length} of ${file.ran} failed: ${[...new Set(file.failed)].join("; ")}`,
      );
      allPassed = false;
    } else if (file.ran === 0) {
      console.log(`skip   ${spec}  skipped on ${os}`);
    } else {
      console.log(`pass   ${spec}  ${file.ran} ${file.ran === 1 ? "test" : "tests"}`);
    }
  }
  return allPassed;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        check: { type: "boolean", default: false },
        os: { type: "string", default: "linux" },
        repeat: { type: "string", default: "1" },
        grep: { type: "string", default: "" },
      },
    });
  } catch (error) {
    refuse([`${error.message}\n${USAGE}`]);
  }
  const { values, positionals } = parsed;

  if (values.check) {
    const inputs = {
      specs: process.env.SPECS ?? "",
      repeat: process.env.REPEAT ?? "",
      grep: process.env.GREP ?? "",
    };
    const problems = problemsWith(inputs);
    if (problems.length > 0) refuse(problems);
    console.log(`The inputs are fine: ${inputs.specs.trim().split(/\s+/).length} spec(s).`);
    return;
  }

  const inputs = {
    specs: positionals.join(" "),
    os: values.os,
    repeat: values.repeat,
    grep: values.grep,
  };
  const problems = problemsWith(inputs);
  if (problems.length > 0) refuse([...problems, USAGE]);
  const target = pushedHead();

  const since = Date.now();
  const flags = [
    "-f",
    `specs=${inputs.specs}`,
    "-f",
    `os=${inputs.os}`,
    "-f",
    `repeat=${inputs.repeat}`,
  ];
  if (inputs.grep) flags.push("-f", `grep=${inputs.grep}`);
  const dispatched = gh("workflow", "run", WORKFLOW, "--ref", target.branch, ...flags);
  const id = await runFor(target, since, dispatched);
  console.log(
    `Running ${positionals.length} spec(s) on ${inputs.os} from ${target.head.slice(0, 9)}: https://github.com/IncarnaMind/IncarnaMind/actions/runs/${id}`,
  );

  const run = await finished(id, since);
  const report = readReport(id, inputs.os);
  let passed = false;
  if (report) {
    passed = printResults(positionals, report, inputs.os) && run.conclusion === "success";
  } else if (run.conclusion === "cancelled") {
    console.log("The run was cancelled: a newer dispatch for this branch and system replaces it.");
  } else {
    const steps = run.jobs
      .flatMap((job) => job.steps)
      .filter((step) => step.conclusion === "failure");
    const where = steps.length > 0 ? ` at: ${steps.map((step) => step.name).join(", ")}` : "";
    console.log(`The run ended ${run.conclusion}${where}. Why: gh run view ${id} --log-failed`);
  }
  if (!passed) {
    const dir = join(root, "test-results", `specs-${inputs.os}-${id}`);
    try {
      gh("run", "download", String(id), "-n", `specs-${inputs.os}-${id}`, "-D", dir);
      console.log(`Traces, videos and window pictures: ${dir}`);
    } catch (error) {
      console.error(`No results to download: ${firstLine(error)}`);
    }
  }
  console.log(run.url);
  process.exit(passed ? 0 : 1);
}

await main();
