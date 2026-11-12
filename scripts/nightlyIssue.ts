/**
 * The last job of both nightly workflows (docs/agents/testing.md): keeps one issue, "Nightly is
 * red", true to the last night of each. A night is green, red (a test failed) or not measured (a
 * check could not run, as when a provider's key has no credit), and only green closes the issue.
 *
 * Usage: node scripts/nightlyIssue.ts nightly|real-models
 * Reads GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID, and NEEDS, the workflow's `needs`
 * context as JSON. `--dry-run --run <gh run view --json jobs file>` prints what it would write
 * instead (`--logs <folder of <job id>.log>`, `--previous <body>`, `--date`, `--needs`, `--status`,
 * `--out`).
 *
 * The issue holds only words of ours: test, job and step names, dates, the commit, run links and a
 * provider's name. Never a log line, a request, or what a provider answered.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ISSUE_TITLE = "Nightly is red";
export const ISSUE_LABELS = ["priority:P1", "ready-to-build"];
export const NIGHTLY = "Nightly";
export const REAL_MODELS = "Nightly real models";
const WORKFLOWS = [NIGHTLY, REAL_MODELS];

const STATES = ["green", "red", "not measured"] as const;
export type State = (typeof STATES)[number];

export interface Gap {
  what: string;
  why: string;
  /** The red tests whose names start with this were not measured tonight, so their rows stay as they were. */
  keeps?: string;
}

export interface Night {
  workflow: string;
  /** The UTC day the run began, as 2026-11-11. */
  date: string;
  sha: string;
  runUrl: string;
  red: readonly string[];
  gaps: readonly Gap[];
  /** Some check ran to a result. */
  measured: boolean;
}

/** What nightlyRealModel.ts hands the report job. */
export interface Status {
  red: string[];
  gaps: Gap[];
  measured: boolean;
}

interface RedRow {
  name: string;
  first: string;
  last: string;
}

interface GapRow {
  what: string;
  why: string;
  since: string;
  last: string;
}

interface Section {
  state: State;
  text: string;
  red: RedRow[];
  gaps: GapRow[];
}

const NAME_LENGTH = 200;
const MAX_ROWS = 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NAME_LENGTH ? `${flat.slice(0, NAME_LENGTH - 1)}…` : flat;
};

/** A test's name as the issue keeps it, so that the same test is the same row every night. */
const normal = (name: string) => oneLine(name).replaceAll("`", "'");

const escaped = (text: string) => oneLine(text).replaceAll("|", "\\|");

function cellsOf(line: string): string[] | null {
  const text = line.trim();
  if (!text.startsWith("|") || !text.endsWith("|") || text.length < 2) return null;
  const cells: string[] = [];
  let current = "";
  for (let at = 1; at < text.length - 1; at++) {
    const char = text.charAt(at);
    if (char === "\\" && text.charAt(at + 1) === "|") {
      current += "\\|";
      at++;
    } else if (char === "|") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim().replaceAll("\\|", "|"));
}

