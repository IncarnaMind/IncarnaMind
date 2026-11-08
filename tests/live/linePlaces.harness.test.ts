/**
 * The line-places harness's own logic, with no model and no key: the settings it checks before any
 * job, the failure it records for an Answer or an edit that failed, and the report it saves as each
 * job finishes. Each gap of #2643 has its test here.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { PLACE_CASES, type PlaceCase } from "./linePlaces.cases";
import {
  answerFailure,
  editFailure,
  liveSettings,
  placeJobs,
  ReportFile,
  recordRun,
  runLiveJobs,
} from "./linePlaces.harness";

const caseOf = (id: string): PlaceCase => {
  const found = PLACE_CASES.find((one) => one.id === id);
  if (!found) throw new Error(`No case ${id}.`);
  return found;
};

const reportFile = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), "line-places-harness-"));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  return join(folder, "report.jsonl");
};

/** The whole lines of a report a run may still be writing its last line to. */
const wholeLines = (text: string): string[] =>
  text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line !== "");

describe("a failed Answer is counted apart from the lines kept and lost", () => {
  test("a provider error keeps its kind and message", () => {
    expect(
      answerFailure({ status: "failed", errorKind: "network", errorMessage: "socket closed" }),
    ).toEqual({ kind: "network", message: "socket closed" });
  });

  test("a stopped Answer is a failure too", () => {
    expect(answerFailure({ status: "stopped", errorKind: null, errorMessage: null })).toEqual({
      kind: "stopped",
      message: "the Answer was stopped",
    });
  });

  test("an Answer that finished is no failure", () => {
    expect(answerFailure({ status: "done", errorKind: null, errorMessage: null })).toBeNull();
  });

  test("an edit the provider failed keeps its kind and message", () => {
    expect(
      editFailure({ kind: "failed", error: { kind: "rate-limit", message: "slow down" } }),
    ).toEqual({ kind: "rate-limit", message: "slow down" });
  });

  test("an edit that finished is no failure", () => {
    expect(editFailure({ kind: "unchanged" })).toBeNull();
  });

  test("an edit nothing was sent for is a failure", () => {
    expect(editFailure({ kind: "local-mode" })).toEqual({
      kind: "local-mode",
      message: "nothing was sent to the model",
    });
    expect(
      editFailure({ kind: "not-ready", readiness: { ready: false, reason: "no-provider" } }),
    ).toEqual({ kind: "not-ready", message: "nothing was sent to the model" });
  });

  test("an edit the model made but the code refused is no failure", () => {
    expect(editFailure({ kind: "unplaced", quotes: ["gone"] })).toBeNull();
  });

  test("a failed run leaves its row with the failure and no made or lost lines", () => {
    const row: Record<string, unknown> = {};
    recordRun(row, caseOf("en-15"), { kind: "network", message: "socket closed" }, () => {
      throw new Error("a failed run reads no Note");
    });
    expect(row).toEqual({ failed: { kind: "network", message: "socket closed" } });
    expect(row).not.toHaveProperty("made");
    expect(row).not.toHaveProperty("lost");
  });

  test("a run that finished gets its Note and its made and lost lines", () => {
    const row: Record<string, unknown> = {};
    const remove = caseOf("en-15");
    const after = [remove.note[0] as string, remove.note[2] as string];
    recordRun(row, remove, null, () => after);
    expect(row).toEqual({ after, lost: [], made: true });
  });
});

