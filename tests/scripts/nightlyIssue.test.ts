import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  apply,
  failedTests,
  githubHub,
  type Hub,
  type Job,
  type Night,
  nightFromJobs,
  nightFromStatus,
  nightOf,
  plan,
  type Run,
  readStatus,
} from "../../scripts/nightlyIssue";

const night = (over: Partial<Night> = {}): Night => ({
  workflow: "Nightly",
  date: "2026-11-09",
  sha: "b497c191076fdb18bd5d61ff4290b7e0b12f9aa5",
  runUrl: "https://github.com/IncarnaMind/IncarnaMind/actions/runs/42996665318",
  red: [],
  gaps: [],
  measured: true,
  ...over,
});

const bodyOf = (next: ReturnType<typeof plan>): string => {
  if (next.action === "none") throw new Error("The plan wrote no body.");
  return next.body;
};

const KEY = "sk-ant-a-made-up-key-0000";

describe("first red, carried from the issue's body", () => {
  // protects=a test's first red date is read back from the issue night after night, and a test that went green and failed again starts a new count; fails_when=every night restarts the dates, or a test that was green for a night keeps its old date; no_claim=how the body looks beyond these cells.
  test("a failing test keeps its first date until it passes", () => {
    const first = bodyOf(plan(night({ date: "2026-11-09", red: ["a.spec", "b.spec"] }), null));
    expect(first).toContain("| `a.spec` | 2026-11-09 | 2026-11-09 |");
    const second = bodyOf(plan(night({ date: "2026-11-10", red: ["b.spec", "c.spec"] }), first));
    expect(second).toContain("| `b.spec` | 2026-11-09 | 2026-11-10 |");
    expect(second).toContain("| `c.spec` | 2026-11-10 | 2026-11-10 |");
    expect(second).not.toContain("`a.spec`");
    const third = bodyOf(plan(night({ date: "2026-11-11", red: ["b.spec"] }), second));
    expect(third).toContain("| `b.spec` | 2026-11-09 | 2026-11-11 |");
    const again = bodyOf(plan(night({ date: "2026-11-12", red: ["a.spec"] }), third));
    expect(again).toContain("| `a.spec` | 2026-11-12 | 2026-11-12 |");
  });

  // protects=a name with a pipe, a backtick or a line break stays one row and is the same row the next night; fails_when=a name splits its row, or its first date is lost because the cell was read differently from how it was written; no_claim=how GitHub draws it.
  test("an awkward name is one row that round-trips", () => {
    const name = "a | b `c`\nand a very long tail ".repeat(12);
    const first = bodyOf(plan(night({ date: "2026-11-09", red: [name] }), null));
    const rows = first.split("\n").filter((line) => line.startsWith("| `"));
    expect(rows).toHaveLength(1);
    const next = bodyOf(plan(night({ date: "2026-11-10", red: [name] }), first));
    expect(next).toMatch(/\| 2026-11-09 \| 2026-11-10 \|$/m);
  });
});