const ANSI = /\u001b\[[0-9;]*m/g;
const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;
const PLAYWRIGHT_TOTAL = /^(?:##\[\w+\])?\s*\d+ (failed|interrupted|flaky|skipped|did not run)\s*$/;
const PLAYWRIGHT_TEST = /^\s+((?:e2e|tests)\/\S+?\.[cm]?tsx?):\d+:\d+ › (.+?)\s*$/;
const VITEST_FAIL = /^\s*FAIL\s+(\S+\.[cm]?tsx?)(?: > (.+?))?(?: \[ .* \])?\s*$/;

/**
 * The tests a job's log says failed, as `file › title`, from Playwright's closing list and
 * Vitest's failed tests. Only their names: the lines around them are errors, which stay in the log.
 */
export function failedTests(log: string): string[] {
  const names = new Set<string>();
  let listing = false;
  for (const raw of log.split("\n")) {
    const line = raw.replace(ANSI, "").replace(STAMP, "");
    const total = PLAYWRIGHT_TOTAL.exec(line);
    if (total) {
      listing = total[1] === "failed" || total[1] === "interrupted";
      continue;
    }
    if (listing) {
      const test = PLAYWRIGHT_TEST.exec(line);
      if (test) names.add(normal(`${test[1]} › ${test[2]}`));
      else if (line.trim() !== "") listing = false;
      continue;
    }
    const vitest = VITEST_FAIL.exec(line);
    if (vitest) {
      names.add(normal([vitest[1], vitest[2]?.replaceAll(" > ", " › ")].filter(Boolean).join(" › ")));
    }
  }
  return [...names];
}

export interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  steps: { name: string; conclusion: string | null }[];
}

export interface Run {
  date: string;
  sha: string;
  url: string;
}

export type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

const failedStep = (job: Job) =>
  job.steps.find((step) => step.conclusion !== null && FAILED.has(step.conclusion))?.name ??
  job.steps.find((step) => step.conclusion === "cancelled")?.name ??
  "the job failed";

/** The Nightly workflow's night, from its jobs (and the logs of the ones that failed), checked against `needs`. */
export function nightFromJobs(
  run: Run,
  jobs: readonly Job[],
  logs: ReadonlyMap<number, string>,
  needs: Needs = {},
): Night {
  const red: string[] = [];
  const gaps: Gap[] = [];
  let measured = false;
  for (const job of jobs) {
    if (job.conclusion === "success") {
      measured = true;
    } else if (job.conclusion !== null && FAILED.has(job.conclusion)) {
      measured = true;
      const tests = failedTests(logs.get(job.id) ?? "");
      red.push(...(tests.length > 0 ? tests : [`${job.name}: ${failedStep(job)}`]));
    } else if (job.conclusion === "cancelled") {
      gaps.push({ what: job.name, why: "the job was cancelled" });
    }
  }
  for (const [id, need] of Object.entries(needs)) {
    if (need.result === "failure" && red.length === 0) {
      measured = true;
      red.push(`${id}: the job failed`);
    } else if (need.result === "cancelled" && gaps.length === 0) {
      gaps.push({ what: id, why: "the job was cancelled" });
    }
  }
  if (!measured && gaps.length === 0) {
    gaps.push({ what: "The nightly's jobs", why: "none of them ran" });
  }
  return { workflow: NIGHTLY, date: run.date, sha: run.sha, runUrl: run.url, red, gaps, measured };
}

/** What a status holds, or null when the text isn't one. */
export function readStatus(text: string | undefined): Status | null {
  if (!text?.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { red, gaps, measured } = value as Record<string, unknown>;
  const words = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((each) => typeof each === "string");
  if (!words(red) || !Array.isArray(gaps) || typeof measured !== "boolean") return null;
  const readGaps: Gap[] = [];
  for (const gap of gaps) {
    if (typeof gap !== "object" || gap === null) return null;
    const { what, why, keeps } = gap as Record<string, unknown>;
    if (typeof what !== "string" || typeof why !== "string") return null;
    readGaps.push({ what, why, ...(typeof keeps === "string" && { keeps }) });
  }
  return { red, gaps: readGaps, measured };
}

/**
 * The real-model workflow's night, from the status the run handed over and how its job ended. A
 * job that failed or was cancelled without a word in the status is never reported green.
 */
export function nightFromStatus(
  run: Run,
  result: string,
  status: Status | null,
  job?: Job,
): Night {
  const red = [...(status?.red ?? [])];
  const gaps = [...(status?.gaps ?? [])];
  let measured = status?.measured ?? false;
  const reported = red.length > 0 || gaps.length > 0;
  if (!reported && (result === "cancelled" || result === "skipped")) {
    gaps.push({ what: "Real-model checks", why: "the run was cancelled before it wrote a report" });
  } else if (!reported && result !== "success") {
    measured = true;
    red.push(`Real-model checks: ${job ? failedStep(job) : "the job failed"}`);
  } else if (!reported && !status) {
    measured = true;
    red.push("Real-model checks: the run wrote no report");
  }
  if (!measured && gaps.length === 0 && red.length === 0) {
    gaps.push({ what: "Real-model checks", why: "no check ran" });
  }
  return {
    workflow: REAL_MODELS,
    date: run.date,
    sha: run.sha,
    runUrl: run.url,
    red,
    gaps,
    measured,
  };
}

const HEADING = /^## (.+) \((green|red|not measured)\)$/;

function parseSections(body: string): Map<string, Section> {
  const found = new Map<string, Section>();
  let name: string | null = null;
  let current: { state: State; lines: string[]; red: RedRow[]; gaps: GapRow[] } | null = null;
  const finish = () => {
    if (name && current) {
      found.set(name, { ...current, text: current.lines.join("\n").trimEnd() });
    }
  };
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    const heading = HEADING.exec(line.trimEnd());
    const state = STATES.find((each) => each === heading?.[2]);
    if (heading?.[1] && state) {
      finish();
      name = heading[1];
      current = { state, lines: [], red: [], gaps: [] };
    } else if (line.startsWith("## ")) {
      finish();
      name = null;
      current = null;
    }
    if (!current) continue;
    current.lines.push(line);
    const cells = cellsOf(line);
    const [first = "", second = "", third = "", fourth = ""] = cells ?? [];
    if (cells?.length === 3 && DATE.test(second) && DATE.test(third)) {
      current.red.push({ name: first.replace(/^`(.*)`$/, "$1"), first: second, last: third });
    } else if (cells?.length === 4 && DATE.test(third) && DATE.test(fourth)) {
      current.gaps.push({ what: first, why: second, since: third, last: fourth });
    }
  }
  finish();
  return found;
}

const byFirstRed = (a: RedRow, b: RedRow) =>
  a.first.localeCompare(b.first) || a.name.localeCompare(b.name);

function sectionOf(night: Night, before: Section | undefined): Section {
  const tonight = [...new Set(night.red.map(normal))];
  const earlier = before?.red ?? [];
  const red: RedRow[] = tonight.map((name) => ({
    name,
    first: earlier.find((row) => row.name === name)?.first ?? night.date,
    last: night.date,
  }));
  const kept = earlier.filter(
    (row) =>
      !tonight.includes(row.name) &&
      night.gaps.some((gap) => gap.keeps !== undefined && row.name.startsWith(gap.keeps)),
  );
  const gaps: GapRow[] = night.gaps.map((gap) => {
    const what = oneLine(gap.what);
    return {
      what,
      why: oneLine(gap.why),
      since: before?.gaps.find((row) => row.what === what)?.since ?? night.date,
      last: night.date,
    };
  });
  const state: State = tonight.length > 0 ? "red" : gaps.length > 0 ? "not measured" : "green";
  const lines = [
    `## ${night.workflow} (${state})`,
    "",
    `Run of ${night.date} · \`${night.sha.slice(0, 7)}\` · [log](${night.runUrl})`,
  ];
  if (!night.measured && gaps.length > 0) {
    const since = gaps.map((gap) => gap.since).reduce((a, b) => (a > b ? a : b));
    lines.push("", `Nothing has been measured since ${since}.`);
  }
  if (gaps.length > 0) {
    lines.push(
      "",
      "| Not measured | Why | Since | Last night |",
      "|---|---|---|---|",
      ...gaps.map(
        (gap) => `| ${escaped(gap.what)} | ${escaped(gap.why)} | ${gap.since} | ${gap.last} |`,
      ),
    );
  }
  const rows = [...red, ...kept].sort(byFirstRed);
  if (rows.length > 0) {
    lines.push(
      "",
      state === "red" ? "Failing tests:" : "Still red when they were last measured:",
      "",
      "| Test | First red | Last red |",
      "|---|---|---|",
      ...rows
        .slice(0, MAX_ROWS)
        .map((row) => `| \`${row.name.replaceAll("|", "\\|")}\` | ${row.first} | ${row.last} |`),
    );
    if (rows.length > MAX_ROWS) {
      lines.push("", `…and ${rows.length - MAX_ROWS} more; the run's log lists them.`);
    }
  }
  return { state, text: lines.join("\n"), red: [...red, ...kept], gaps };
}

const INTRO =
  "The nightly runs on `main` keep this one issue up to date. A night is **red** when a test fails, **not measured** when a check could not run (a provider's key had no credit, say), and **green** only when everything ran and passed. The first night on which every nightly workflow is green again closes it.";

function render(sections: ReadonlyMap<string, Section>): string {
  const known = WORKFLOWS.filter((name) => sections.has(name));
  const others = [...sections.keys()].filter((name) => !WORKFLOWS.includes(name));
  return `${[INTRO, ...[...known, ...others].map((name) => sections.get(name)?.text ?? "")].join("\n\n")}\n`;
}

export type Plan =
  | { action: "none" }
  | { action: "open" | "update"; body: string }
  | { action: "close"; body: string; comment: string };

/** What to do to the issue after a night, given the open issue's body (null when none is open). */
export function plan(night: Night, previous: string | null): Plan {
  const sections = parseSections(previous ?? "");
  const mine = sectionOf(night, sections.get(night.workflow));
  sections.set(night.workflow, mine);
  const body = render(sections);
  if (previous === null) return mine.state === "green" ? { action: "none" } : { action: "open", body };
  if ([...sections.values()].some((each) => each.state !== "green")) {
    return { action: "update", body };
  }
  return {
    action: "close",
    body,
    comment: `Nightly is green again on ${night.date}: ${night.workflow} passed on \`${night.sha.slice(0, 7)}\` ([log](${night.runUrl})).`,
  };
}

/** The few calls the report makes to GitHub, or reads from a saved run. */
export interface Hub {
  run(): Promise<{ run: Run; jobs: Job[] }>;
  jobLog(id: number): Promise<string | null>;
  openIssue(): Promise<{ number: number; body: string } | null>;
  open(body: string): Promise<void>;
  update(number: number, body: string): Promise<void>;
  close(number: number, body: string, comment: string): Promise<void>;
}

interface ApiJob {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
}

export function githubHub(
  token: string,
  repository: string,
  runId: string,
  ask: typeof fetch = fetch,
): Hub {
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const response = await ask(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "nightly-report",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${method} ${path}.`);
    return response;
  };
  return {
    async run() {
      const saved = (await (await call("GET", `/actions/runs/${runId}`)).json()) as {
        run_started_at?: string;
        created_at: string;
        head_sha: string;
        html_url: string;
      };
      const jobs: Job[] = [];
      for (let page = 1; page <= 10; page++) {
        const listed = (await (
          await call("GET", `/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`)
        ).json()) as { jobs: ApiJob[] };
        jobs.push(...listed.jobs.map((job) => ({ ...job, steps: job.steps ?? [] })));
        if (listed.jobs.length < 100) break;
      }
      return {
        run: {
          date: (saved.run_started_at ?? saved.created_at).slice(0, 10),
          sha: saved.head_sha,
          url: saved.html_url,
        },
        jobs,
      };
    },
    async jobLog(id) {
      try {
        return await (await call("GET", `/actions/jobs/${id}/logs`)).text();
      } catch (error) {
        console.error(`No log for job ${id}: ${error instanceof Error ? error.message : error}`);
        return null;
      }
    },
    async openIssue() {
      for (let page = 1; page <= 20; page++) {
        const issues = (await (
          await call("GET", `/issues?state=open&per_page=100&page=${page}`)
        ).json()) as { number: number; title: string; body: string | null; pull_request?: unknown }[];
        const found = issues.find((issue) => issue.title === ISSUE_TITLE && !issue.pull_request);
        if (found) return { number: found.number, body: found.body ?? "" };
        if (issues.length < 100) break;
      }
      return null;
    },
    async open(body) {
      await call("POST", "/issues", { title: ISSUE_TITLE, body, labels: ISSUE_LABELS });
    },
    async update(number, body) {
      await call("PATCH", `/issues/${number}`, { body });
    },
    async close(number, body, comment) {
      await call("PATCH", `/issues/${number}`, { body });
      await call("POST", `/issues/${number}/comments`, { body: comment });
      await call("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
    },
  };
}

/** The night the run made: the Nightly workflow's from its jobs and their logs, the real-model workflow's from its status. */
export async function nightOf(
  kind: "nightly" | "real-models",
  hub: Hub,
  needs: Needs,
  status: string | undefined,
): Promise<Night> {
  const { run, jobs } = await hub.run();
  if (kind === "real-models") {
    return nightFromStatus(
      run,
      needs["real-models"]?.result ?? "failure",
      readStatus(status),
      jobs.find((job) => job.name === "Real-model checks"),
    );
  }
  const logs = new Map<number, string>();
  for (const job of jobs) {
    if (job.conclusion === null || !FAILED.has(job.conclusion)) continue;
    const log = await hub.jobLog(job.id);
    if (log) logs.set(job.id, log);
  }
  return nightFromJobs(run, jobs, logs, needs);
}

/** Writes the plan's outcome to the issue, and says what it did. */
export async function apply(night: Night, hub: Hub): Promise<{ plan: Plan; said: string }> {
  const issue = await hub.openIssue();
  const next = plan(night, issue?.body ?? null);
  const count = `${night.red.length} failing, ${night.gaps.length} not measured`;
  if (next.action === "open") await hub.open(next.body);
  else if (next.action === "update" && issue) await hub.update(issue.number, next.body);
  else if (next.action === "close" && issue) await hub.close(issue.number, next.body, next.comment);
  const said =
    next.action === "none"
      ? `${night.workflow} is green and no issue is open: nothing to do.`
      : `${night.workflow} (${count}): ${next.action} the issue${issue?.number ? ` #${issue.number}` : ""}.`;
  return { plan: next, said };
}

const argument = (args: readonly string[], flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

/** The file a flag names, or nothing when the flag is absent; a named file that is missing is an error. */
function readNamed(args: readonly string[], flag: string): string {
  const file = argument(args, flag);
  return file ? readFileSync(file, "utf8") : "";
}

function readIfThere(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** A run saved with `gh run view <id> --json createdAt,headSha,url,jobs`, and an issue that is never written. */
function savedHub(args: readonly string[]): Hub {
  const file = argument(args, "--run");
  if (!file) throw new Error("--dry-run needs --run <gh run view --json file>.");
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    createdAt: string;
    headSha: string;
    url: string;
    jobs: { databaseId: number; name: string; conclusion: string; steps: Job["steps"] }[];
  };
  const folder = argument(args, "--logs");
  const previous = readNamed(args, "--previous");
  return {
    run: async () => ({
      run: {
        date: argument(args, "--date") ?? saved.createdAt.slice(0, 10),
        sha: saved.headSha,
        url: saved.url,
      },
      jobs: saved.jobs.map((job) => ({ ...job, id: job.databaseId })),
    }),
    jobLog: async (id) => (folder ? readIfThere(join(folder, `${id}.log`)) : null),
    openIssue: async () => (previous ? { number: 0, body: previous } : null),
    open: async () => {},
    update: async () => {},
    close: async () => {},
  };
}

function liveHub(env: Record<string, string | undefined>): Hub {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = env;
  if (!token || !repository || !runId) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID are needed.");
  }
  return githubHub(token, repository, runId);
}

async function main(args: readonly string[], env: Record<string, string | undefined>) {
  const kind = args[0];
  if (kind !== "nightly" && kind !== "real-models") {
    throw new Error("Say which night: nightly or real-models.");
  }
  const dry = args.includes("--dry-run");
  const needs = JSON.parse((dry ? readNamed(args, "--needs") : env.NEEDS) || "{}") as Needs;
  const hub = dry ? savedHub(args) : liveHub(env);
  const status = dry ? readNamed(args, "--status") : needs["real-models"]?.outputs?.status;
  const done = await apply(await nightOf(kind, hub, needs, status), hub);
  console.log(done.said);
  if (dry) {
    console.log(`\nAction: ${done.plan.action}`);
    if (done.plan.action !== "none") console.log(`\n${done.plan.body}`);
    if (done.plan.action === "close") console.log(`\nComment: ${done.plan.comment}`);
    const out = argument(args, "--out");
    if (out && done.plan.action !== "none") writeFileSync(out, done.plan.body);
  } else if (env.GITHUB_STEP_SUMMARY && done.plan.action !== "none") {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${done.plan.body}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