describe("the settings are checked before any job starts", () => {
  test("a run with none set takes 2 runs, 4 at once and no filter", () => {
    expect(liveSettings({})).toEqual({
      runs: 2,
      concurrency: 4,
      arm: "unnamed",
      only: undefined,
      report: undefined,
    });
  });

  test.each(["0", "-1", "1.5", "two", ""])("a run count of %j fails at once", (value) => {
    expect(() => liveSettings({ INCARNAMIND_LIVE_RUNS: value })).toThrow(/INCARNAMIND_LIVE_RUNS/);
  });

  test.each(["0", "-2", "2.5", "many", ""])("a concurrency of %j fails at once", (value) => {
    expect(() => liveSettings({ INCARNAMIND_LIVE_CONCURRENCY: value })).toThrow(
      /INCARNAMIND_LIVE_CONCURRENCY/,
    );
  });

  test("the case filter's ids are trimmed", () => {
    expect(liveSettings({ INCARNAMIND_LIVE_ONLY: " en-14 , zh-14 " }).only).toEqual([
      "en-14",
      "zh-14",
    ]);
  });

  test("an unknown case id fails before any job", () => {
    expect(() => placeJobs(["en-14", "en-99"], 2)).toThrow(/en-99/);
  });

  test("a filter that leaves no jobs fails", () => {
    expect(() => placeJobs([], 2)).toThrow(/no jobs/i);
  });

  test("a filter of only empty ids leaves no jobs, which fails", () => {
    expect(liveSettings({ INCARNAMIND_LIVE_ONLY: " , " }).only).toEqual([]);
    expect(() => placeJobs([], 2)).toThrow(/no jobs/i);
  });

  test("the trimmed filter runs its cases on both paths, the runs asked", () => {
    const settings = liveSettings({
      INCARNAMIND_LIVE_ONLY: "en-14, zh-14",
      INCARNAMIND_LIVE_RUNS: "1",
    });
    expect(
      placeJobs(settings.only, settings.runs).map(
        ({ each, path, run }) => `${each.id}/${path}/${run}`,
      ),
    ).toEqual([
      "en-14/editWithAi/1",
      "en-14/assistant/1",
      "zh-14/editWithAi/1",
      "zh-14/assistant/1",
    ]);
  });

  test("no filter runs every case on both paths, twice", () => {
    expect(placeJobs(undefined, 2)).toHaveLength(160);
  });
});

describe("each row is saved as its job finishes", () => {
  test("a row is on the report before its worker starts the next job", async () => {
    const file = await reportFile();
    const seen: string[] = [];
    const jobs = [0, 1, 2];
    await runLiveJobs(
      jobs,
      1,
      async () => ({
        async run(job) {
          seen.push(await readFile(file, "utf8").catch(() => ""));
          return { job };
        },
        spend: () => [],
        close: () => {},
      }),
      new ReportFile(file),
      { arm: "test", model: "scripted" },
    );
    expect(seen).toEqual(["", '{"job":0}\n', '{"job":0}\n{"job":1}\n']);
  });

  test("a worker that fails keeps the rows already paid for, with the spend so far", async () => {
    const file = await reportFile();
    const jobs = [0, 1, 2, 3];
    await expect(
      runLiveJobs(
        jobs,
        1,
        async () => ({
          async run(job) {
            if (job === 1) throw new Error("provider dropped");
            return { job };
          },
          spend: () => ["  deepseek-flash: 1 request, 0.0100 USD"],
          close: () => {},
        }),
        new ReportFile(file),
        { arm: "test", model: "scripted" },
      ),
    ).rejects.toThrow("provider dropped");
    const lines = (await readFile(file, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { job: 0 },
      {
        arm: "test",
        model: "scripted",
        jobs: 4,
        spent: ["  deepseek-flash: 1 request, 0.0100 USD"],
      },
    ]);
  });

  test("concurrent jobs keep one whole row a line, saved as each finishes", async () => {
    const file = await reportFile();
    const jobs = Array.from({ length: 40 }, (_, index) => index);
    const seen: string[] = [];
    await runLiveJobs(
      jobs,
      4,
      async () => ({
        async run(job) {
          seen.push(await readFile(file, "utf8").catch(() => ""));
          return { job, reply: "x".repeat(2_000) };
        },
        spend: () => [],
        close: () => {},
      }),
      new ReportFile(file),
      { arm: "test", model: "scripted" },
    );
    expect(seen.some((text) => wholeLines(text).length > 0)).toBe(true);
    for (const text of seen)
      for (const line of wholeLines(text)) expect(() => JSON.parse(line)).not.toThrow();
    const lines = wholeLines(await readFile(file, "utf8"));
    expect(lines).toHaveLength(41);
    const rows = lines
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { job: number; reply: string });
    expect(rows.map((row) => row.job).sort((one, other) => one - other)).toEqual(jobs);
    expect(rows.every((row) => row.reply.length === 2_000)).toBe(true);
    expect(JSON.parse(lines[40] as string)).toEqual({
      arm: "test",
      model: "scripted",
      jobs: 40,
      spent: [],
    });
  });
});