describe("the three states", () => {
  // protects=a night is red, not measured or green, each in its own words, and the date nothing was measured since is said; fails_when=a night with no credit reads as red or green, or the issue forgets since when; no_claim=none.
  test("red, not measured and green are told apart", () => {
    const red = bodyOf(plan(night({ red: ["a.spec"] }), null));
    expect(red).toContain("## Nightly (red)");
    expect(red).toContain("Failing tests:");
    const gap = {
      what: "Live tests on Claude (Anthropic)",
      why: "no key was accepted: the first request got status 400",
      keeps: "Live tests on Claude: ",
    };
    const first = bodyOf(
      plan(
        night({
          workflow: "Nightly real models",
          date: "2026-11-04",
          gaps: [gap],
          measured: false,
        }),
        null,
      ),
    );
    expect(first).toContain("## Nightly real models (not measured)");
    expect(first).toContain("Nothing has been measured since 2026-11-04.");
    expect(first).not.toContain("(red)");
    const later = bodyOf(
      plan(
        night({
          workflow: "Nightly real models",
          date: "2026-11-12",
          gaps: [gap],
          measured: false,
        }),
        first,
      ),
    );
    expect(later).toContain("Nothing has been measured since 2026-11-04.");
    expect(later).toContain(
      "| Live tests on Claude (Anthropic) | no key was accepted: the first request got status 400 | 2026-11-04 | 2026-11-12 |",
    );
    const green = plan(night({ workflow: "Nightly real models", date: "2026-11-13" }), later);
    expect(bodyOf(green)).toContain("## Nightly real models (green)");
    expect(green.action).toBe("close");
  });

  // protects=when part of a night is not measured, the tests that were red in that part stay listed with their old dates, and red tests elsewhere are judged as before; fails_when=a night without credit wipes the red rows, or keeps a row from a step that did run; no_claim=none.
  test("a step not measured keeps its red rows; the others are judged tonight", () => {
    const workflow = "Nightly real models";
    const first = bodyOf(
      plan(
        night({
          workflow,
          date: "2026-11-09",
          red: ["Live tests on Claude: an Answer cites", "Kimi answers: a key connects"],
        }),
        null,
      ),
    );
    const next = bodyOf(
      plan(
        night({
          workflow,
          date: "2026-11-10",
          red: [],
          gaps: [
            {
              what: "Live tests on Claude (Anthropic)",
              why: "the key ran out",
              keeps: "Live tests on Claude: ",
            },
          ],
        }),
        first,
      ),
    );
    expect(next).toContain("## Nightly real models (not measured)");
    expect(next).toContain("Still red when they were last measured:");
    expect(next).toContain("| `Live tests on Claude: an Answer cites` | 2026-11-09 | 2026-11-09 |");
    expect(next).not.toContain("Kimi answers");
  });
});

describe("one issue for both nightlies", () => {
  // protects=the issue is opened once, updated by every red night after, left open while either workflow is red or not measured, and closed with a "green again" comment by the first night after which both are green; fails_when=a second issue is opened, one workflow's green night closes the issue over the other's red, or closing says nothing; no_claim=none.
  test("opens once, closes when both are green", () => {
    const real = "Nightly real models";
    const opened = plan(night({ red: ["a.spec"] }), null);
    expect(opened.action).toBe("open");
    const second = plan(
      night({ workflow: real, red: ["Live tests on Claude: x"] }),
      bodyOf(opened),
    );
    expect(second.action).toBe("update");
    const nightlyGreen = plan(night({ date: "2026-11-10" }), bodyOf(second));
    expect(nightlyGreen.action).toBe("update");
    expect(bodyOf(nightlyGreen)).toContain("## Nightly (green)");
    expect(bodyOf(nightlyGreen)).toContain("## Nightly real models (red)");
    const closed = plan(night({ workflow: real, date: "2026-11-10" }), bodyOf(nightlyGreen));
    expect(closed.action).toBe("close");
    if (closed.action === "close") {
      expect(closed.comment).toContain("green again");
      expect(closed.comment).toContain("b497c19");
    }
  });

  // protects=a green night with no issue open does nothing, so a quiet month writes nothing; fails_when=a green night opens an issue; no_claim=none.
  test("a green night with no open issue does nothing", () => {
    expect(plan(night(), null)).toEqual({ action: "none" });
  });

  const fake = (body: string | null) => {
    const calls: string[] = [];
    const hub: Hub = {
      run: async () => ({ run: { date: "", sha: "", url: "" }, jobs: [] }),
      jobLog: async () => null,
      openIssue: async () => (body === null ? null : { number: 7, body }),
      open: async () => void calls.push("open"),
      update: async (number) => void calls.push(`update ${number}`),
      close: async (number, _body, comment) => void calls.push(`close ${number}: ${comment}`),
    };
    return { calls, hub };
  };

  // protects=a red night opens the issue when none is open and updates the open one otherwise, never both; fails_when=a second red night opens a second issue; no_claim=the GitHub calls themselves.
  test("a red night opens or updates, never a second issue", async () => {
    const none = fake(null);
    await apply(night({ red: ["a.spec"] }), none.hub);
    expect(none.calls).toEqual(["open"]);
    const open = fake(bodyOf(plan(night({ red: ["a.spec"] }), null)));
    await apply(night({ date: "2026-11-10", red: ["a.spec"] }), open.hub);
    expect(open.calls).toEqual(["update 7"]);
    const green = fake(bodyOf(plan(night({ red: ["a.spec"] }), null)));
    await apply(night({ date: "2026-11-10" }), green.hub);
    expect(green.calls).toHaveLength(1);
    expect(green.calls[0]).toMatch(/^close 7: Nightly is green again on 2026-11-10/);
  });
});

describe("only the job's own words", () => {
  const rawLog = [
    "2026-11-11T09:59:41.5411875Z ##[notice]  1 failed",
    "    e2e/assistant.spec.ts:44:5 › an Answer is cited, in English and Chinese ",
    "  12 passed (3.1m)",
    "2026-11-11T09:59:41.5415143Z   1) e2e/assistant.spec.ts:44:5 › an Answer is cited, in English and Chinese",
    "2026-11-11T09:59:41.5415914Z     Error: 400 Your credit balance is too low to access the Anthropic API.",
    `2026-11-11T09:59:41.5416311Z     request headers: x-api-key: ${KEY}`,
    "2026-11-11T09:59:41.5417096Z     at /home/runner/work/IncarnaMind/IncarnaMind/e2e/assistant.spec.ts:60:9",
  ].join("\n");

  const run: Run = {
    date: "2026-11-11",
    sha: "b497c191076fdb18bd5d61ff4290b7e0b12f9aa5",
    url: "https://github.com/IncarnaMind/IncarnaMind/actions/runs/1",
  };
  const job = (id: number, name: string, conclusion: string, failedStep?: string): Job => ({
    id,
    name,
    conclusion,
    steps: [
      { name: "Set up job", conclusion: "success" },
      ...(failedStep ? [{ name: failedStep, conclusion: "failure" }] : []),
    ],
  });

  // protects=the issue holds a failing test's name and nothing of its error: no provider message, request header or key; fails_when=a line of the log below the test list, or a key in it, reaches the body; no_claim=that every log is read the same way.
  test("a log's errors and keys stay out of the issue", () => {
    expect(failedTests(rawLog)).toEqual([
      "e2e/assistant.spec.ts › an Answer is cited, in English and Chinese",
    ]);
    const found = nightFromJobs(
      run,
      [job(1, "ci / Smoke tests (1/10, Linux)", "failure", "Run the specs")],
      new Map([[1, rawLog]]),
    );
    const body = bodyOf(plan(found, null));
    expect(body).toContain("an Answer is cited, in English and Chinese");
    expect(body).not.toContain("credit balance");
    expect(body).not.toContain(KEY);
    expect(body).not.toContain("x-api-key");
    expect(body).not.toContain("/home/runner");
  });

  // protects=Playwright's closing list and Vitest's failed tests are read as file and title, from a log with ANSI colour and time stamps, and a flaky or skipped list is not taken as failing; fails_when=a passing test is reported, a failed one is missed, or the line and column are kept in the name; no_claim=none.
  test("reads failed tests from Playwright's list and Vitest's summary", () => {
    const playwright = [
      "2026-11-11T09:59:41.5404890Z ##[warning]e2e/editField.spec.ts took 7.9m",
      "2026-11-11T09:59:41.5411875Z ##[notice]  2 failed",
      "    e2e/home.spec.ts:546:5 › Home beside a Mind follows it as it is saved ",
      "    e2e/palette.spec.ts:212:5 › names, commands and the words in Documents",
      "  1 flaky",
      "    e2e/flaky.spec.ts:9:5 › passes on the retry",
      "  284 passed (21.3m)",
    ].join("\n");
    expect(failedTests(playwright)).toEqual([
      "e2e/home.spec.ts › Home beside a Mind follows it as it is saved",
      "e2e/palette.spec.ts › names, commands and the words in Documents",
    ]);
    const vitest = [
      "2026-11-10T02:50:43.9795018Z \u001b[31m     \u001b[31m×\u001b[31m a ready mark left from before\u001b[39m",
      "2026-11-10T02:53:16.0225175Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m tests/main/runCodePython.test.ts\u001b[2m > \u001b[22mrun_code's own Python\u001b[2m > \u001b[22ma ready mark left from before",
      "2026-11-10T02:53:16.0225176Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m tests/core/broken.test.ts [ tests/core/broken.test.ts ]",
    ].join("\n");
    expect(failedTests(vitest)).toEqual([
      "tests/main/runCodePython.test.ts › run_code's own Python › a ready mark left from before",
      "tests/core/broken.test.ts",
    ]);
  });

  // protects=a failed job whose log names no test is reported by its name and the step that failed, a cancelled job is not measured, and a run where nothing ran is not green; fails_when=a failure that names no test is lost, or an empty run reads as green; no_claim=none.
  test("a job's own name stands in when its log names no test", () => {
    const failed = nightFromJobs(
      run,
      [
        job(1, "ci / Typecheck and lint", "failure", "Run npm run typecheck"),
        job(2, "Packaged app (Windows)", "cancelled"),
        job(3, "Packaged app (Linux)", "success"),
        job(4, "A job still running", ""),
      ],
      new Map(),
    );
    expect(failed.red).toEqual(["ci / Typecheck and lint: Run npm run typecheck"]);
    expect(failed.gaps).toEqual([{ what: "Packaged app (Windows)", why: "the job was cancelled" }]);
    expect(failed.measured).toBe(true);
    const nothing = nightFromJobs(run, [job(5, "ci / Unit tests", "skipped")], new Map());
    expect(nothing.measured).toBe(false);
    expect(nothing.gaps).toEqual([{ what: "The nightly's jobs", why: "none of them ran" }]);
    const named = nightFromJobs(run, [], new Map(), { ci: { result: "failure" } });
    expect(named.red).toEqual(["ci: the job failed"]);
  });

  // protects=the real-model workflow's status is trusted when it speaks, and a job that failed or was cancelled with no word in it is never green; fails_when=a missing or empty status reads as a pass, or a night with no credit reads as red; no_claim=none.
  test("the real-model night follows its status, and never reads green by silence", () => {
    const gap = {
      what: "Live tests on Claude (Anthropic)",
      why: "no key was accepted: the first request got status 400",
    };
    const credit = nightFromStatus(run, "failure", { red: [], gaps: [gap], measured: false });
    expect(credit.red).toEqual([]);
    expect(credit.gaps).toEqual([gap]);
    const silent = nightFromStatus(
      run,
      "failure",
      null,
      job(9, "Real-model checks", "failure", "Run npm ci"),
    );
    expect(silent.red).toEqual(["Real-model checks: Run npm ci"]);
    expect(nightFromStatus(run, "cancelled", null).gaps).toHaveLength(1);
    expect(nightFromStatus(run, "success", null).red).toEqual([
      "Real-model checks: the run wrote no report",
    ]);
    expect(nightFromStatus(run, "success", { red: [], gaps: [], measured: true }).red).toEqual([]);
    expect(nightFromStatus(run, "failure", { red: [], gaps: [], measured: true }).red).toHaveLength(
      1,
    );
  });

  // protects=a status that is not the run's own shape is refused, not guessed at; fails_when=a status with a number where a name belongs is accepted; no_claim=none.
  test("a status is read only when it is whole", () => {
    expect(
      readStatus('{"red":["a"],"gaps":[{"what":"w","why":"y","keeps":"k"}],"measured":true}'),
    ).toEqual({
      red: ["a"],
      gaps: [{ what: "w", why: "y", keeps: "k" }],
      measured: true,
    });
    for (const bad of [
      "",
      "{",
      "[]",
      '{"red":[1],"gaps":[],"measured":true}',
      '{"red":[],"gaps":[{"what":1}],"measured":true}',
      '{"red":[],"gaps":[]}',
    ]) {
      expect(readStatus(bad)).toBeNull();
    }
  });
});

describe("the workflows' report jobs", () => {
  const workflows = ["nightly.yml", "nightly-real-model.yml"].map((file) => ({
    file,
    text: readFileSync(join(__dirname, "..", "..", ".github", "workflows", file), "utf8"),
  }));

  /** The job ids of a workflow file and the text of each job. */
  const jobsOf = (text: string): Map<string, string> => {
    const jobs = new Map<string, string>();
    const after = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length).split("\n");
    let id: string | null = null;
    for (const line of after) {
      const heading = /^ {2}([\w-]+):$/.exec(line);
      if (heading?.[1]) {
        id = heading[1];
        jobs.set(id, "");
      } else if (id) {
        jobs.set(id, `${jobs.get(id)}${line}\n`);
      }
    }
    return jobs;
  };

  // protects=each workflow's last job waits for every other job and runs whatever they end as, but only for the schedule on main; fails_when=a job is added and the report doesn't wait for it, or the report runs for a run by hand, a pull request or another branch; no_claim=none.
  test.each(workflows)(
    "$file ends with a job that waits for every other job and reports only the scheduled night on main",
    ({ text }) => {
      const jobs = jobsOf(text);
      const report = jobs.get("red-night") ?? "";
      expect(report).not.toBe("");
      const needs = /^ {4}needs: \[(.*)\]$/m.exec(report)?.[1]?.split(", ").sort();
      expect(needs).toEqual([...jobs.keys()].filter((id) => id !== "red-night").sort());
      const condition = /^ {4}if: (.*)$/m.exec(report)?.[1] ?? "";
      expect(condition).toContain("always()");
      expect(condition).toContain("github.event_name == 'schedule'");
      expect(condition).toContain("github.ref == 'refs/heads/main'");
      expect(condition).toContain("github.repository == 'IncarnaMind/IncarnaMind'");
    },
  );

  // protects=only each workflow's report job may write, and only issues; it is given no secret but its own token; fails_when=a write permission appears at the workflow or on another job, the report is given a nightly key, or it writes more than issues; no_claim=none.
  test.each(workflows)("$file lets only its report job write, and only issues", ({ text }) => {
    const head = text.slice(0, text.indexOf("\njobs:\n"));
    expect(head).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(head).not.toMatch(/: write/);
    const jobs = jobsOf(text);
    for (const [id, job] of jobs) {
      if (id === "red-night") continue;
      expect(job, id).not.toMatch(/: write/);
    }
    const report = jobs.get("red-night") ?? "";
    expect(report.match(/: write/g)).toEqual([": write"]);
    expect(report).toMatch(/^ {6}issues: write$/m);
    expect(report).not.toContain("secrets.");
    expect(report).toContain("github.token");
  });
});

describe("a saved run, as the script reads it", () => {
  // protects=the script run as the job runs it reads a run's job list and the logs of its failed jobs, and says what it would write; fails_when=the command line, the saved-run reader or the body text no longer fit together; no_claim=GitHub's own API.
  test("a dry run on a job list prints the issue it would open", () => {
    const folder = mkdtempSync(join(tmpdir(), "incarnamind-nightly-"));
    const log = [
      "2026-11-11T09:59:41.5411875Z ##[notice]  1 failed",
      "    e2e/home.spec.ts:546:5 › Home beside a Mind follows it as it is saved ",
      "  12 passed (3.1m)",
    ].join("\n");
    writeFileSync(join(folder, "101.log"), log);
    writeFileSync(
      join(folder, "run.json"),
      JSON.stringify({
        createdAt: "2026-11-11T09:36:55Z",
        headSha: "b497c191076fdb18bd5d61ff4290b7e0b12f9aa5",
        url: "https://github.com/IncarnaMind/IncarnaMind/actions/runs/42996665318",
        jobs: [
          { databaseId: 100, name: "Packaged app (Linux)", conclusion: "success", steps: [] },
          {
            databaseId: 101,
            name: "ci / Smoke tests (4/10, Linux)",
            conclusion: "failure",
            steps: [{ name: "Run the specs", conclusion: "failure" }],
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        join(__dirname, "..", "..", "scripts", "nightlyIssue.ts"),
        "nightly",
        "--dry-run",
        "--run",
        join(folder, "run.json"),
        "--logs",
        folder,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Action: open");
    expect(result.stdout).toContain("## Nightly (red)");
    expect(result.stdout).toContain(
      "| `e2e/home.spec.ts › Home beside a Mind follows it as it is saved` | 2026-11-11 | 2026-11-11 |",
    );
  });
});

describe("the calls to GitHub", () => {
  const TOKEN = "a-made-up-github-token-0000";
  const RAW = "Resource not accessible by integration";

  /** A GitHub that answers the report's calls and notes each one. */
  const github = (
    open: { number: number; title: string; body: string; pull_request?: object }[],
    status = 200,
  ) => {
    const seen: { method: string; path: string; body: unknown; token: string | null }[] = [];
    const ask: typeof fetch = async (input, init) => {
      const path = String(input).replace(
        "https://api.github.com/repos/IncarnaMind/IncarnaMind",
        "",
      );
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      seen.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        token: headers.get("authorization"),
      });
      if (status !== 200) return new Response(JSON.stringify({ message: RAW }), { status });
      if (path === "/actions/runs/9") {
        return Response.json({
          run_started_at: "2026-11-11T09:36:55Z",
          created_at: "2026-11-11T09:30:00Z",
          head_sha: "b497c191076fdb18bd5d61ff4290b7e0b12f9aa5",
          html_url: "https://github.com/IncarnaMind/IncarnaMind/actions/runs/9",
        });
      }
      if (path.startsWith("/actions/runs/9/jobs")) {
        return Response.json({
          jobs: [
            {
              id: 1,
              name: "Real-model checks",
              conclusion: "failure",
              steps: [{ name: "Run the checks", conclusion: "failure" }],
            },
          ],
        });
      }
      if (path.startsWith("/issues?")) return Response.json(open);
      return Response.json({});
    };
    return { seen, hub: githubHub(TOKEN, "IncarnaMind/IncarnaMind", "9", ask) };
  };

  const sentBody = (call: { body: unknown } | undefined): string => {
    const sent = call?.body;
    return typeof sent === "object" && sent !== null && "body" in sent ? String(sent.body) : "";
  };

  const needs = (status: string) => ({ "real-models": { result: "failure", outputs: { status } } });
  const noCredit = JSON.stringify({
    red: [],
    gaps: [
      {
        what: "Live tests on Claude (Anthropic)",
        why: "no key was accepted: the first request got status 400",
      },
    ],
    measured: false,
  });

  // protects=a night with no credit, read from the real-model run's status output, opens the issue titled "Nightly is red" with the two labels, once, with a body that says not measured; fails_when=the title, the labels or the state are wrong, or the issue is opened when one is already open; no_claim=GitHub's side of the calls.
  test("a night with no credit opens the issue once, with its labels", async () => {
    const { seen, hub } = github([{ number: 3, title: "Some other issue", body: "" }]);
    const found = await nightOf("real-models", hub, needs(noCredit), noCredit);
    const done = await apply(found, hub);
    expect(done.plan.action).toBe("open");
    const posts = seen.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe("/issues");
    expect(posts[0]?.body).toMatchObject({
      title: "Nightly is red",
      labels: ["priority:P1", "ready-to-build"],
    });
    const body = sentBody(posts[0]);
    expect(body).toContain("## Nightly real models (not measured)");
    expect(body).toContain("Nothing has been measured since 2026-11-11.");
    expect(body).not.toMatch(/NIGHTLY_[A-Z_]*KEY/);
  });

  // protects=the open issue is found by its exact title among the open issues, and a pull request with that title is not taken for it; fails_when=a second issue is opened beside one that exists, or a pull request is updated as if it were the issue; no_claim=none.
  test("the open issue is updated in place", async () => {
    const earlier = bodyOf(
      plan(
        night({
          workflow: "Nightly real models",
          date: "2026-11-10",
          red: ["Live tests on Claude: x"],
        }),
        null,
      ),
    );
    const { seen, hub } = github([
      { number: 5, title: "Nightly is red", body: earlier, pull_request: {} },
      { number: 7, title: "Nightly is red", body: earlier },
    ]);
    const red = JSON.stringify({ red: ["Live tests on Claude: x"], gaps: [], measured: true });
    await apply(await nightOf("real-models", hub, needs(red), red), hub);
    const writes = seen.filter((call) => call.method !== "GET");
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual(["PATCH /issues/7"]);
    expect(sentBody(writes[0])).toContain(
      "| `Live tests on Claude: x` | 2026-11-10 | 2026-11-11 |",
    );
  });

  // protects=the token goes only in the authorization header, and a refusal from GitHub is reported by its status and call, never by what GitHub said; fails_when=the token or GitHub's message reaches an error or the issue; no_claim=none.
  test("a refusal is reported by status, and the token is never written out", async () => {
    const { seen, hub } = github([], 403);
    const failure = await hub.openIssue().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toBe("GitHub answered 403 to GET /issues?state=open&per_page=100&page=1.");
    expect(message).not.toContain(RAW);
    expect(message).not.toContain(TOKEN);
    expect(seen.every((call) => call.token === `Bearer ${TOKEN}`)).toBe(true);
  });
});
